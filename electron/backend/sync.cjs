// 4 阶段同步引擎：抽取 → 上传 → 拉取 → 合并
// WebDAV 布局：usage-tracker/devices/<deviceId>.json（设备元数据）
//             usage-tracker/data/<deviceId>/<YYYY-MM-DD>.jsonl.gz（UTC 日分片，gzip 压缩）
// 幂等：本地按 id 去重（INSERT OR REPLACE），远端按文件名 + 内容整体覆盖写
"use strict";
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const db = require("./db.cjs");
const adapter = require("./adapter.cjs");
const webdav = require("./webdav.cjs");
const billing = require("./billing.cjs");

// 重扫窗口：仅补抽最近 24h 的记录，避免每次全量
const RESCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

// 本进程启动标识：随每次启动重新生成（不持久化），用于探测「同一设备 ID 被多台电脑使用」的克隆场景
const BOOT_ID = crypto.randomUUID();

const DEVICES_DIR = "usage-tracker/devices";
const DATA_DIR = "usage-tracker/data";

const STAGE_LABEL = {
  idle: "空闲",
  extract: "抽取",
  upload: "上传",
  download: "拉取",
  merge: "合并",
  done: "完成",
  cancelled: "已取消",
  error: "失败",
};

let state = {
  running: false,
  cancelled: false,
  stage: "idle",
  percent: 0,
  message: "",
  lastSyncAt: null,
};

// 同步结束/失败回调（由 main.cjs 注入，用于发系统通知）
let onFinish = null;

function emit(partial) {
  Object.assign(state, partial);
}

function setOnFinish(fn) {
  onFinish = fn;
}

function log(kind, level, message, detail) {
  db.addLog(kind, level, message, detail || "");
}

/** 确保本机 deviceId 存在：按 zcode → codex → dsh 回退，否则生成 UUID */
function ensureLocalDeviceId(cfg = null) {
  let id = db.getLocalDeviceId();
  if (id) return id;
  for (const src of adapter.sources) {
    const sourceCfg = (cfg?.sources || []).find((item) => item.source === src.id);
    const dir = sourceCfg?.dataDir || src.detect();
    if (!dir) continue;
    const detected = src.getDeviceId(dir);
    if (detected) {
      id = detected;
      break;
    }
  }
  if (!id) id = crypto.randomUUID();
  db.setLocalDeviceId(id);
  return id;
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

/** 编码日分片：JSONL 文本 → gzip 压缩字节（传输体积更小） */
function encodeShard(records) {
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  return zlib.gzipSync(Buffer.from(lines, "utf8"));
}

/** 解码日分片：兼容 gzip 与旧版纯文本 JSONL */
function decodeShard(buf, name) {
  if (!buf || buf.length === 0) return [];
  let text;
  if (name.endsWith(".gz")) {
    try {
      text = zlib.gunzipSync(buf).toString("utf8");
    } catch {
      text = buf.toString("utf8"); // 损坏 gzip 退化为文本
    }
  } else {
    text = buf.toString("utf8");
  }
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* 损坏行跳过，不影响其余分片合并 */
    }
  }
  return recs;
}

function sourceEnabled(cfg, id) {
  const s = (cfg.sources || []).find((x) => x.source === id);
  return !!s && s.enabled;
}

function enabledSourceIds(cfg) {
  return adapter.sources.filter((src) => sourceEnabled(cfg, src.id)).map((src) => src.id);
}

function webdavReady(cfg) {
  return !!(cfg.webdav && cfg.webdav.endpoint);
}

async function ensureRoots(wd) {
  await webdav.ensureDir(webdav.joinUrl(wd.endpoint, wd.root, `${DEVICES_DIR}`), wd);
  await webdav.ensureDir(webdav.joinUrl(wd.endpoint, wd.root, `${DATA_DIR}`), wd);
}

