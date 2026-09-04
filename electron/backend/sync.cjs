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

// 重扫窗口：仅补抽最近 24h 的记录，避免每次全量
const RESCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

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

function utcDayKey(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shardByDay(records) {
  const map = new Map();
  for (const r of records) {
    const key = utcDayKey(r.startedAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
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
        // 锚点单调不回退：回扫窗口内无新记录时保持原锚点，避免每次倒退 24h
        let maxTs = anchor;
        for (const r of records) maxTs = Math.max(maxTs, r.startedAt);
        db.setAnchor(sourceId, maxTs);
        log("extract", "info", `${src.name} 获取完成：${records.length} 条记录（since=${sinceMs}）`);
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
      // 设备元数据
      const devMeta = { deviceId, deviceName, source: deviceSources, lastSyncAt: Date.now() };
      await webdav.put(
        webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DEVICES_DIR}/${deviceId}.json`),
        cfg.webdav,
        JSON.stringify(devMeta)
      );
      log("upload", "info", "设备信息上传完成");
      // 上传本地数据分片：全量覆盖写本机所有记录（按 deviceId 过滤），
      // 每个天分片以本机该天【全部】记录整体覆盖写（PUT 覆盖语义，幂等）。
      // 全量上传天然实现「离线队列自动补传」：只要本地库有数据，配置 WebDAV 后即补传。
      // 分片内容 gzip 压缩，文件名 *.jsonl.gz，减少传输体积。
      const allLocal = db.getRecords({ deviceId, limit: 100000 }).records;
      const dayShards = shardByDay(allLocal);
      await webdav.ensureDir(webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}`), cfg.webdav);
      let i = 0;
      for (const [day, dayRecs] of dayShards) {
        if (state.cancelled) return finish("cancelled");
        const payload = encodeShard(dayRecs);
        log("upload", "info", `压缩日分片 ${day}：${dayRecs.length} 条记录`);
        await webdav.put(
          webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${deviceId}/${day}.jsonl.gz`),
          cfg.webdav,
          payload
        );
        i++;
        emit({ percent: 30 + Math.floor((i / Math.max(dayShards.size, 1)) * 20) });
      }
      log("upload", "info", `已上传 ${dayShards.size} 个日分片（gzip）`);
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

      // 先枚举所有待拉分片，用于细分拉取进度
      const pending = [];
      for (const other of deviceFiles) {
        if (other === deviceId) continue;
        const dataDir = webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}/`);
        const files = await webdav.list(dataDir, cfg.webdav);
        for (const f of files) {
          if (f.isDir || !/\.jsonl(\.gz)?$/.test(f.name)) continue;
          pending.push({
            other,
            name: f.name,
            url: webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${DATA_DIR}/${other}/${f.name}`),
          });
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
        // 数据校验：过滤字段缺失、时间戳异常的无效数据
        const validRecs = recs.filter(
          (r) => r && typeof r.id === "string" && typeof r.deviceId === "string" && typeof r.startedAt === "number" && !isNaN(r.startedAt)
        );
        if (validRecs.length > 0) {
          db.insertRecords(validRecs);
        }
        fileCount++;
        if (!mergedDevices.has(p.other)) mergedDevices.add(p.other);
        emit({ percent: 55 + Math.floor((idx + 1) / Math.max(pending.length, 1) * 30) });
      }

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

module.exports = { run, cancel, progress, setOnFinish, ensureLocalDeviceId, enabledSourceIds, RESCAN_WINDOW_MS };
