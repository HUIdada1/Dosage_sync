// Electron 主进程入口：窗口 / 托盘 / 单实例 / 定时调度
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification } = require("electron");
const config = require("./backend/config.cjs");
const db = require("./backend/db.cjs");
const sync = require("./backend/sync.cjs");
const scheduler = require("./backend/scheduler.cjs");
const ipc = require("./backend/ipc.cjs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:1420";

let mainWindow = null;
let tray = null;
let quitting = false;

/** 资源目录：打包后为 process.resourcesPath 的相邻 build，开发时为项目 build/ */
function buildDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "build") : path.join(__dirname, "..", "build");
}

function iconPath(name) {
  const p = path.join(buildDir(), name);
  try {
    return nativeImage.createFromPath(p);
  } catch {
    return nativeImage.createEmpty();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: "用量同步",
    icon: iconPath("icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_URL);
  }

  // 关闭 → 最小化到托盘（除非真正退出）
  mainWindow.on("close", (e) => {
    const cfg = config.loadConfig();
    if (!quitting && cfg.schedule && cfg.schedule.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function triggerSync() {
  const cfg = config.loadConfig();
  sync.run(cfg).catch((e) => {
    console.error("[sync]", e);
  });
}

/** 今日用量摘要（托盘菜单用），无数据时返回 null */
function todaySummary() {
  try {
    const cfg = config.loadConfig();
    const s = db.getSummary(cfg.totalMode || "full");
    return s && s.todayTokens >= 0 ? s.todayTokens : null;
  } catch {
    return null;
  }
}

/** 托盘菜单（动态构建：含今日用量摘要 + 暂停/恢复） */
function buildTrayMenu() {
  const today = todaySummary();
  const todayLabel = today != null ? `今日用量 ${formatNum(today)} token` : "今日用量 —";
  return Menu.buildFromTemplate([
    { label: todayLabel, enabled: false },
    { type: "separator" },
    { label: "显示主界面", click: showWindow },
    { label: "立即同步", click: triggerSync },
    { label: scheduler.isPaused() ? "恢复定时同步" : "暂停定时同步", click: () => { scheduler.setPaused(!scheduler.isPaused()); refreshTrayMenu(); } },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

/** 桌面通知：默认仅同步失败提醒，设置页可开启「成功也通知」；失败持续期间不重复弹，状态翻转才弹 */
let lastNotifiedOk = null;
function notifySync(ok, message) {
  try {
    refreshTrayMenu(); // 同步结束后刷新托盘「今日用量摘要」
    if (!Notification.isSupported()) return;
    const cfg = config.loadConfig();
    if (ok) {
      lastNotifiedOk = true;
      if (!(cfg.schedule && cfg.schedule.notifyOnSuccess)) return;
    } else {
      // 失败持续中（上次通知的也是失败）不重复打扰；首次失败/失败恢复后再失败才提醒
      if (lastNotifiedOk === false) return;
      lastNotifiedOk = false;
    }
    const n = new Notification({
      title: ok ? "用量同步完成" : "用量同步失败",
      body: message || (ok ? "本机用量已上传并拉取最新数据" : "请检查 WebDAV 配置"),
      icon: iconPath("icon.png"),
    });
    n.show();
  } catch {
    /* 通知失败静默 */
  }
}

function createTray() {
  const icon = iconPath("tray.png");
  tray = new Tray(icon.isEmpty() ? iconPath("icon.png") : icon);
  tray.setToolTip("用量同步");
  refreshTrayMenu();
  tray.on("double-click", showWindow);
}

// ===== 单实例锁 =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    // 初始化本地库（惰性打开）
    db.get();
    // 确保本机设备在启动时即存在（即使从未同步），设备列表/本机口径立即可用
    const cfg0 = config.loadConfig();
    const localId0 = sync.ensureLocalDeviceId(cfg0);
    db.upsertDevice(localId0, cfg0.deviceName || "这台电脑", sync.enabledSourceIds(cfg0).join(","), db.getLastSyncAt(localId0));

    ipc.register({ ipcMain, app, shell });
    sync.setOnFinish(notifySync);
    createWindow();
    createTray();
    scheduler.start();

    // 依据配置启用开机自启（便携版不支持：注册的会是临时解压副本路径，退出即失效）
    const cfg = config.loadConfig();
    if (cfg.schedule && cfg.schedule.autoStart && !config.isPortable()) {
      app.setLoginItemSettings({ openAtLogin: true });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    scheduler.stop();
  });

  app.on("window-all-closed", () => {
    // Windows 下常驻托盘，不随窗口关闭退出
  });
}
