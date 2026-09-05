// Antigravity / Antigravity IDE 数据源公共工厂
// 用量权威来源：%APPDATA%/<Antigravity|Antigravity IDE>/User/globalStorage/state.vscdb
//   ItemTable 键 antigravityUnifiedStateSync.userStatus（应用从云端缓存的状态，软件未运行也可读）
// 编码链：base64 → protobuf map entry{f1=key, f2=内层 base64} → base64 解码 → GetUserStatusResponse
// 口径：官方不提供 token 账单，本地唯一用量信号是「模型配额剩余比例（0~1 float）+ 重置时间戳」。
//   记账规则（与 ZCode 精神对齐：本地文件只读 + 差值入账，原子单位是配额池而非模型）：
//   - 同池同周期（resetAt 不变）：消耗 = 上次剩余 - 本次剩余；
//   - 池首次出现或周期重置（resetAt 变化）：记当前累计 (1-剩余)×100（对应 ZCode 首次同步的全量导入）；
//   - 剩余回升（换账号/补发额度）不计消耗，仅更新快照；
//   - 同一配额池（remaining/resetAt 完全相同的模型，如 Gemini 全系共享一池）合并为一条记录，
//     池名取模型名公共前缀；跨期按「池成员交集」匹配而非池名，池拆分/合并时总量依然正确；
//   - 单位为「配额百分比点」（消耗 3.13% 记 3.13），保留两位小数。
// 设备标识：~/.gemini/<homeSub>/antigravity_state.pbtxt 的 installation_uuid。
// 优雅降级：文件缺失、数据库被占用、结构无法解析（旧版格式）时返回空记录并写日志，不影响其他源。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const db = require("./db.cjs");

const STATUS_KEY = "antigravityUnifiedStateSync.userStatus";
// 配额重置时间戳量级（unix 秒 ≈ 1.7e9），用于在未知字段号的 protobuf 中识别「重置时间」子消息
const RESET_TS_MIN = 1e9;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ---------- 极简 protobuf 解码（仅覆盖本数据源用到的 wire type，无第三方依赖） ----------

function readVarint(buf, i) {
  let v = 0n;
  let shift = 0n;
  while (true) {
    if (i >= buf.length) throw new Error("varint 越界");
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [Number(v), i];
    shift += 7n;
    if (shift > 63n) throw new Error("varint 过长");
  }
}

/** 解析一段 protobuf 为字段列表；结构非法时抛错 */
function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = readVarint(buf, i);
    const field = tag >> 3;
    const wt = tag & 7;
    if (field === 0) throw new Error("非法字段号");
    if (wt === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      out.push({ field, wt, varint: v });
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error("double 越界");
      out.push({ field, wt, dbl: buf.readDoubleLE(i) });
      i += 8;
    } else if (wt === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      if (i + len > buf.length) throw new Error("长度越界");
      out.push({ field, wt, data: buf.slice(i, i + len) });
      i += len;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error("float 越界");
      out.push({ field, wt, flt: buf.readFloatLE(i) });
      i += 4;
    } else {
      throw new Error(`不支持的 wire type ${wt}`);
    }
  }
  return out;
}

function printable(buf) {
  if (buf.length === 0) return null;
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return null;
  }
  return buf.toString("utf8");
}

/**
 * 解码 state.vscdb 中 userStatus 的原始值 → GetUserStatusResponse Buffer。
 * 链路：外层 base64 →（可能多层包裹的）map entry{f1="xxxSentinelKey", f2=内层 base64 文本} → base64 解码。
 * 不依赖固定嵌套层数，逐层下钻寻找 SentinelKey 键值对。
 */
