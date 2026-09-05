// 本地汇总库（工具自有 SQLite，与 ZCode 的 db.sqlite 完全分离）
// 使用 Node 22 内置 node:sqlite，纯 JS 无原生编译依赖。
// 所有对外字段为 camelCase，与前端 src/types/index.ts 一致。
"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const config = require("./config.cjs");

let _db = null;

// 当前 schema 版本。旧库（user_version=0）首次打开时迁移到该版本；
// 未来变更表结构时：SCHEMA_VERSION+1，并在 init() 的迁移块中追加对应 ALTER/重建步骤
const SCHEMA_VERSION = 1;

/** 获取（惰性打开）单例连接 */
function get() {
  if (_db) return _db;
  _db = new DatabaseSync(config.dbPath());
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  init(_db);
  return _db;
}

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_record (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        variant TEXT,
        task_type TEXT,
        session_id TEXT,
        agent TEXT,
        mode TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_record_device ON usage_record(device_id);
    CREATE INDEX IF NOT EXISTS idx_record_started ON usage_record(started_at);
    CREATE INDEX IF NOT EXISTS idx_record_model ON usage_record(model_id);
    CREATE INDEX IF NOT EXISTS idx_record_source ON usage_record(source);
    CREATE INDEX IF NOT EXISTS idx_record_source_started ON usage_record(source, started_at);

    CREATE TABLE IF NOT EXISTS checkpoint (
        source TEXT PRIMARY KEY,
        anchor INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_meta (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        source TEXT NOT NULL,
        last_sync_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
    );
  `);

  // schema 版本迁移：按版本逐级执行，PRAGMA user_version 不可参数化故用常量拼接
  const row = db.prepare("PRAGMA user_version").get();
  const current = row && Number(row.user_version) ? Number(row.user_version) : 0;
  if (current < SCHEMA_VERSION) {
    // 0 → 1：仅把既有表/索引纳入版本管理，无数据变更；未来加列示例：
    // if (current < 2) db.exec("ALTER TABLE usage_record ADD COLUMN ...");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

// ===== 明细写入（幂等） =====

/** 将 UsageRecord（camelCase）批量写入，返回写入条数 */
function insertRecords(records) {
  if (!records || records.length === 0) return 0;
  const db = get();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO usage_record
    (id, device_id, device_name, source, provider_id, model_id, variant, task_type, session_id, agent, mode,
     input_tokens, output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens,
     started_at, completed_at, duration_ms, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.exec("BEGIN");
  try {
    for (const r of records) {
      stmt.run(
        r.id, r.deviceId, r.deviceName ?? "", r.source ?? "unknown", r.providerId ?? "", r.modelId ?? "",
        r.variant ?? null, r.taskType ?? null, r.sessionId ?? null, r.agent ?? null, r.mode ?? null,
        r.inputTokens ?? 0, r.outputTokens ?? 0, r.reasoningTokens ?? 0,
        r.cacheCreationTokens ?? 0, r.cacheReadTokens ?? 0,
        r.startedAt ?? 0, r.completedAt ?? null, r.durationMs ?? null, r.status ?? "success"
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return records.length;
}

// ===== meta / checkpoint / device_meta =====

function getMeta(key) {
  const row = get().prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  get().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function getLocalDeviceId() {
  return getMeta("device_id");
}

function setLocalDeviceId(id) {
  setMeta("device_id", id);
}

function getAnchor(source) {
  const row = get().prepare("SELECT anchor FROM checkpoint WHERE source = ?").get(source);
  return row ? row.anchor : 0;
}

function setAnchor(source, anchor) {
  get().prepare("INSERT OR REPLACE INTO checkpoint (source, anchor) VALUES (?, ?)").run(source, anchor);
}

function upsertDevice(deviceId, deviceName, source, lastSyncAt) {
  const existing = get().prepare("SELECT device_name FROM device_meta WHERE device_id = ?").get(deviceId);
  get().prepare(
    "INSERT OR REPLACE INTO device_meta (device_id, device_name, source, last_sync_at) VALUES (?,?,?,?)"
  ).run(deviceId, deviceName, source, lastSyncAt ?? null);
  // 联动更新已存记录中的设备名称，确保同一设备 ID 下名称绝对统一；名称未变化时跳过，避免每次全量 UPDATE
  if (deviceName && (!existing || existing.device_name !== deviceName)) {
    get().prepare(
      "UPDATE usage_record SET device_name = ? WHERE device_id = ?"
    ).run(deviceName, deviceId);
  }
}

function getLastSyncAt(deviceId) {
  const row = get().prepare("SELECT last_sync_at AS t FROM device_meta WHERE device_id = ?").get(deviceId);
  return row ? row.t : null;
}

// ===== 同步日志 =====

function addLog(kind, level, message, detail) {
  get().prepare(
    "INSERT INTO sync_log (time, kind, level, message, detail) VALUES (?,?,?,?,?)"
  ).run(Date.now(), kind, level, message, detail ?? null);
}

function getLogs() {
  return get().prepare(
    "SELECT id, time, kind, level, message, detail FROM sync_log ORDER BY id DESC LIMIT 200"
  ).all();
}

function clearLogs() {
  get().exec("DELETE FROM sync_log");
}

/** 只保留最近 keep 条日志（随同步完成自动裁剪） */
function pruneLogs(keep = 1000) {
  get().prepare(
    "DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT ?)"
  ).run(keep);
}

// ===== 聚合查询 =====

function nowMs() {
  return Date.now();
}

/** 今日零点（本地时区）epoch ms */
function todayStartMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 口径后缀：完整口径额外加 reasoning_tokens */
function extraExpr(mode) {
  return mode === "full" ? " + reasoning_tokens" : "";
}

function recordScope(source = null, deviceId = null) {
  const clauses = [];
  const params = [];
  if (source) { clauses.push("source = ?"); params.push(source); }
  if (deviceId) { clauses.push("device_id = ?"); params.push(deviceId); }
  return { clauses, params };
}

function whereSql(clauses) {
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function getSummary(mode, targetDeviceId = null, source = null) {
  const db = get();
  const extra = extraExpr(mode);
  const selectedScope = recordScope(source, targetDeviceId);

  const t0 = todayStartMs();
  const todayScope = {
    clauses: [...selectedScope.clauses, "started_at >= ?"],
    params: [...selectedScope.params, t0],
  };
  const totalRow = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens${extra}), 0) AS t, COUNT(*) AS c
     FROM usage_record${whereSql(selectedScope.clauses)}`
  ).get(...selectedScope.params);
  const td = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens${extra}),0) AS t,
            COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(cache_read_tokens),0) AS cr, COUNT(*) AS c
     FROM usage_record${whereSql(todayScope.clauses)}`
  ).get(...todayScope.params);
  const b = db.prepare(
    `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
            COALESCE(SUM(reasoning_tokens),0) AS rs, COALESCE(SUM(cache_read_tokens),0) AS cr,
            COALESCE(SUM(cache_creation_tokens),0) AS cc
     FROM usage_record${whereSql(selectedScope.clauses)}`
  ).get(...selectedScope.params);

  const cacheHitRate = b.i > 0 ? b.cr / b.i : 0;
  const todayCacheHitRate = td.i > 0 ? td.cr / td.i : 0;

  return {
    totalTokens: totalRow.t,
    todayTokens: td.t,
    cacheHitRate,
    todayCacheHitRate,
    cacheReadTokens: b.cr,
    inputTokens: b.i,
    outputTokens: b.o,
    reasoningTokens: b.rs,
    cacheCreationTokens: b.cc,
    todayInputTokens: td.i,
    todayCacheReadTokens: td.cr,
    todayRecordCount: td.c,
    recordCount: totalRow.c,
  };
}

function getDevices(localDeviceId, mode, source = null) {
  const db = get();
  const extra = extraExpr(mode);
  const sourceJoin = source ? " AND r.source = ?" : "";
  const params = source ? [source] : [];
  const rows = db.prepare(
    `SELECT d.device_id AS deviceId, d.device_name AS deviceName, d.source AS source, d.last_sync_at AS lastSyncAt,
            COALESCE(SUM(r.input_tokens + r.output_tokens${extra}), 0) AS base, COUNT(r.id) AS recordCount
     FROM device_meta d LEFT JOIN usage_record r ON r.device_id = d.device_id${sourceJoin}
     GROUP BY d.device_id ORDER BY base DESC, d.device_name ASC`
  ).all(...params);
  const now = nowMs();
  return rows.filter((row) => !source || row.deviceId === localDeviceId || row.recordCount > 0).map((row) => ({
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    source: row.source,
    lastSyncAt: row.lastSyncAt ?? null,
    // 本机恒视为在线；其他设备按最近同步时间（7 天内）判定在线
    online: row.deviceId === localDeviceId ? true : row.lastSyncAt != null && now - row.lastSyncAt < 7 * 86400000,
    totalTokens: row.base,
    isLocal: row.deviceId === localDeviceId,
  }));
}

function getDeviceBreakdowns(localDeviceId, mode, targetDeviceId = null, source = null) {
  const extra = extraExpr(mode);
  const sourceJoin = source ? " AND r.source = ?" : "";
  const filter = targetDeviceId ? " WHERE d.device_id = ?" : "";
  const params = [...(source ? [source] : []), ...(targetDeviceId ? [targetDeviceId] : [])];
  const rows = get().prepare(
    `SELECT d.device_id AS deviceId, d.device_name AS deviceName,
            COALESCE(SUM(r.input_tokens + r.output_tokens${extra}), 0) AS totalTokens,
            COALESCE(SUM(r.input_tokens), 0) AS inputTokens,
            COALESCE(SUM(r.output_tokens), 0) AS outputTokens,
            COALESCE(SUM(r.reasoning_tokens), 0) AS reasoningTokens,
            COALESCE(SUM(r.cache_read_tokens), 0) AS cacheReadTokens,
            COALESCE(SUM(r.cache_creation_tokens), 0) AS cacheCreationTokens,
            COUNT(r.id) AS recordCount
     FROM device_meta d LEFT JOIN usage_record r ON r.device_id = d.device_id${sourceJoin}
     ${filter}
     GROUP BY d.device_id, d.device_name ORDER BY totalTokens DESC, d.device_name ASC`
  ).all(...params);
  return rows.filter((r) => r.recordCount > 0).map((r) => ({
    deviceId: r.deviceId,
    deviceName: r.deviceName,
    isLocal: r.deviceId === localDeviceId,
    totalTokens: r.totalTokens,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    recordCount: r.recordCount,
  }));
}

function getTrend(mode, days, targetDeviceId = null, source = null) {
  const extra = extraExpr(mode);
  const t0 = nowMs() - days * 86400000;
  const scope = recordScope(source, targetDeviceId);
  const clauses = ["started_at >= ?", ...scope.clauses];
  const params = [t0, ...scope.params];
  const rows = get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date,
            SUM(input_tokens + output_tokens${extra}) AS total
     FROM usage_record${whereSql(clauses)}
     GROUP BY date ORDER BY date ASC`
  ).all(...params);
  const models = get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date, model_id AS model,
            SUM(input_tokens + output_tokens${extra}) AS total
     FROM usage_record${whereSql(clauses)} GROUP BY date, model ORDER BY date ASC`
  ).all(...params);
  const byDate = new Map();
  for (const r of models) { if (!byDate.has(r.date)) byDate.set(r.date, {}); byDate.get(r.date)[r.model || "未知模型"] = r.total; }
  return rows.map((r) => ({ ...r, models: byDate.get(r.date) || {} }));
}

function getHeatmap(mode, startDate, endDate, targetDeviceId = null, source = null) {
  const extra = extraExpr(mode);
  const scope = recordScope(source, targetDeviceId);
  const clauses = [
    "date(started_at/1000, 'unixepoch', 'localtime') >= ?",
    "date(started_at/1000, 'unixepoch', 'localtime') <= ?",
    ...scope.clauses,
  ];
  const params = [startDate, endDate, ...scope.params];
  return get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date,
            SUM(input_tokens + output_tokens${extra}) AS total
     FROM usage_record
     ${whereSql(clauses)}
     GROUP BY date ORDER BY date ASC`
  ).all(...params);
}

