// WorkBuddy 数据源适配器
// 权威数据源：~/.workbuddy/projects/<编码cwd>/<sessionId>.jsonl 会话转录（逐条 message.usage）
// 设备标识：~/.workbuddy/device-id
// 口径（2026-09 实测）：usage.input_tokens 含缓存命中（OpenAI 语义，与 ZCode/Codex 一致）；
// 推理/缓存写入 token 仅存在于 providerData.rawUsage，探测补入，缺失记 0。
// 同一请求的 message / function_call 条目各有独立 messageId 与 usage，均计为一次真实调用（实测 48 条全唯一）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "workbuddy";
const NAME = "WorkBuddy";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

/** 数据目录（默认 ~/.workbuddy） */
function defaultDir() {
  return path.join(homeDir(), ".workbuddy");
}

function detect() {
  const dir = defaultDir();
  if (!fs.existsSync(dir)) return null;
  // 目录存在但既无转录也无主库时视为未安装（避免仅残留空目录被误判）
  return fs.existsSync(path.join(dir, "projects")) || fs.existsSync(path.join(dir, "workbuddy.db"))
    ? dir
    : null;
}

function validate(dir) {
  return fs.existsSync(path.join(dir, "projects"));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, "device-id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** 递归枚举 projects/ 下全部会话转录（*.jsonl） */
function findTranscripts(dir) {
  const out = [];
  const pending = [path.join(dir, "projects")];
  while (pending.length) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // 单目录不可读不影响其余目录
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

/** 时间戳兼容读取：epoch 秒 / epoch 毫秒 / ISO 字符串（小于 1e11 按秒计，与 reasonix 同口径） */
function toMs(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (typeof v === "string" && v.trim()) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** 供应商名：复用 ZCode 的模型名前缀推断；未命中时归为 WorkBuddy 而非「未知供应商」 */
function providerFor(modelId) {
  const name = providerName("", modelId);
  return name.startsWith("未知供应商") ? "WorkBuddy" : name;
}

/** 状态归一：WorkBuddy 的 completed 归为 success，其余原样透传（success/error/cancelled 前端可筛选） */
function normalizeStatus(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return !s || s === "completed" ? "success" : s;
}

/** 增量抽取：读取 timestamp > since 且带 message.usage 的条目，按 messageId 去重。 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 WorkBuddy 会话目录：${path.join(dir, "projects")}`);

  const sinceMs = Number.isFinite(since) ? since : 0;
  const out = [];
  const seen = new Set(); // 本次抽取内 messageId 去重（跨文件，与入库幂等键同口径）

  for (const file of findTranscripts(dir)) {
    // 转录为 append-only（会话期间追加、此后不再修改）：mtime 早于回扫窗口起点的
    // 文件不可能包含 timestamp > since 的条目，直接跳过（与 Codex 适配器同策略）
    if (sinceMs > 0) {
      try {
        if (fs.statSync(file).mtimeMs <= sinceMs) continue;
      } catch {
        /* stat 失败按全量解析 */
      }
    }

    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // 单文件读取失败（占用/权限）跳过，不影响其余文件
    }

    const fallbackSession = path.basename(file, ".jsonl");
    let lineIndex = 0;
    for (const line of text.split(/\r?\n/)) {
      lineIndex++;
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 损坏行跳过
      }
      const message = entry && typeof entry.message === "object" ? entry.message : null;
      const usage = message && typeof message.usage === "object" ? message.usage : null;
      if (!usage) continue; // 只统计带 usage 的条目（assistant 回包/工具调用回包）

      const startedAt = toMs(entry.timestamp);
      if (startedAt === null || startedAt <= sinceMs) continue;

      const pd = entry.providerData && typeof entry.providerData === "object" ? entry.providerData : {};
      const raw = pd.rawUsage && typeof pd.rawUsage === "object" ? pd.rawUsage : {};

      // 去重键：messageId（实测逐条唯一）；缺失时回退条目 id，再缺失用内容哈希
      let msgKey = typeof pd.messageId === "string" && pd.messageId ? pd.messageId : "";
      if (!msgKey && typeof entry.id === "string" && entry.id) msgKey = entry.id;
      if (!msgKey) msgKey = crypto.createHash("sha1").update(`${file}:${lineIndex}`).digest("hex");
      if (seen.has(msgKey)) continue;
      seen.add(msgKey);

      const modelRaw = typeof pd.model === "string" && pd.model.trim() ? pd.model : "unknown";
      const modelId = normalizeModel(modelRaw);
      // 推理/缓存写入 token：优先 OpenAI 风格 details，其次顶层别名，缺失记 0
      const details = raw.completion_tokens_details && typeof raw.completion_tokens_details === "object"
        ? raw.completion_tokens_details : {};
      const reasoning = details.reasoning_tokens ?? raw.completion_thinking_tokens ?? 0;
      const cacheCreation = raw.cache_creation_input_tokens ?? raw.prompt_cache_write_tokens ?? 0;

      out.push({
        id: `${deviceId}:workbuddy:${msgKey}`,
        deviceId,
        deviceName,
        source: ID,
        providerId: providerFor(modelId),
        modelId,
        variant: typeof pd.requestModelId === "string" && pd.requestModelId ? pd.requestModelId : undefined,
        sessionId: typeof entry.sessionId === "string" && entry.sessionId ? entry.sessionId : fallbackSession,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        reasoningTokens: reasoning ?? 0,
        cacheCreationTokens: cacheCreation ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        startedAt,
        completedAt: startedAt,
        status: normalizeStatus(entry.status),
      });
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
