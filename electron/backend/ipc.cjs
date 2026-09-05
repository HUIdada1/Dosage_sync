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

/** 数据源在配置中的启用状态 */
function sourceEnabled(cfg, id) {
  const s = (cfg.sources || []).find((item) => item.source === id);
  return !!s && s.enabled;
}

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
  // 来源清单（唯一事实源是各适配器的 name 字段；前端顶栏/空状态/设置页均由此渲染）
  ipcMain.handle("list_sources", () => {
    const cfg = config.loadConfig();
    return adapter.sources.map((s) => ({ id: s.id, name: s.name, enabled: sourceEnabled(cfg, s.id) }));
  });

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
        name: s.name,
        detected: !!dir,
        dataDir: dir,
        readable: dir ? s.validate(dir) : false,
        lastSyncAt,
      };
    });
  });

  // ===== 汇总查询 =====
  ipcMain.handle("get_summary", (_e, args) => db.getSummary(args.mode, args.deviceId, args.source));
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

  // 删除退役设备：先删 WebDAV 远端数据（失败即中止，防止下次同步把数据拉回），再清本地记录
  ipcMain.handle("delete_device", async (_e, args) => {
    const deviceId = args && args.deviceId;
    try {
      if (!deviceId || typeof deviceId !== "string") return { ok: false, message: "缺少设备 ID" };
      const localId = db.getLocalDeviceId();
      if (deviceId === localId) return { ok: false, message: "本机设备不能删除" };
      // 同步进行中拒绝删除：否则已合并的该设备数据会在本次同步尾段被重新写回
      if (sync.progress().running) return { ok: false, message: "同步正在进行中，请稍后再删除设备" };
      const cfg = config.loadConfig();
      if (cfg.webdav && cfg.webdav.endpoint) {
        await webdav.remove(
          webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${sync.DEVICES_DIR}/${deviceId}.json`),
          cfg.webdav
        );
        await webdav.remove(
          webdav.joinUrl(cfg.webdav.endpoint, cfg.webdav.root, `${sync.DATA_DIR}/${deviceId}`),
          cfg.webdav
        );
      }
      db.deleteDeviceData(deviceId);
      db.addLog("merge", "info", `已删除退役设备 ${deviceId}（本地记录与 WebDAV 数据）`);
      return { ok: true, message: "设备已删除" };
    } catch (e) {
      return { ok: false, message: `删除设备失败：${e.message}` };
    }
  });

  // ===== 导出 =====
  ipcMain.handle("export_data", async (_e, args) => {
    try {
      const ext = args.format === "json" ? "json" : "csv";
      // filter 为空对象/缺省时导出全部明细；DetailView 会传当前筛选条件与日期范围
      const filter = args.filter && typeof args.filter === "object" ? args.filter : {};
      const content = args.format === "json" ? db.exportJson(filter) : db.exportCsv(filter);
      const dir = app.getPath("downloads");
      // 文件名精确到毫秒，避免同一秒内多次导出互相覆盖
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      const file = path.join(dir, `dosage-export-${stamp}.${ext}`);
      // CSV 加 UTF-8 BOM，Excel 打开中文不乱码；JSON 无需 BOM
      const buf = args.format === "json" ? content : "\uFEFF" + content;
      await fs.promises.writeFile(file, buf, "utf8");
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

  ipcMain.handle("get_is_portable", () => config.isPortable());

  // 清空本地缓存：删除本地明细与增量记账，远端 WebDAV 数据不动，下次同步自动重拉重建
  ipcMain.handle("reset_local_cache", () => {
    try {
      if (sync.progress().running) return { ok: false, message: "同步正在进行中，请稍后再清空" };
      db.clearLocalCache(db.getLocalDeviceId());
      db.addLog("merge", "info", "已清空本地缓存（WebDAV 数据不受影响，下次同步将自动重拉）");
      return { ok: true, message: "本地缓存已清空" };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("set_autostart", (_e, args) => {
    // 便携版兜底拒绝（设置页已禁用开关）：注册的会是临时解压副本路径，退出即失效
    if (config.isPortable()) return null;
    app.setLoginItemSettings({ openAtLogin: !!args.enabled });
    return null;
  });
}

module.exports = { register };