function getAggregate(mode, dim, from, to, source = null) {
  const dimCol = dim === "provider" ? "provider_id" : dim === "device" ? "device_name" : dim === "source" ? "source" : "model_id";
  const extra = extraExpr(mode);
  const rows = get().prepare(
    `SELECT ${dimCol} AS k,
            SUM(input_tokens + output_tokens${extra}) AS total,
            SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
            SUM(reasoning_tokens) AS reasoningTokens, SUM(cache_read_tokens) AS cacheReadTokens,
            SUM(cache_creation_tokens) AS cacheCreationTokens, COUNT(*) AS count
     FROM usage_record
     WHERE (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at <= ?)
       ${source ? "AND source = ?" : ""}
     GROUP BY k ORDER BY total DESC`
  ).all(from, from, to, to, ...(source ? [source] : []));
  return rows.map((r) => ({
    key: r.k,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    totalTokens: r.total,
    count: r.count,
  }));
}

/** 行 → UsageRecord（camelCase） */
function rowToRecord(row) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    source: row.source,
    providerId: row.providerId,
    modelId: row.modelId,
    variant: row.variant ?? undefined,
    taskType: row.taskType ?? undefined,
    sessionId: row.sessionId ?? undefined,
    agent: row.agent ?? undefined,
    mode: row.mode ?? undefined,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
    status: row.status,
  };
}