async function run(cfg) {
  if (state.running) throw new Error("同步正在进行中");
  state = { running: true, cancelled: false, stage: "extract", percent: 0, message: "准备抽取", lastSyncAt: state.lastSyncAt || null };

  try {
    const deviceId = ensureLocalDeviceId(cfg);
    const deviceName = cfg.deviceName || "这台电脑";
    const activeSources = enabledSourceIds(cfg);
    const deviceSources = activeSources.join(",");

    // 1. 抽取
    emit({ stage: "extract", percent: 5, message: "正在抽取本地用量…" });
    log("extract", "info", "开始获取本地数据");
    if (activeSources.length === 0) log("extract", "info", "没有启用的数据源，跳过抽取");
    for (let sourceIndex = 0; sourceIndex < activeSources.length; sourceIndex++) {
      const sourceId = activeSources[sourceIndex];
      const src = adapter.byId(sourceId);
      const sourceCfg = (cfg.sources || []).find((item) => item.source === sourceId);
      if (!src) continue;
      emit({
        percent: 5 + Math.floor((sourceIndex / Math.max(activeSources.length, 1)) * 20),
        message: `正在抽取 ${src.name} 用量…`,
      });
      // 单源失败只跳过该源：库损坏/被占用等问题不应中断其余源与后续上传下载
      try {
        const dir = sourceCfg?.dataDir || src.detect();
        if (!dir || !src.validate(dir)) {
          log("extract", "info", `未检测到 ${src.name} 数据，跳过抽取`);
        } else {
          const anchor = db.getAnchor(sourceId);
          // 首次同步（锚点=0）：全量抽取；之后：回扫最近 RESCAN_WINDOW 窗口，
          // 覆盖源端后续更新（如回填 token）的旧记录。
          const sinceMs = anchor > 0 ? anchor - RESCAN_WINDOW_MS : 0;
          // await 兼容同步返回值的适配器（Antigravity 系为异步配额快照）
          const records = await src.extract(dir, deviceId, deviceName, sinceMs);
          db.insertRecords(records);
          // 适配器可选的落库后回调（Antigravity 快照在记录确认入库后才推进，失败不丢消耗）
          if (typeof records.onInserted === "function") records.onInserted();
          // 锚点单调不回退：回扫窗口内无新记录时保持原锚点，避免每次倒退 24h
          let maxTs = anchor;
          for (const r of records) maxTs = Math.max(maxTs, r.startedAt);
          db.setAnchor(sourceId, maxTs);
          log("extract", "info", `${src.name} 获取完成：${records.length} 条记录（since=${sinceMs}）`);
        }
      } catch (e) {
        log("extract", "error", `${src.name} 抽取失败，已跳过该源继续同步`, e.message);
      }
    }

    if (state.cancelled) return finish("cancelled");

    // 2. 上传
    emit({ stage: "upload", percent: 30, message: "正在上传…" });
    log("upload", "info", "开始上传到 WebDAV");
    if (webdavReady(cfg)) {
      log("upload", "info", `WebDAV 上传目标：${cfg.webdav.endpoint}${cfg.webdav.root || ""}`);
      log("upload", "info", "创建 WebDAV 业务目录");
      await ensureRoots(cfg.webdav);
      // 价格表多设备同步（LWW）：远端新则替换本地，本地新则上传；失败仅记日志，不阻断数据同步
      try {
        const priceAction = await billing.syncPrices(cfg.webdav, deviceName);
        if (priceAction.action === "downloaded") {
          log("merge", "info", `价格表已更新（${priceAction.count} 条，来自「${priceAction.remoteBy}」），费用按新价格重算`);
        } else if (priceAction.action === "uploaded" || priceAction.action === "created") {
          log("upload", "info", "价格表已上传到 WebDAV（多设备共享）");
        }
      } catch (e) {
        log("upload", "warn", "价格表同步失败（不影响数据同步）", e.message);
      }
      // 远程价格源自动拉取（来源 remote）：按配置间隔检查，拉取失败仅记日志
      try {
        const rp = cfg.billing && cfg.billing.remotePricing;
        if (rp && rp.enabled && rp.url) {
          const intervalMs = Math.max(1, Number(rp.intervalHours) || 24) * 3600000;
          const lastAt = Number(db.getMeta("remote_pricing_at") || 0);
          if (Date.now() - lastAt > intervalMs) {
            const r = await billing.pullRemotePricing({ ...rp, proxy: cfg.billing.importProxy || "" });
            if (r.action === "updated") {
              log("merge", "info", `远程价格源已更新：新增 ${r.added} · 调价 ${r.updated} · 未变 ${r.skipped}（本地 ${r.models} 个模型命中）`);
            }
          }
        }
      } catch (e) {
        log("upload", "warn", "远程价格源拉取失败（不影响数据同步，下轮重试）", e.message);
      }
      // 设备元数据。上传前做设备 ID 碰撞探测：远端设备文件的写入实例既不是本次进程、
      // 也不是本机上次上传的进程时，说明同一设备 ID 有多台电脑在写（克隆/复制数据目录），
      // 双方日分片会互相覆盖——写 warn 日志告警但不阻断同步。
      const devFileUrl = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/${deviceId}.json`);
      let remoteMeta = null;
      try {
        const remoteText = await webdav.getText(devFileUrl, cfg.webdav);
        remoteMeta = remoteText ? JSON.parse(remoteText) : null;
      } catch {
        remoteMeta = null; // 读取/解析失败不影响后续上传
      }
      if (remoteMeta && typeof remoteMeta.bootId === "string"
        && remoteMeta.bootId !== BOOT_ID && remoteMeta.bootId !== db.getMeta("uploaded_boot")) {
        log("upload", "warn", `设备 ID ${deviceId} 疑似被多台电脑同时使用，双方日分片会互相覆盖；` +
          `若你最近迁移/复制过本工具数据目录，本条告警可忽略`, `远端实例标识：${remoteMeta.bootId.slice(0, 8)}…`);
      }
      const devMeta = { deviceId, deviceName, source: deviceSources, lastSyncAt: Date.now(), bootId: BOOT_ID };
      await webdav.put(devFileUrl, cfg.webdav, JSON.stringify(devMeta));
      db.setMeta("uploaded_boot", BOOT_ID);
      log("upload", "info", "设备信息上传完成");
      // 上传本地数据分片（按 deviceId 过滤），每个天分片以本机该天【全部】记录整体覆盖写（PUT 覆盖语义，幂等）。
      // 全量上传天然实现「离线队列自动补传」：只要本地库有数据，配置 WebDAV 后即补传。
      // 增量优化：分片内容 hash 记账存 meta 表（与数据同库，删库自动回到全量），
      // 内容未变化的分片跳过 PUT；全部分片处理完后写 manifest.json（分片名 → hash），
      // 供其他设备做增量拉取判断。manifest 必须在分片全部 PUT 成功后写，保证「manifest 声明 = 远端实存」。
      // 记账键绑定远端地址（endpoint+root）：切换 WebDAV 根目录/地址后旧记账不适用，
      // 自动触发全量补传到新远端（旧键留存为少量垃圾记录，无害）。
      const uploadPrefix = `uploaded:${cfg.webdav.endpoint}${cfg.webdav.root || ""}:`;
      const days = db.getRecordDays(deviceId);
      await webdav.ensureDir(webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}`), cfg.webdav);
      const manifest = {};
      let uploadedCount = 0;
      for (let i = 0; i < days.length; i++) {
        const day = days[i];
        if (state.cancelled) return finish("cancelled");
        const dayRecs = db.getRecordsByDay(deviceId, day);
        const fileName = `${day}.jsonl.gz`;
        const payload = encodeShard(dayRecs);
        const hash = sha1(payload);
        manifest[fileName] = hash;
        const uploadedKey = `${uploadPrefix}${fileName}`;
        if (db.getMeta(uploadedKey) !== hash) {
          // 全量场景（首次/换根/清缓存）分片可达数百个，逐条日志会淹没其他记录，只在少量时逐条
          if (days.length <= 20) log("upload", "info", `上传日分片 ${day}：${dayRecs.length} 条记录`);
          await webdav.put(
            webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/${fileName}`),
            cfg.webdav,
            payload
          );
          db.setMeta(uploadedKey, hash);
          uploadedCount++;
        }
        emit({ percent: 30 + Math.floor(((i + 1) / Math.max(days.length, 1)) * 20) });
      }
      await webdav.put(
        webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/manifest.json`),
        cfg.webdav,
        JSON.stringify({ v: 1, shards: manifest })
      );
      log("upload", "info", `分片上传完成：${uploadedCount}/${days.length} 个有变化（其余内容未变化已跳过）`);
    } else {
      log("upload", "info", "未配置 WebDAV，跳过上传");
    }

    if (state.cancelled) return finish("cancelled");

    // 3. 拉取
    emit({ stage: "download", percent: 55, message: "正在拉取其他设备…" });
    log("download", "info", "开始拉取远端数据");
    if (webdavReady(cfg)) {
      const devDir = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/`);
      const devList = await webdav.list(devDir, cfg.webdav);
      const deviceFiles = devList
        .filter((e) => !e.isDir && e.name.endsWith(".json"))
        .map((e) => e.name.replace(/\.json$/, ""));

      // 先枚举所有待拉分片，用于细分拉取进度。
      // 增量拉取：优先读对方 manifest.json（分片名 → 内容 hash），
      // 本地已按相同内容合并过的分片直接跳过；对方无 manifest（旧版客户端）时
      // 回退为目录全量遍历，下载后同样计算 hash 记账，对方升级后即可无缝衔接。
      const pending = [];
      for (const other of deviceFiles) {
        if (other === deviceId) continue;
        const dataBase = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}`);
        let manifest = null;
        try {
          const manifestText = await webdav.getText(`${dataBase}/manifest.json`, cfg.webdav);
          manifest = manifestText ? JSON.parse(manifestText) : null;
        } catch {
          manifest = null; // manifest 缺失/损坏时按旧版全量遍历处理
        }
        if (manifest && manifest.shards && typeof manifest.shards === "object") {
          for (const [fileName, hash] of Object.entries(manifest.shards)) {
            if (typeof hash !== "string") continue;
            if (db.getMeta(`merged:${other}:${fileName}`) === hash) continue;
            pending.push({ other, name: fileName, url: `${dataBase}/${fileName}`, hash });
          }
        } else {
          const files = await webdav.list(`${dataBase}/`, cfg.webdav);
          for (const f of files) {
            if (f.isDir || !/\.jsonl(\.gz)?$/.test(f.name)) continue;
            pending.push({
              other,
              name: f.name,
              url: webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}/${f.name}`),
              hash: null,
            });
          }
        }
      }

      let merged = 0;
      let fileCount = 0;
      const mergedDevices = new Set();
      for (let idx = 0; idx < pending.length; idx++) {
        if (state.cancelled) return finish("cancelled");
        const p = pending[idx];
        const buf = await webdav.get(p.url, cfg.webdav);
        if (!buf) continue;
        const recs = decodeShard(buf, p.name);
        // 数据校验：过滤字段缺失、时间戳异常的无效数据（NOT NULL 字段必须齐备）
        const validRecs = recs.filter(
          (r) => r && typeof r.id === "string" && typeof r.deviceId === "string"
            && typeof r.deviceName === "string" && typeof r.source === "string" && r.source
            && typeof r.providerId === "string" && typeof r.modelId === "string"
            && typeof r.startedAt === "number" && !isNaN(r.startedAt)
        );
        if (validRecs.length > 0) {
          db.insertRecords(validRecs);
          // 增量拉取记账：hash 与远端 manifest 对齐，下次相同内容直接跳过。
          // 仅在成功合并后记账——损坏分片（0 条有效记录）下次仍会重试。
          db.setMeta(`merged:${p.other}:${p.name}`, p.hash || sha1(buf));
        }
        fileCount++;
        if (!mergedDevices.has(p.other)) mergedDevices.add(p.other);
        emit({ percent: 55 + Math.floor((idx + 1) / Math.max(pending.length, 1) * 30) });
      }
      // 无待拉取分片（全部已合并/自产）时循环不执行，补发进度避免 55% 直跳 90%
      if (pending.length === 0) emit({ percent: 85 });

      // 设备元数据
      for (const other of deviceFiles) {
        if (other === deviceId) continue;
        if (state.cancelled) return finish("cancelled");
        const metaUrl = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/${other}.json`);
        const metaText = await webdav.getText(metaUrl, cfg.webdav);
        let devName = other;
        let devSources = "";
        let lastSyncAt = null;
        if (metaText) {
          try {
            const meta = JSON.parse(metaText);
            devName = meta.deviceName || other;
            devSources = typeof meta.source === "string" ? meta.source : "";
            lastSyncAt = meta.lastSyncAt ?? null;
          } catch {
            /* 元数据损坏时回退为设备 ID */
          }
        }
        db.upsertDevice(other, devName, devSources, lastSyncAt);
        merged++;
      }
      log("download", "info", `已合并 ${mergedDevices.size} 台其他设备（${fileCount} 个分片）`);
    } else {
      log("download", "info", "未配置 WebDAV，跳过拉取");
    }

    if (state.cancelled) return finish("cancelled");

    // 4. 合并
    emit({ stage: "merge", percent: 90, message: "正在合并…" });
    db.upsertDevice(deviceId, deviceName, deviceSources, Date.now());
    log("merge", "info", "合并去重完成");

    return finish("completed");
  } catch (e) {
    log("error", "error", "同步失败", e.message);
    state.running = false;
    state.stage = "error";
    state.message = e.message;
    if (onFinish) onFinish(false, e.message);
    return { ok: false, error: e.message };
  }
}

