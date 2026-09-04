// Codex 数据源适配器
// 权威数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 设备标识：~/.codex/installation_id
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeModel, providerName } = require("./adapter-zcode.cjs");

const ID = "codex";
const NAME = "Codex";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function defaultDir() {
  return path.join(homeDir(), ".codex");
}

function detect() {
  const dir = defaultDir();
  return fs.existsSync(dir) ? dir : null;
}

function validate(dir) {
  return fs.existsSync(path.join(dir, "sessions"));
}

function getDeviceId(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, "installation_id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function findRollouts(dir) {
  const out = [];
  const pending = [path.join(dir, "sessions")];
  while (pending.length) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function firstModel(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.model === "string" && value.model.trim()) return value.model;
  for (const child of Object.values(value)) {
    const found = firstModel(child);
    if (found) return found;
  }
  return null;
}

function sessionIdFromFile(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  return match ? match[1] : path.basename(file, ".jsonl");
}

/** 增量抽取：只采 event_msg/token_count 的 last_token_usage，累计值不入库。 */
function extract(dir, deviceId, deviceName, since) {
  if (!validate(dir)) throw new Error(`未找到 Codex 会话目录：${path.join(dir, "sessions")}`);

  const out = [];
  for (const file of findRollouts(dir)) {
    const events = [];
    let sessionId = sessionIdFromFile(file);
    let model = null;
    let fallbackSequence = 0;

    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      if (item.type === "session_meta" && typeof item.payload?.id === "string") {
        sessionId = item.payload.id;
      }
      if (!model) model = firstModel(item);

      if (item.type !== "event_msg" || item.payload?.type !== "token_count") continue;
      const usage = item.payload.info?.last_token_usage;
      if (!usage || typeof usage !== "object") continue;
      fallbackSequence++;
      const startedAt = new Date(item.timestamp).getTime();
      if (!Number.isFinite(startedAt) || startedAt <= since) continue;

      events.push({
        sequence: item.ordinal ?? fallbackSequence,
        startedAt,
        usage,
      });
    }

    const modelId = normalizeModel(model || "unknown");
    for (const event of events) {
      const usage = event.usage;
      out.push({
        id: `${deviceId}:codex:${sessionId}:${event.sequence}`,
        deviceId,
        deviceName,
        source: ID,
        providerId: providerName("openai", modelId),
        modelId,
        sessionId,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        reasoningTokens: usage.reasoning_output_tokens ?? 0,
        cacheCreationTokens: usage.cache_write_input_tokens ?? 0,
        cacheReadTokens: usage.cached_input_tokens ?? 0,
        startedAt: event.startedAt,
        completedAt: event.startedAt,
        status: "success",
      });
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = { id: ID, name: NAME, detect, validate, getDeviceId, extract };