// ===== 按天分片读取（同步上传用：避免全量记录驻留内存与分页 COUNT 浪费） =====

/** 本机有记录的全部 UTC 日（"YYYY-MM-DD" 升序），与上传分片文件名口径一致（SQLite date() 默认 UTC） */
function getRecordDays(deviceId) {
  return get().prepare(
    "SELECT DISTINCT date(started_at/1000, 'unixepoch') AS day FROM usage_record WHERE device_id = ? ORDER BY day ASC"
  ).all(deviceId).map((r) => r.day);
}

/** 某设备某 UTC 日的全部记录（升序），返回 UsageRecord 结构 */
function getRecordsByDay(deviceId, day) {
  const m = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return get().prepare(
    `SELECT id, device_id AS deviceId, device_name AS deviceName, source, provider_id AS providerId,
            model_id AS modelId, variant, task_type AS taskType, session_id AS sessionId, agent, mode,
            input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
            cache_creation_tokens AS cacheCreationTokens, cache_read_tokens AS cacheReadTokens,
            started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, status
     FROM usage_record
     WHERE device_id = ? AND started_at >= ? AND started_at < ?
     ORDER BY started_at ASC`
  ).all(deviceId, start, start + 86400000).map(rowToRecord);
}

/** 记录筛选条件 → { whereStr, params }（getRecords 与导出共用同一套条件语义） */
function buildRecordFilter(filter = {}) {
  const clauses = [];
  const params = [];
  const conds = [
    ["started_at >= ?", filter.from],
    ["started_at <= ?", filter.to],
    ["device_id = ?", filter.deviceId],
    ["source = ?", filter.source],
    ["model_id = ?", filter.model],
    ["provider_id = ?", filter.provider],
    ["status = ?", filter.status],
  ];
  for (const [clause, val] of conds) {
    if (val !== null && val !== undefined && val !== "") {
      clauses.push(clause);
      params.push(val);
    }
  }
  return { whereStr: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function getRecords(filter = {}) {
  const { whereStr, params } = buildRecordFilter(filter);

  const total = get().prepare(`SELECT COUNT(*) AS c FROM usage_record${whereStr}`).get(...params).c;

  const dataSql = `
    SELECT id, device_id AS deviceId, device_name AS deviceName, source, provider_id AS providerId,
           model_id AS modelId, variant, task_type AS taskType, session_id AS sessionId, agent, mode,
           input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
           cache_creation_tokens AS cacheCreationTokens, cache_read_tokens AS cacheReadTokens,
           started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, status
    FROM usage_record${whereStr} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
  const records = get().prepare(dataSql).all(...params, filter.limit ?? 50, filter.offset ?? 0).map(rowToRecord);

  return { records, total };
}

// ===== 导出 =====

function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function allRecords(filter = {}) {
  const { whereStr, params } = buildRecordFilter(filter);
  return get().prepare(
    `SELECT id, device_id AS deviceId, device_name AS deviceName, source, provider_id AS providerId,
            model_id AS modelId, variant, task_type AS taskType, session_id AS sessionId, agent, mode,
            input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
            cache_creation_tokens AS cacheCreationTokens, cache_read_tokens AS cacheReadTokens,
            started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, status
     FROM usage_record${whereStr} ORDER BY started_at ASC`
  ).all(...params).map(rowToRecord);
}

function exportCsv(filter = {}) {
  const records = allRecords(filter);
  const esc = (v) => {
    let s = String(v ?? "");
    // 防 Excel 公式注入：先加前缀再做引号包裹，确保最终单元格首字符不是 = + - @
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = "时间,设备,软件源,模型,供应商,输入,输出,推理,缓存命中,缓存写入,状态";
  const rows = records.map((r) =>
    [fmtLocal(r.startedAt), r.deviceName, r.source, r.modelId, r.providerId,
     r.inputTokens, r.outputTokens, r.reasoningTokens, r.cacheReadTokens, r.cacheCreationTokens, r.status]
      .map(esc).join(",")
  );
  return [head, ...rows].join("\r\n");
}

function exportJson(filter = {}) {
  return JSON.stringify(allRecords(filter), null, 2);
}

/** LIKE 模式转义（配 ESCAPE '\' 使用），防止设备 ID 中的 %/_ 干扰前缀匹配 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, "\\$&");
}

/** 删除某设备的全部本地数据（明细 + 设备元数据 + 增量合并记账），用于退役设备清理 */
function deleteDeviceData(deviceId) {
  const db = get();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM usage_record WHERE device_id = ?").run(deviceId);
    db.prepare("DELETE FROM device_meta WHERE device_id = ?").run(deviceId);
    db.prepare("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'").run(escapeLike(`merged:${deviceId}:`) + "%");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 清空本地缓存：删除全部明细、增量抽取锚点、上传/合并记账与他机设备元数据；
 * 保留本机 device_id 与 Antigravity 快照基线（snapshot: 清除会导致配额差值重复入账）。
 * WebDAV 远端数据不动；下次同步自动全量重传/重拉（分片覆盖写与合并均幂等）。
 */
function clearLocalCache(localDeviceId) {
  const db = get();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM usage_record").run();
    db.prepare("DELETE FROM checkpoint").run();
    db.prepare("DELETE FROM device_meta WHERE device_id != ?").run(localDeviceId ?? "");
    db.prepare("DELETE FROM meta WHERE key LIKE 'uploaded:%' OR key LIKE 'merged:%'").run();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = {
  get,
  insertRecords,
  getMeta, setMeta,
  getLocalDeviceId, setLocalDeviceId,
  getAnchor, setAnchor,
  upsertDevice,
  addLog, getLogs, clearLogs, pruneLogs,
  getSummary, getDevices, getDeviceBreakdowns, getTrend, getHeatmap, getAggregate, getRecords,
  getRecordDays, getRecordsByDay,
  getLastSyncAt,
  deleteDeviceData, clearLocalCache,
  exportCsv, exportJson,
  todayStartMs,
};