function finish(result) {
  state.running = false;
  if (result === "completed") {
    state.stage = "done";
    state.percent = 100;
    state.message = "同步完成";
    state.lastSyncAt = Date.now();
    log("done", "ok", "同步完成");
    try { db.pruneLogs(); } catch { /* 日志裁剪失败不影响同步 */ }
    if (onFinish) onFinish(true, "同步完成");
    return { ok: true };
  }
  state.stage = "cancelled";
  state.message = "已取消";
  log("done", "info", "同步已取消");
  return { ok: false, cancelled: true };
}

function cancel() {
  state.cancelled = true;
  emit({ message: "正在取消…" });
}

function progress() {
  if (!state.lastSyncAt) {
    try { state.lastSyncAt = db.getLastSyncAt(db.getLocalDeviceId()); } catch { /* 初始化阶段忽略 */ }
  }
  return {
    running: state.running,
    stage: state.stage,
    stageLabel: STAGE_LABEL[state.stage] || state.stage,
    percent: state.percent,
    message: state.message,
    lastSyncAt: state.lastSyncAt,
  };
}

module.exports = { run, cancel, progress, setOnFinish, ensureLocalDeviceId, enabledSourceIds, RESCAN_WINDOW_MS, DEVICES_DIR, DATA_DIR };