function decodeUserStatus(rawValue) {
  const outerBuf = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(String(rawValue), "base64");
  if (outerBuf.length === 0) return null;

  function findSentinelValue(buf, depth) {
    let fields;
    try {
      fields = parseFields(buf);
    } catch {
      return null;
    }
    const keyF = fields.find((e) => e.field === 1 && e.wt === 2);
    const valF = fields.find((e) => e.field === 2 && e.wt === 2);
    if (keyF && valF) {
      const key = printable(keyF.data);
      if (key && /SentinelKey$/.test(key)) return valF.data;
    }
    if (depth > 4) return null;
    for (const f of fields) {
      if (f.wt !== 2 || !f.data || f.data.length === 0) continue;
      if (printable(f.data)) continue; // 纯文本串不含嵌套
      const found = findSentinelValue(f.data, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const value = findSentinelValue(outerBuf, 0);
  if (!value) return null;
  // value 内层仍是 base64 文本（键值同步通道的二次封装）；个别版本可能直接是 protobuf
  let inner = null;
  const fields = parseFields(value);
  const textF = fields.find((e) => e.wt === 2 && printable(e.data));
  if (textF) inner = Buffer.from(printable(textF.data), "base64");
  if (!inner || inner.length === 0) inner = value;
  return inner;
}

/** 判断一个子消息是否为「模型条目」：含可读名称(f1) + 配额子消息(f1∈[0,1] 的浮点 且 f2 内有重置时间戳) */
function matchModelEntry(fields) {
  const nameF = fields.find((e) => e.field === 1 && e.wt === 2);
  if (!nameF) return null;
  const name = printable(nameF.data);
  if (!name || name.length < 2 || name.length > 120) return null;

  for (const q of fields) {
    if (q.wt !== 2 || q.data.length === 0 || q.data.length > 64) continue;
    let sub;
    try {
      sub = parseFields(q.data);
    } catch {
      continue;
    }
    const remainF = sub.find((e) => (e.wt === 5 || e.wt === 1) && e.flt !== undefined);
    const remain = remainF ? (remainF.wt === 5 ? remainF.flt : remainF.dbl) : null;
    if (remain === null || !(remain >= 0 && remain <= 1)) continue;
    const resetF = sub.find((e) => e.field === 2 && e.wt === 2);
    if (!resetF) continue;
    let resetSub;
    try {
      resetSub = parseFields(resetF.data);
    } catch {
      continue;
    }
    const ts = resetSub.find((e) => e.wt === 0 && e.varint >= RESET_TS_MIN);
    if (!ts) continue;
    return { name, remaining: remain, resetAt: ts.varint };
  }
  return null;
}

/** 深度搜索响应中的全部模型条目（不依赖固定字段号，兼容版本间字段变动），按名称去重 */
function findModelEntries(buf, depth = 0) {
  if (depth > 8) return [];
  let fields;
  try {
    fields = parseFields(buf);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const hit = matchModelEntry(fields);
  if (hit) {
    out.push(hit);
    seen.add(hit.name);
  }
  for (const f of fields) {
    if (f.wt !== 2 || !f.data || f.data.length === 0) continue;
    // 可读文本串不必下钻
    if (printable(f.data)) continue;
    for (const m of findModelEntries(f.data, depth + 1)) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        out.push(m);
      }
    }
  }
  return out;
}

// ---------- 配额池命名 ----------

/** 去掉模型名尾部的高中低档括号后缀，如 "Gemini 3.6 Flash (High)" → "Gemini 3.6 Flash" */
function stripModifier(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** 同池模型的展示名：单模型取去档位名；多模型取公共前缀（截到词边界），过短则取首词去重拼接 */
function poolLabel(names) {
  const stripped = names.map(stripModifier).filter(Boolean);
  if (stripped.length === 0) return "未知模型";
  if (stripped.length === 1) return stripped[0];
  let prefix = stripped[0];
  for (const s of stripped.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  prefix = prefix.trim();
  if (prefix.length >= 2) {
    const cut = prefix.lastIndexOf(" ");
    return cut > 0 ? prefix.slice(0, cut) : prefix;
  }
  const firsts = [...new Set(stripped.map((s) => s.split(/\s+/)[0]))];
  return firsts.join("+") || "未知模型";
}

// ---------- 配额池划分与记账 ----------
// 配额消耗的原子单位是「池」：同池模型 remaining/resetAt 完全相同（如 Gemini 全系共享一池），
// 池内 N 个模型只代表一份消耗。因此快照与差值均按池记录，禁止按模型求和（会成倍重复计数）。

/** 把模型列表按 (remaining, resetAt) 划分为配额池 */
function groupPools(models) {
  const map = new Map(); // key: quant(remaining)|resetAt → { names, remaining, resetAt }
  for (const m of models) {
    const key = `${round4(m.remaining)}|${m.resetAt}`;
    if (!map.has(key)) map.set(key, { names: [], remaining: round4(m.remaining), resetAt: m.resetAt });
    map.get(key).names.push(m.name);
  }
  return [...map.values()].map((g) => ({
    label: poolLabel(g.names),
    remaining: g.remaining,
    resetAt: g.resetAt,
    members: g.names,
  }));
}

/**
 * 池级差值记账：
 * - 与上次快照按「池成员有交集且 resetAt 相同」匹配（标签可能随池拆合变化，不能按标签匹配）；
 *   命中：消耗 = Σ max(0, 上次剩余 - 本次剩余)。池拆分/合并时对多边分别求和，总量依然正确。
 * - 未命中（模型家族首次出现 / 换周期 resetAt 变化 / 换账号）：记当前累计 (1-剩余)×100，
 *   对齐 ZCode「首次同步全量导入」的语义；剩余回升（补额度）自然得 0，不记。
 * @returns [{ label, points }] 仅含 points > 0 的池
 */
function computePoolConsumption(prevPools, pools) {
  const out = [];
  for (const c of pools) {
    const matched = (Array.isArray(prevPools) ? prevPools : []).filter(
      (p) => p && p.resetAt === c.resetAt && Array.isArray(p.members) && p.members.some((n) => c.members.includes(n))
    );
    let delta = 0;
    if (matched.length === 0) {
      delta = 1 - c.remaining;
    } else {
      for (const p of matched) delta += Math.max(0, p.remaining - c.remaining);
    }
    const points = round2(delta * 100);
    if (points > 0) out.push({ label: c.label, points });
  }
  return out;
}

// ---------- state.vscdb 读取（含占用时的临时副本回退） ----------

function openReadOnly(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    // 应用正在运行等场景可能锁库：复制到临时目录再读
    const tmp = path.join(os.tmpdir(), `dosage-sync-ag-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const base = path.basename(file);
    for (const ext of ["", "-wal", "-shm"]) {
      const src = file + ext;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, base + ext));
    }
    // 副本目录须等连接用完才能删，挂到进程退出时清理（清理失败留残留在系统临时目录，无害）
    const conn = new DatabaseSync(path.join(tmp, base), { readOnly: true });
    process.once("exit", () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    });
    return conn;
  }
}

function readUserStatusRaw(file) {
  let conn;
  try {
    conn = openReadOnly(file);
    const row = conn.prepare("SELECT value FROM ItemTable WHERE key = ?").get(STATUS_KEY);
    return row ? row.value : null;
  } finally {
    if (conn) {
      try {
        conn.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }
}

// ---------- 适配器工厂 ----------

/**
 * @param id 源 id（antigravity / antigravity-ide）
 * @param name 显示名
 * @param homeSub ~/.gemini 下的子目录名（取 installation_uuid 用）
 * @param appDataName %APPDATA% 下的应用目录名（state.vscdb 所在）
 */
function makeAdapter(id, name, homeSub, appDataName) {
  const snapshotKey = `snapshot:${id}`;

  function detect() {
    const roaming = process.env.APPDATA ? path.join(process.env.APPDATA, appDataName) : null;
    if (roaming && fs.existsSync(path.join(roaming, "User", "globalStorage", "state.vscdb"))) return roaming;
    return null;
  }

  function validate(dir) {
    return !!dir && fs.existsSync(path.join(dir, "User", "globalStorage", "state.vscdb"));
  }

  /** 设备标识：installation_uuid（同一安装多账号共享，符合「设备」语义）；取不到返回 null 走统一回退链 */
  function getDeviceId() {
    const file = path.join(homeDir(), ".gemini", homeSub, "antigravity_state.pbtxt");
    try {
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/installation_uuid:\s*"([0-9a-fA-F-]{8,})"/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /** 快照差值抽取；任何失败都降级为空记录（旧版格式解析失败同样走这里） */
  function extract(dir, deviceId, deviceName) {
    const file = path.join(dir, "User", "globalStorage", "state.vscdb");
    if (!fs.existsSync(file)) {
      db.addLog("extract", "info", `未找到 ${name} 的 state.vscdb，跳过`);
      return [];
    }

    let entries;
    try {
      const raw = readUserStatusRaw(file);
      if (!raw) {
        db.addLog("extract", "info", `${name} 尚无配额状态缓存（应用未登录或未联网同步过），跳过`);
        return [];
      }
      const resp = decodeUserStatus(raw);
      entries = resp ? findModelEntries(resp) : [];
    } catch (e) {
      db.addLog("extract", "warn", `${name} 配额状态读取失败，已跳过`, e.message);
      return [];
    }
    if (entries.length === 0) {
      db.addLog("extract", "info", `${name} 配额结构无法解析（可能是旧版格式），已优雅跳过`);
      return [];
    }

    const now = Date.now();

    let prev = null;
    try {
      const rawPrev = db.getMeta(snapshotKey);
      if (rawPrev) prev = JSON.parse(rawPrev);
    } catch {
      prev = null;
    }

    const models = entries.map((m) => ({ name: m.name, remaining: round4(m.remaining), resetAt: m.resetAt }));
    const pools = groupPools(models);
    db.setMeta(snapshotKey, JSON.stringify({ at: now, pools }));

    const consumptions = computePoolConsumption(prev ? prev.pools : null, pools);

    const out = [];
    for (const pool of consumptions) {
      out.push({
        id: `${deviceId}:${id}:${now}:${pool.label}`,
        deviceId,
        deviceName,
        source: id,
        providerId: "Google",
        modelId: pool.label,
        // 单位为配额百分比点（1 = 消耗 1% 配额），非 token
        inputTokens: pool.points,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        startedAt: now,
        completedAt: now,
        status: "success",
      });
    }

    if (out.length > 0) {
      const total = out.reduce((s, r) => s + r.inputTokens, 0);
      db.addLog("extract", "info", `${name} 配额差值：本次消耗 ${total} 点（${out.length} 个配额池）`);
    } else {
      db.addLog("extract", "info", `${name} 配额无新增消耗（${pools.length} 个配额池）`);
    }
    return out;
  }

  return { id, name, detect, validate, getDeviceId, extract };
}

module.exports = {
  makeAdapter,
  decodeUserStatus,
  findModelEntries,
  groupPools,
  poolLabel,
  stripModifier,
  computePoolConsumption,
};
