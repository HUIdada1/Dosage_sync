// IPC 命令注册：主进程 ipcMain.handle 处理器，对应前端 src/api/ipc.ts 的 45 个命令
// 每个 handler 返回 camelCase 结构，与前端类型一致
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const config = require("./config.cjs");
const db = require("./db.cjs");
const adapter = require("./adapter.cjs");
const webdav = require("./webdav.cjs");
const sync = require("./sync.cjs");
const billing = require("./billing.cjs");
const updater = require("./updater.cjs");

/** 把计费显示币种/汇率注入查询层（load/save 配置后调用，汇率改动即时生效） */
function applyBillingFx(cfg) {
  const b = (cfg && cfg.billing) || {};
  db.setBillingFx(b.displayCurrency, b.usdToCny);
}

/** 数据源在配置中的启用状态 */
function sourceEnabled(cfg, id) {
  const s = (cfg.sources || []).find((item) => item.source === id);
  return !!s && s.enabled;
}

/** 注册所有 IPC handler。ctx = { ipcMain, app, shell } */
function register(ctx) {
  const { ipcMain, app, shell } = ctx;

  // ===== 配置 =====
  ipcMain.handle("load_config", () => {
    const cfg = config.loadConfig();
    applyBillingFx(cfg);
    // 密码不回传明文：渲染进程只拿掩码，防止渲染层注入/调试口读取 WebDAV 凭据
    if (cfg.webdav) cfg.webdav.password = cfg.webdav.password ? config.PASSWORD_MASK : "";
    return cfg;
  });

  ipcMain.handle("save_config", (_e, args) => {
    try {
      // 掩码 = 用户未修改密码：回填磁盘上的真实密码后再保存
      if (args.config && args.config.webdav && args.config.webdav.password === config.PASSWORD_MASK) {
        args.config.webdav.password = config.loadConfig().webdav.password;
      }
      config.saveConfig(args.config);
      applyBillingFx(args.config);
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
      // 掩码密码回填真实值再测试（用户未改密码时界面传回的是掩码）。
      // 独立配置快照：不走同步的取消信号，避免测试连接被「取消同步」误伤
      const saved = config.loadConfig().webdav;
      const testCfg = { ...(args.config || {}) };
      if (testCfg.password === config.PASSWORD_MASK) testCfg.password = saved.password;
      return await webdav.test(testCfg);
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ===== 数据源 =====
  // 来源清单（唯一事实源是各适配器的 name 字段；前端顶栏/空状态/设置页均由此渲染）
  // 返回顺序遵循 config.sourceVisibility.order，并带 visible 字段供顶栏显隐
  ipcMain.handle("list_sources", () => {
    const cfg = config.loadConfig();
    const vis = (cfg.sourceVisibility || { order: [], hidden: [] });
    const hidden = new Set(vis.hidden || []);
    const order = vis.order || [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return adapter.sources
      .map((s) => ({
        id: s.id,
        name: s.name,
        enabled: sourceEnabled(cfg, s.id),
        visible: !hidden.has(s.id),
      }))
      .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
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
      const hasRemote = !!(cfg.webdav && cfg.webdav.endpoint && String(cfg.webdav.endpoint).trim());
      if (hasRemote) {
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
      db.addLog("merge", "info", hasRemote ? `已删除退役设备 ${deviceId}（本地记录与 WebDAV 数据）` : `已删除退役设备 ${deviceId} 的本地记录（未配置 WebDAV，远端未动）`);
      // 未配置 WebDAV 时只删了本地：若远端仍存有该设备数据，重新配置后会全量拉回（merged 记账已随删除清空）
      return {
        ok: true,
        message: hasRemote
          ? "设备已删除"
          : "设备本地记录已删除；未配置 WebDAV，若远端存有该设备数据，重新配置并同步后会再次拉取",
      };
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
      const { content, count } = args.format === "json" ? db.exportJson(filter) : db.exportCsv(filter);
      const dir = app.getPath("downloads");
      // 文件名精确到毫秒，避免同一秒内多次导出互相覆盖
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      const file = path.join(dir, `dosage-export-${stamp}.${ext}`);
      // CSV 加 UTF-8 BOM，Excel 打开中文不乱码；JSON 无需 BOM
      const buf = args.format === "json" ? content : "\uFEFF" + content;
      await fs.promises.writeFile(file, buf, "utf8");
      // 空结果集明确提示（导出文件仍生成，仅含表头/空数组）
      return { ok: true, path: file, message: count > 0 ? `导出成功（${count} 条记录）` : "导出成功，但当前筛选条件下没有任何记录" };
    } catch (e) {
      return { ok: false, path: null, message: `导出失败：${e.message}` };
    }
  });

  // ===== 计费 =====
  ipcMain.handle("get_prices", () => db.listCurrentPrices());

  ipcMain.handle("get_price_versions", (_e, args) => db.listPriceVersions(args.providerId || null, args.modelId));

  ipcMain.handle("save_price", (_e, args) => {
    try {
      const cfg = config.loadConfig();
      db.savePrice(args.price, cfg.deviceName || "这台电脑");
      return { ok: true, message: "价格已保存，历史费用已按新版本重算" };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("delete_model_prices", (_e, args) => {
    try {
      db.deleteModelPrices(args.providerId || null, args.modelId);
      return { ok: true, message: `已删除 ${args.modelId} 的全部价格版本` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle("get_unpriced_models", () => db.listUnpricedModels());

  ipcMain.handle("pull_remote_pricing", async (_e, args) => {
    try {
      const cfg = config.loadConfig();
      const rp = (cfg.billing && cfg.billing.remotePricing) || {};
      if (!rp.url) return { ok: false, message: "未配置拉取网址" };
      const r = await billing.pullRemotePricing({
        url: rp.url, hashUrl: rp.hashUrl, proxy: cfg.billing.importProxy || "", force: !!(args && args.force),
      });
      if (r.action === "unchanged") return { ok: true, message: "远程价格源无变化，本地价格已是最新" };
      if (r.action === "skipped") return { ok: false, message: r.reason || "已跳过" };
      return { ok: true, message: `拉取完成：新增 ${r.added} · 调价 ${r.updated} · 未变 ${r.skipped}（本地 ${r.models} 个模型命中，远端共 ${r.total} 个）` };
    } catch (e) {
      return { ok: false, message: `拉取失败：${e.message}` };
    }
  });

  ipcMain.handle("get_remote_pricing_status", () => {
    const cfg = config.loadConfig();
    const rp = (cfg.billing && cfg.billing.remotePricing) || {};
    const st = billing.getRemotePricingStatus();
    return { ...rp, ...st };
  });

  ipcMain.handle("import_prices_preview", async (_e, args) => {
    try {
      const cfg = config.loadConfig();
      const proxy = (cfg.billing && cfg.billing.importProxy) || "";
      return { ok: true, ...(await billing.previewImport(args.source, proxy)) };
    } catch (e) {
      return { ok: false, message: e.message, additions: [], changes: [], missing: [] };
    }
  });

  ipcMain.handle("import_prices_apply", (_e, args) => {
    try {
      const cfg = config.loadConfig();
      const n = billing.applyImport(args.items, args.effectiveFrom, cfg.deviceName || "这台电脑");
      return { ok: true, message: `已导入 ${n} 条价格，历史费用已重算` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ===== 其它 =====
  ipcMain.handle("open_data_dir", async () => {
    const dir = config.dataDir();
    await shell.openPath(dir);
    return null;
  });

  ipcMain.handle("get_data_dir", () => config.dataDir());

  // 数据缓存目录信息：当前目录 + 默认目录 + 是否已自定义（设置页「数据缓存目录」展示与校验用）
  ipcMain.handle("get_data_dir_info", () => {
    const custom = config.customDataDir();
    return {
      dataDir: config.dataDir(),
      defaultDataDir: config.defaultDataDir(),
      isCustom: !!custom,
    };
  });

  // 选择文件夹：弹出系统目录选择对话框（设置页「浏览」按钮）
  ipcMain.handle("browse_data_dir", async () => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({
      title: "选择数据缓存目录",
      defaultPath: config.dataDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: result.filePaths[0] };
  });

  // 设置数据缓存目录：校验 → （可选）迁移旧数据 → 保存自定义 → 返回结果（重启后生效）
  ipcMain.handle("set_data_dir", (_e, args) => {
    const target = args && args.path;
    const migrate = !!(args && args.migrate);
    try {
      // 同步进行中拒绝切换，避免写库过程中目录失效
      if (sync.progress().running) return { ok: false, message: "同步正在进行中，请稍后再修改目录" };
      const check = config.validateDataDir(target);
      if (!check.ok) return check;
      const newDir = check.resolved;
      const oldDir = config.dataDir();
      // 先记日志（写当前库）再迁移：迁移会复制旧库到新目录，这条日志随之进入新库
      db.addLog("merge", "info",
        migrate
          ? `数据缓存目录已迁移到 ${newDir}（原目录数据已复制，重启后生效）`
          : `数据缓存目录已更改为 ${newDir}（保留原目录，重启后生效）`);
      const migrated = migrate && config.migrateDataDir(oldDir, newDir);
      config.setCustomDataDir(newDir);
      return {
        ok: true,
        message: migrated
          ? `目录已更改并迁移缓存数据，重启应用后生效`
          : `目录已更改，重启应用后生效`,
        migrated,
        dataDir: newDir,
        defaultDataDir: config.defaultDataDir(),
      };
    } catch (e) {
      return { ok: false, message: `设置数据目录失败：${e.message}` };
    }
  });

  // 恢复默认数据缓存目录（清空自定义，回退 ~/.Dosage_sync）
  ipcMain.handle("reset_data_dir", () => {
    try {
      config.clearCustomDataDir();
      return { ok: true, message: "已恢复默认目录，重启应用后生效", dataDir: config.defaultDataDir(), defaultDataDir: config.defaultDataDir() };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

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

  // ===== 软件更新（详见 backend/updater.cjs：安装版 electron-updater，便携版仅提示手动更新） =====
  ipcMain.handle("get_update_status", () => updater.getStatus());

  ipcMain.handle("check_update", () => updater.check(true));

  ipcMain.handle("download_update", () => updater.download());

  ipcMain.handle("install_update", () => {
    updater.triggerInstall();
    return updater.getStatus();
  });

  // GitHub Releases 页：便携版手动下载 / 更新失败兜底入口
  ipcMain.handle("open_release_page", () => {
    updater.openReleases();
    return null;
  });

  // GitHub 仓库主页：设置页常驻地址按钮
  ipcMain.handle("open_repo_page", () => {
    updater.openRepo();
    return null;
  });
}

module.exports = { register };
