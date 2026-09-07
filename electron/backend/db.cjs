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
const SCHEMA_VERSION = 3;

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

    -- 模型价格（时段版本化）：改价 = 关闭现行段 + 插入新段，历史段永久保留
    -- source 三层来源：manual=手动（最高）| remote=远程拉取 | builtin=内置种子（兜底）
    CREATE TABLE IF NOT EXISTS model_price (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT,                       -- NULL = 不限供应商（通配）
        model_id TEXT NOT NULL,
        input_per_m REAL NOT NULL DEFAULT 0,    -- 单价：元（$）/ 百万 token
        output_per_m REAL NOT NULL DEFAULT 0,
        cache_read_per_m REAL NOT NULL DEFAULT 0,
        cache_write_per_m REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'CNY',
        effective_from INTEGER NOT NULL,        -- epoch ms（含），生效起
        effective_to INTEGER,                   -- epoch ms（不含）；NULL = 至今
        updated_at INTEGER NOT NULL,
        updated_by TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_price_lookup ON model_price(model_id, effective_from);

    -- 记录成本视图：按「记录发生时刻生效的最优匹配价」动态计费（价格修改后历史自动重算）
    -- 口径：净输入×输入价 + 缓存命中×缓存读价 + 缓存写入×缓存写价 + (输出+推理)×输出价
    -- 适配器口径锚点：input_tokens 含 cache_read_tokens（README 已实测），故净输入需相减
    -- 匹配优先级：来源（manual 手动 > remote 远程 > builtin 种子）→ 供应商精确 → 生效时间最新
    CREATE VIEW IF NOT EXISTS v_record_cost AS
    SELECT r.*,
      ( COALESCE(mp.input_per_m, 0)      * (r.input_tokens - r.cache_read_tokens)
      + COALESCE(mp.cache_read_per_m, 0) * r.cache_read_tokens
      + COALESCE(mp.cache_write_per_m, 0)* r.cache_creation_tokens
      + COALESCE(mp.output_per_m, 0)     * (r.output_tokens + r.reasoning_tokens)
      ) / 1000000.0 AS cost_native,
      mp.currency AS cost_currency,
      mp.id AS price_id
    FROM usage_record r
    LEFT JOIN model_price mp ON mp.id = (
      SELECT p.id FROM model_price p
      WHERE p.model_id = r.model_id
        AND (p.provider_id IS NULL OR p.provider_id = r.provider_id)
        AND p.effective_from <= r.started_at
        AND (p.effective_to IS NULL OR p.effective_to > r.started_at)
      ORDER BY CASE COALESCE(p.source, 'manual') WHEN 'manual' THEN 0 WHEN 'remote' THEN 1 ELSE 2 END,
               (p.provider_id IS NOT NULL) DESC,
               p.effective_from DESC
      LIMIT 1
    );
  `);

  // schema 版本迁移：按版本逐级执行，PRAGMA user_version 不可参数化故用常量拼接
  const row = db.prepare("PRAGMA user_version").get();
  const current = row && Number(row.user_version) ? Number(row.user_version) : 0;
  if (current < SCHEMA_VERSION) {
    // 0 → 1：仅把既有表/索引纳入版本管理，无数据变更
    // 1 → 2：新增计费（model_price / v_record_cost）。价格表为空时写入内置默认价格，
    //        让用户开启计费后立即可见全部历史费用；仅迁移时种一次，之后删光不复活。
    if (current < 2) {
      const n = db.prepare("SELECT COUNT(*) AS c FROM model_price").get().c;
      if (!n) seedDefaultPrices(db);
    }
    // 2 → 3：价格来源三层化（manual 手动 > remote 远程拉取 > builtin 内置种子）。
    // 老库补 source 列（新库建表已带）；内置种子行标 builtin；唯一索引重建纳入 source。
    if (current < 3) {
      const cols = db.prepare("PRAGMA table_info(model_price)").all().map((c) => c.name);
      if (!cols.includes("source")) {
        db.exec("ALTER TABLE model_price ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
      }
      db.exec("UPDATE model_price SET source = 'builtin' WHERE updated_by = '内置默认'");
      db.exec("DROP INDEX IF EXISTS idx_price_period");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_price_period ON model_price(COALESCE(provider_id, ''), model_id, source, effective_from)");
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

// ===== 内置默认价格 =====
// 2026-09 整理的参考价（元（$）/ 百万 token），覆盖本机已出现的主要模型；
// provider 通配（NULL），用户可随时改价/删除，改为精确供应商价后通配行即被覆盖。
// codex-auto-review 为 Codex 内置评审能力，订阅内不单独计费，配 0 价避免误报「未配置」。
const DEFAULT_PRICES = [
  ["deepseek-v4-pro", 2, 8, 0.4],
  ["deepseek-v4-flash", 1, 4, 0.2],
  ["glm-5.3", 2, 8, 0.4],
  ["glm-5.3-flash", 1, 4, 0.2],
  ["glm-5.2", 4, 16, 0.8],
  ["glm-5-turbo", 1, 4, 0.2],
  ["glm-4.5-fp8", 1, 4, 0.2],
  ["kimi-k3", 4, 16, 0.8],
  ["qwen3.7-max", 2.4, 9.6, 0.5],
  ["qwen3.7-max-preview", 2.4, 9.6, 0.5],
  ["qwen3.7-flash", 0.3, 1.2, 0.1],
  ["qwen3.5-ocr", 0.5, 2, 0.1],
  ["minimax-m3", 1, 4, 0.2],
  ["minimax-m2.7", 1, 4, 0.2],
  ["dots3-note-prev", 0.5, 2, 0.1],
  ["ox-alpha", 3, 15, 0.3, "USD"],
  ["gpt-5.6-sol", 2.5, 10, 1.25, "USD"],
  ["gpt-5.5", 1.25, 10, 0.6, "USD"],
  ["gpt-5.4", 1.25, 10, 0.6, "USD"],
  ["codex-auto-review", 0, 0, 0],
];

/** 写入内置默认价格（仅建库/迁移且价格表为空时调用），effective_from=0 使全部历史立即可计价 */
function seedDefaultPrices(db) {
  const stmt = db.prepare(
    "INSERT INTO model_price (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, updated_at, updated_by, source) VALUES (NULL,?,?,?,?,0,?,0,?,'内置默认','builtin')"
  );
  const now = Date.now();
  db.exec("BEGIN");
  try {
    for (const [model, i, o, cr, cur] of DEFAULT_PRICES) stmt.run(model, i, o, cr, cur || "CNY", now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
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

// ---- 计费辅助 ----
// 显示币种与汇率由 ipc 层在加载/保存配置时注入（setBillingFx），
// 换算在 JS 层完成而非 SQL：汇率修改后所有查询即时生效，无需重建视图。
const billingFx = { displayCurrency: "CNY", usdToCny: 7.2 };

function setBillingFx(displayCurrency, usdToCny) {
  billingFx.displayCurrency = displayCurrency === "USD" ? "USD" : "CNY";
  const r = Number(usdToCny);
  billingFx.usdToCny = isFinite(r) && r > 0 ? r : 7.2;
}

/** 原生币种成本 → 显示币种成本 */
function toDisplay(costNative, currency) {
  if (!currency || currency === billingFx.displayCurrency) return costNative;
  if (currency === "USD" && billingFx.displayCurrency === "CNY") return costNative * billingFx.usdToCny;
  if (currency === "CNY" && billingFx.displayCurrency === "USD") {
    return billingFx.usdToCny > 0 ? costNative / billingFx.usdToCny : costNative;
  }
  return costNative;
}

/** GROUP BY cost_currency 的聚合行 → 显示币种合计 */
function sumCostByCurrency(rows) {
  return rows.reduce((a, r) => a + toDisplay(r.s, r.cur), 0);
}

// Antigravity 系记录的数值是配额百分比点而非 token，不参与任何费用聚合（明细中照常展示）
const QUOTA_SOURCES_SQL = "source NOT IN ('antigravity','antigravity-ide')";

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

// ---- 模型价格 CRUD ----

const num0 = (v) => {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : 0;
};

/**
 * 保存价格：与 [from, ∞) 重叠的【同来源】既有段，起点更晚的直接删除（覆盖重复配置/导入），
 * 起点更早的把终点收口到 from；历史段（终点 ≤ from）与其它来源的段不动。事务内完成，时段永不重叠。
 * source：UI/导入路径写入 manual；远程拉取走 applyRemotePricing（remote）。
 */
function savePrice(entry, updatedBy = "") {
  const db = get();
  const modelId = String(entry.modelId || "").trim();
  if (!modelId) throw new Error("模型 ID 不能为空");
  const from = Math.max(0, Math.floor(Number(entry.effectiveFrom) || 0));
  const providerId = entry.providerId ? String(entry.providerId) : null;
  const currency = entry.currency === "USD" ? "USD" : "CNY";
  const source = entry.source === "remote" ? "remote" : "manual";
  db.exec("BEGIN");
  try {
    db.prepare(
      "DELETE FROM model_price WHERE model_id = ? AND COALESCE(provider_id, '') = COALESCE(?, '') AND COALESCE(source, 'manual') = ? AND effective_from >= ?"
    ).run(modelId, providerId, source, from);
    db.prepare(
      "UPDATE model_price SET effective_to = ? WHERE model_id = ? AND COALESCE(provider_id, '') = COALESCE(?, '') AND COALESCE(source, 'manual') = ? AND effective_from < ? AND (effective_to IS NULL OR effective_to > ?)"
    ).run(from, modelId, providerId, source, from, from);
    db.prepare(
      "INSERT INTO model_price (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, effective_to, updated_at, updated_by, source) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)"
    ).run(providerId, modelId, num0(entry.inputPerM), num0(entry.outputPerM), num0(entry.cacheReadPerM), num0(entry.cacheWritePerM), currency, from, Date.now(), updatedBy, source);
    // 计费价格 LWW 时钟（与行内 updated_at 解耦：删除操作也要推进时钟，否则删光后被远端旧价覆盖）
    setMeta("prices_local_updated", String(Date.now()));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 删除某模型（含供应商维度）的全部价格版本（任何来源，含内置/远程） */
function deleteModelPrices(providerId, modelId) {
  get().prepare(
    "DELETE FROM model_price WHERE model_id = ? AND COALESCE(provider_id, '') = COALESCE(?, '')"
  ).run(modelId, providerId || null);
  setMeta("prices_local_updated", String(Date.now()));
}

function priceRow(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    inputPerM: row.input_per_m,
    outputPerM: row.output_per_m,
    cacheReadPerM: row.cache_read_per_m,
    cacheWritePerM: row.cache_write_per_m,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to ?? null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    source: row.source ?? "manual",
  };
}

/** 全部价格版本（价格历史抽屉 / WebDAV 同步导出用） */
function listAllPrices() {
  return get().prepare(
    "SELECT id, provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, effective_to, updated_at, updated_by, source FROM model_price ORDER BY model_id, COALESCE(provider_id,''), effective_from"
  ).all().map(priceRow);
}

/** 每个模型（+供应商维度）的最新价格段（价格表页展示），附版本数与是否生效中。
 *  取行语义与 v_record_cost 匹配一致：组内按「来源优先级 → 生效时间最新」取最优行（窗口函数）。 */
function listCurrentPrices() {
  const now = nowMs();
  return get().prepare(
    `SELECT * FROM (
       SELECT p.id, p.provider_id, p.model_id, p.input_per_m, p.output_per_m, p.cache_read_per_m, p.cache_write_per_m,
              p.currency, p.effective_from, p.effective_to, p.updated_at, p.updated_by, p.source,
              COUNT(*) OVER (PARTITION BY COALESCE(p.provider_id,''), p.model_id) AS versions,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(p.provider_id,''), p.model_id
                ORDER BY CASE COALESCE(p.source,'manual') WHEN 'manual' THEN 0 WHEN 'remote' THEN 1 ELSE 2 END,
                         p.effective_from DESC
              ) AS rn
       FROM model_price p
     ) WHERE rn = 1
     ORDER BY model_id, COALESCE(provider_id,'')`
  ).all().map((row) => ({
    ...priceRow(row),
    versions: row.versions,
    active: row.effective_from <= now && (row.effective_to == null || row.effective_to > now),
  }));
}

/** 某模型的全部价格版本（历史时间线，时间倒序） */
function listPriceVersions(providerId, modelId) {
  return get().prepare(
    "SELECT id, provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, effective_to, updated_at, updated_by, source FROM model_price WHERE model_id = ? AND COALESCE(provider_id,'') = COALESCE(?, '') ORDER BY effective_from DESC"
  ).all(modelId, providerId || null).map(priceRow);
}

/** 扫描无价格且有 token 消耗的模型（费用页提醒 / 计费规则页「从用量生成草稿」） */
function listUnpricedModels(source = null) {
  return get().prepare(
    `SELECT r.provider_id AS providerId, r.model_id AS modelId, COUNT(*) AS records,
            COALESCE(SUM(r.input_tokens + r.output_tokens + r.reasoning_tokens), 0) AS tokens,
            MIN(r.started_at) AS firstSeen
     FROM v_record_cost r
     WHERE r.price_id IS NULL AND (r.input_tokens + r.output_tokens + r.reasoning_tokens) > 0
       AND ${QUOTA_SOURCES_SQL} ${source ? "AND r.source = ?" : ""}
     GROUP BY r.provider_id, r.model_id ORDER BY tokens DESC`
  ).all(...(source ? [source] : []));
}

/** 价格表整体替换（WebDAV 同步远端更新时用）；clockMs 为远端时钟，保留它防止下载后再回传的乒乓 */
function replacePrices(prices, clockMs) {
  const db = get();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM model_price").run();
    const stmt = db.prepare(
      "INSERT INTO model_price (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, effective_to, updated_at, updated_by, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    );
    for (const p of Array.isArray(prices) ? prices : []) {
      if (!p || typeof p.modelId !== "string" || !p.modelId) continue;
      stmt.run(
        p.providerId ?? null, p.modelId,
        num0(p.inputPerM), num0(p.outputPerM), num0(p.cacheReadPerM), num0(p.cacheWritePerM),
        p.currency === "USD" ? "USD" : "CNY",
        Math.max(0, Math.floor(Number(p.effectiveFrom) || 0)),
        p.effectiveTo == null ? null : Number(p.effectiveTo) || null,
        Number(p.updatedAt) || Date.now(),
        typeof p.updatedBy === "string" ? p.updatedBy : "",
        ["manual", "remote", "builtin"].includes(p.source) ? p.source : "manual"
      );
    }
    setMeta("prices_local_updated", String(Math.floor(Number(clockMs) || Date.now())));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 远程价格行与候选条目的同价判断（四价 + 币种） */
function remotePriceSame(row, e) {
  return row.currency === e.currency && row.effective_to === null &&
    ["input_per_m", "output_per_m", "cache_read_per_m", "cache_write_per_m"].every(
      (col, i) => Math.abs((row[col] ?? 0) - [e.inputPerM, e.outputPerM, e.cacheReadPerM, e.cacheWritePerM][i]) < 1e-9
    );
}

/**
 * 应用远程价格源（自动拉取，来源 remote）：只对「本地出现过用量」的模型生效。
 * 逐模型：无 remote 段 → 插入首段（拉取时刻起生效，历史回落 builtin/既有段）；
 * 同价且现行 → 跳过；异价 → 关旧 remote 段 + 开新段。不触碰 manual/builtin 行。
 */
function applyRemotePricing(entries) {
  const db = get();
  const now = Date.now();
  let added = 0, updated = 0, skipped = 0;
  db.exec("BEGIN");
  try {
    const latest = db.prepare(
      "SELECT id, effective_from, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_to FROM model_price WHERE model_id = ? AND COALESCE(provider_id,'') = COALESCE(?,'') AND COALESCE(source,'manual') = 'remote' ORDER BY effective_from DESC LIMIT 1"
    );
    const closeOld = db.prepare("UPDATE model_price SET effective_to = ? WHERE id = ?");
    const ins = db.prepare(
      "INSERT INTO model_price (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, effective_from, effective_to, updated_at, updated_by, source) VALUES (NULL,?,?,?,?,?,?,?,NULL,?,'远程价格源','remote')"
    );
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !e.modelId) continue;
      const cur = latest.get(e.modelId, e.providerId ?? null);
      if (cur && remotePriceSame(cur, e)) { skipped++; continue; }
      // 新段起点：与旧段同毫秒时 +1ms，避开 (provider,model,source,effective_from) 唯一索引
      const from = cur ? Math.max(now, cur.effective_from + 1) : now;
      if (cur) closeOld.run(from, cur.id);
      ins.run(e.modelId, num0(e.inputPerM), num0(e.outputPerM), num0(e.cacheReadPerM), num0(e.cacheWritePerM),
        e.currency === "USD" ? "USD" : "CNY", from, from);
      if (cur) updated++; else added++;
    }
    setMeta("prices_local_updated", String(now));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { added, updated, skipped };
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
  const now = new Date();
  // 本月 1 日 / 上月 1 日 / 上月同日零点（本地时区）：本月费用 + 较上月同期
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const prevMonthSameDay = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).getTime();
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

  // 费用聚合：按币种分组求和后在 JS 换算为显示币种（汇率修改即时生效）
  const costWindows = [
    ["totalCost", totalRow.c > 0 ? [...selectedScope.clauses] : null, [...selectedScope.params]],
    ["todayCost", todayScope.clauses, todayScope.params],
    ["monthCost", [...selectedScope.clauses, "started_at >= ?"], [...selectedScope.params, monthStart]],
    ["monthCostPrev", [...selectedScope.clauses, "started_at >= ? AND started_at < ?"], [...selectedScope.params, prevMonthStart, prevMonthSameDay]],
  ];
  const costs = {};
  for (const [key, clauses, params] of costWindows) {
    if (!clauses) { costs[key] = 0; continue; }
    const scopeSql = clauses.length ? " AND " + clauses.join(" AND ") : "";
    const rows = db.prepare(
      `SELECT cost_currency AS cur, SUM(cost_native) AS s FROM v_record_cost WHERE ${QUOTA_SOURCES_SQL}${scopeSql} GROUP BY cur`
    ).all(...params);
    costs[key] = sumCostByCurrency(rows);
  }
  // 未配置价格但有 token 消耗的记录（跨全部时间）
  const unpriced = db.prepare(
    `SELECT COUNT(*) AS c,
            COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens), 0) AS t,
            COUNT(DISTINCT model_id || '|' || provider_id) AS m
     FROM v_record_cost
     WHERE price_id IS NULL AND (input_tokens + output_tokens + reasoning_tokens) > 0
       AND ${QUOTA_SOURCES_SQL}${selectedScope.clauses.length ? " AND " + selectedScope.clauses.join(" AND ") : ""}`
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
    totalCost: costs.totalCost,
    todayCost: costs.todayCost,
    monthCost: costs.monthCost,
    monthCostPrev: costs.monthCostPrev,
    unpricedRecords: unpriced.c,
    unpricedTokens: unpriced.t,
    unpricedModels: unpriced.m,
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
  // 各设备费用（显示币种；Antigravity 配额点不计）
  const costClauses = [
    ...recordScope(source, targetDeviceId).clauses,
  ];
  const costParams = recordScope(source, targetDeviceId).params;
  const costScope = costClauses.length ? " AND " + costClauses.join(" AND ") : "";
  const costRows = get().prepare(
    `SELECT device_id AS did, cost_currency AS cur, SUM(cost_native) AS s
     FROM v_record_cost WHERE ${QUOTA_SOURCES_SQL}${costScope}
     GROUP BY device_id, cur`
  ).all(...costParams);
  const costByDevice = new Map();
  for (const r of costRows) {
    costByDevice.set(r.did, (costByDevice.get(r.did) || 0) + toDisplay(r.s, r.cur));
  }
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
    cost: costByDevice.get(r.deviceId) || 0,
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
  // 每日费用（按币种分组后 JS 换算；与 token 同一日期口径，Antigravity 配额点不计）
  const costScope = clauses.length ? " AND " + clauses.join(" AND ") : "";
  const costRows = get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date, cost_currency AS cur, SUM(cost_native) AS s
     FROM v_record_cost WHERE ${QUOTA_SOURCES_SQL}${costScope}
     GROUP BY date, cur`
  ).all(...params);
  const costByDate = new Map();
  for (const r of costRows) {
    if (!costByDate.has(r.date)) costByDate.set(r.date, []);
    costByDate.get(r.date).push(r);
  }
  const byDate = new Map();
  for (const r of models) { if (!byDate.has(r.date)) byDate.set(r.date, {}); byDate.get(r.date)[r.model || "未知模型"] = r.total; }
  return rows.map((r) => ({
    ...r,
    cost: sumCostByCurrency(costByDate.get(r.date) || []),
    models: byDate.get(r.date) || {},
  }));
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
  const rows = get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date,
            SUM(input_tokens + output_tokens${extra}) AS total
     FROM usage_record
     ${whereSql(clauses)}
     GROUP BY date ORDER BY date ASC`
  ).all(...params);
  // 每日费用（DayModal 展示；Antigravity 配额点不计）
  const costScope = clauses.length ? " AND " + clauses.join(" AND ") : "";
  const costRows = get().prepare(
    `SELECT date(started_at/1000, 'unixepoch', 'localtime') AS date, cost_currency AS cur, SUM(cost_native) AS s
     FROM v_record_cost WHERE ${QUOTA_SOURCES_SQL}${costScope}
     GROUP BY date, cur`
  ).all(...params);
  const costByDate = new Map();
  for (const r of costRows) {
    if (!costByDate.has(r.date)) costByDate.set(r.date, []);
    costByDate.get(r.date).push(r);
  }
  return rows.map((r) => ({ ...r, cost: sumCostByCurrency(costByDate.get(r.date) || []) }));
}

function getAggregate(mode, dim, from, to, source = null) {
  // 设备维度按 device_id 分组，避免两台同名电脑被合并；展示名取 device_name（同 ID 行名一致，upsertDevice 已保证）
  const isDevice = dim === "device";
  const dimCol = isDevice ? "device_id" : dim === "provider" ? "provider_id" : dim === "source" ? "source" : "model_id";
  const dimSel = isDevice ? `${dimCol} AS k, MAX(device_name) AS kName` : `${dimCol} AS k`;
  const extra = extraExpr(mode);
  const rows = get().prepare(
    `SELECT ${dimSel},
            SUM(input_tokens + output_tokens${extra}) AS total,
            SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
            SUM(reasoning_tokens) AS reasoningTokens, SUM(cache_read_tokens) AS cacheReadTokens,
            SUM(cache_creation_tokens) AS cacheCreationTokens, COUNT(*) AS count
     FROM usage_record
     WHERE (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at <= ?)
       ${source ? "AND source = ?" : ""}
     GROUP BY k ORDER BY total DESC`
  ).all(from, from, to, to, ...(source ? [source] : []));
  // 各维度费用（按币种分组换算）与未配置计数
  const costRows = get().prepare(
    `SELECT ${dimCol} AS k, cost_currency AS cur, SUM(cost_native) AS s,
            SUM(CASE WHEN price_id IS NULL AND (input_tokens + output_tokens + reasoning_tokens) > 0 THEN 1 ELSE 0 END) AS unpriced
     FROM v_record_cost
     WHERE ${QUOTA_SOURCES_SQL} AND (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at <= ?)
       ${source ? "AND source = ?" : ""}
     GROUP BY k, cur`
  ).all(from, from, to, to, ...(source ? [source] : []));
  const costByKey = new Map();
  for (const r of costRows) {
    if (!costByKey.has(r.k)) costByKey.set(r.k, { s: 0, unpriced: 0 });
    const e = costByKey.get(r.k);
    e.s += toDisplay(r.s, r.cur);
    e.unpriced += r.unpriced;
  }
  return rows.map((r) => {
    const e = costByKey.get(r.k) || { s: 0, unpriced: 0 };
    return {
      key: r.kName || r.k,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTokens: r.reasoningTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      totalTokens: r.total,
      count: r.count,
      cost: e.s,
      unpricedRecords: e.unpriced,
    };
  });
}

/** 行 → UsageRecord（camelCase）；cost* 字段仅来自 v_record_cost 的查询（getRecordsByDay 无此列，导出 undefined） */
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
    costNative: row.costNative ?? undefined,
    costCurrency: row.costCurrency ?? undefined,
    costDisplay: row.costDisplay ?? undefined,
    priced: row.priced === undefined ? undefined : !!row.priced,
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

// 明细页查询列：在原始记录列上追加按记录计价的费用（price_id 为空即未配置价格）；
// costDisplay 换算在 JS 层用 toDisplay 完成（与聚合同一换算来源）
const RECORD_SELECT = `
    SELECT id, device_id AS deviceId, device_name AS deviceName, source, provider_id AS providerId,
           model_id AS modelId, variant, task_type AS taskType, session_id AS sessionId, agent, mode,
           input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
           cache_creation_tokens AS cacheCreationTokens, cache_read_tokens AS cacheReadTokens,
           started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, status,
           cost_native AS costNative, cost_currency AS costCurrency,
           (price_id IS NOT NULL) AS priced
    FROM v_record_cost`;

function getRecords(filter = {}) {
  const { whereStr, params } = buildRecordFilter(filter);

  const total = get().prepare(`SELECT COUNT(*) AS c FROM usage_record${whereStr}`).get(...params).c;

  const dataSql = `${RECORD_SELECT}${whereStr} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
  const records = get().prepare(dataSql).all(...params, filter.limit ?? 50, filter.offset ?? 0)
    .map(rowToRecord)
    .map((r) => {
      if (r.costNative != null && r.costCurrency) r.costDisplay = toDisplay(r.costNative, r.costCurrency);
      return r;
    });

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
  return get().prepare(`${RECORD_SELECT}${whereStr} ORDER BY started_at ASC`)
    .all(...params)
    .map(rowToRecord)
    .map((r) => {
      if (r.costNative != null && r.costCurrency) r.costDisplay = toDisplay(r.costNative, r.costCurrency);
      return r;
    });
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
  // 费用列按显示币种保留 6 位小数（单条记录费用常为小额，4 位以内会大量截断为 0）
  const head = "时间,设备,软件源,模型,供应商,输入,输出,推理,缓存命中,缓存写入,状态,费用";
  const rows = records.map((r) =>
    [fmtLocal(r.startedAt), r.deviceName, r.source, r.modelId, r.providerId,
     r.inputTokens, r.outputTokens, r.reasoningTokens, r.cacheReadTokens, r.cacheCreationTokens, r.status,
     r.priced ? (r.costDisplay ?? 0).toFixed(6) : ""]
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
  // 计费
  setBillingFx,
  savePrice, deleteModelPrices,
  listAllPrices, listCurrentPrices, listPriceVersions, listUnpricedModels,
  replacePrices, applyRemotePricing,
};
