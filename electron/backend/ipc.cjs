// IPC 命令注册：主进程 ipcMain.handle 处理器，对应前端 src/api/ipc.ts 的 21 个命令
// 每个 handler 返回 camelCase 结构，与前端类型一致
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const config = require("./config.cjs");
const db = require("./db.cjs");
const adapter = require("./adapter.cjs");
const webdav = require("./webdav.cjs");
const sync = require("./sync.cjs");

const SOURCE_META = {
  zcode: { name: "ZCode" },
  codex: { name: "Codex" },
  dsh: { name: "DeepSeek Harness" },
  antigravity: { name: "Antigravity" },
  "antigravity-ide": { name: "Antigravity IDE" },
};

/** 注册所有 IPC handler。ctx = { ipcMain, app, shell } */
function register(ctx) {
  const { ipcMain, app, shell } = ctx;

  // ===== 配置 =====
  ipcMain.handle("load_config", () => config.loadConfig());

  ipcMain.handle("save_config", (_e, args) => {
    try {
      config.saveConfig(args.config);
      const localId = db.getLocalDeviceId();
      if (localId && args.config && args.config.deviceName) {
        const sources = sync.enabledSourceIds(args.config).join(",");
        db.upsertDevice(localId, args.config.deviceName, sources, db.getLastSyncAt(localId));
      }
      return { ok: true, message: "设置保存成功" };
    } catch (e) {
      return { ok: false, message: `设置保存失败：${e.message}` };
    }
  });

  ipcMain.handle("test_webdav", async (_e, args) => {
    try {
      return await webdav.test(args.config);
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ===== 数据源 =====
  ipcMain.handle("detect_source", (_e, args) => {
    const src = adapter.byId(args.source);
    if (!src) return { ok: false, path: null, deviceId: null };
    const dir = src.detect();
    if (!dir) return { ok: false, path: null, deviceId: null };
    return { ok: src.validate(dir), path: dir, deviceId: src.getDeviceId(dir) };
  });

  ipcMain.handle("health_source", () => {
    const cfg = config.loadConfig();
    const localId = db.getLocalDeviceId();
    const lastSyncAt = localId ? db.getLastSyncAt(localId) : null;
    return adapter.sources.map((s) => {
      const sourceCfg = (cfg.sources || []).find((item) => item.source === s.id);
      const dir = sourceCfg?.dataDir || s.detect();
      return {
        source: s.id,
        name: (SOURCE_META[s.id] || {}).name || s.id,
        detected: !!dir,
        dataDir: dir,
        readable: dir ? s.validate(dir) : false,
        lastSyncAt,
      };
    });
  });

  // ===== 汇总查询 =====
  ipcMain.handle("get_summary", (_e, args) => db.getSummary(db.getLocalDeviceId(), args.mode, args.deviceId, args.source));
  ipcMain.handle("get_trend", (_e, args) => db.getTrend(args.mode, args.days, args.deviceId, args.source));
  ipcMain.handle("get_heatmap", (_e, args) => db.getHeatmap(args.mode, args.start, args.end, args.deviceId, args.source));
  ipcMain.handle("get_aggregate", (_e, args) => db.getAggregate(args.mode, args.dim, args.from, args.to, args.source));
  ipcMain.handle("get_device_breakdowns", (_e, args) => db.getDeviceBreakdowns(db.getLocalDeviceId(), args.mode, args.deviceId, args.source));
  ipcMain.handle("get_records", (_e, args) => db.getRecords(args));

  // ===== 同步 =====
  // 后台运行：start_sync 立即返回，渲染进程通过 get_sync_progress 轮询进度，
  // 避免 IPC handler 阻塞导致前端「转圈」停不下来。
  ipcMain.handle("start_sync", async () => {
    const cfg = config.loadConfig();
    sync.run(cfg).catch((e) => console.error("[sync]", e));
    return null;
  });

  ipcMain.handle("cancel_sync", () => {
    sync.cancel();
    return null;
  });

  ipcMain.handle("get_sync_progress", () => sync.progress());
  ipcMain.handle("get_sync_logs", () => db.getLogs());
  ipcMain.handle("clear_sync_logs", () => {
    db.clearLogs();
    return null;
  });

  // 设备列表：确保本机设备始终存在（即使从未同步、未配置 WebDAV）
  ipcMain.handle("get_devices", (_e, args) => {
    const cfg = config.loadConfig();
    const localId = sync.ensureLocalDeviceId(cfg);
    db.upsertDevice(localId, cfg.deviceName || "这台电脑", sync.enabledSourceIds(cfg).join(","), db.getLastSyncAt(localId));
    return db.getDevices(localId, args.mode, args.source);
  });

  // ===== 导出 =====
  ipcMain.handle("export_data", (_e, args) => {
    try {
      const ext = args.format === "json" ? "json" : "csv";
      const content = args.format === "json"
        ? db.exportJson(args.from, args.to)
        : db.exportCsv(args.from, args.to);
      const dir = app.getPath("downloads");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = path.join(dir, `dosage-export-${stamp}.${ext}`);
      // CSV 加 UTF-8 BOM，Excel 打开中文不乱码；JSON 无需 BOM
      const buf = args.format === "json" ? content : "\uFEFF" + content;
      fs.writeFileSync(file, buf, "utf8");
      return { ok: true, path: file, message: "导出成功" };
    } catch (e) {
      return { ok: false, path: null, message: e.message };
    }
  });

  // ===== 其它 =====
  ipcMain.handle("open_data_dir", async () => {
    const dir = config.dataDir();
    await shell.openPath(dir);
    return null;
  });

  ipcMain.handle("get_data_dir", () => config.dataDir());

  ipcMain.handle("get_app_version", () => app.getVersion());

  // 模型元数据：当前 UI 未消费，预留空表（后续接入价格/档位展示）
  ipcMain.handle("get_model_metas", () => ({}));

  ipcMain.handle("set_autostart", (_e, args) => {
    app.setLoginItemSettings({ openAtLogin: !!args.enabled });
    return null;
  });
}

module.exports = { register };
