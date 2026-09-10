// 软件更新（主进程侧）
// - 安装版：electron-updater 官方通道（latest.yml + NSIS 静默安装），下载/安装均由用户触发；
//   下载完成后退出的静默安装由 main.cjs 的 before-quit 钩子接管（electron-updater 默认的
//   autoInstallOnAppQuit 会弹安装向导，故关闭并自行处理）。
// - 便携版：不支持自动更新，仅读 GitHub latest.yml 直链比对版本，检测到新版提示手动下载。
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Notification, nativeImage, shell } = require("electron");
const config = require("./config.cjs");

const GITHUB_REPO_URL = "https://github.com/HUIdada1/Dosage_sync";
const GITHUB_RELEASES_URL = GITHUB_REPO_URL + "/releases";
// latest.yml 由 electron-builder 生成并上传到每个 Release，latest 直链恒定指向最新版（无需 API、无限流）
const LATEST_YML_URL = GITHUB_RELEASES_URL + "/latest/download/latest.yml";
// 自动检查频率：启动 60 秒后首次（避开启动期与 WebDAV 同步并发），之后每 6 小时
// （发版周期为天/周级，6 小时保证当天使用能收到提示，又不产生无意义请求）
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 手动检查防抖：30 秒内重复点击直接忽略
const MANUAL_COOLDOWN_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  // electron-updater 未打入包（异常构建）时降级：安装版检查直接报错并提示手动更新
}

let status = idleStatus(); // 模块加载即初始化，防御 init 前被 IPC 调用的时序
let lastManualCheckAt = 0;
let installTriggered = false; // 静默安装只触发一次（quitAndInstall 内部会再次 app.quit()，需防重入）
let currentCheckIsManual = false; // 本次检查来源：手动检查用户正看着设置页，不弹「发现新版本」通知
let timer = null;
let trayRefresh = null; // main.cjs 注入：托盘菜单刷新
let showWindow = null; // main.cjs 注入：显示主窗口

function idleStatus() {
  return {
    // idle | checking | up-to-date | available | downloading | downloaded | error
    status: "idle",
    isPortable: config.isPortable(),
    currentVersion: app.getVersion(),
    latestVersion: "",
    percent: 0,
    notes: "",
    message: "",
  };
}

/** 通知图标：打包后位于 resources/build，开发时位于项目 build/ */
function notifyIcon() {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, "build", "icon.png")
      : path.join(__dirname, "..", "..", "build", "icon.png");
    return nativeImage.createFromPath(p);
  } catch {
    return nativeImage.createEmpty();
  }
}

/** 系统通知（小提示，不弹模态框）；点击跳转到设置页的更新卡片 */
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: notifyIcon() });
  n.on("click", () => {
    broadcast({ event: "focus-update" });
    if (showWindow) showWindow();
  });
  n.show();
}

/** 状态变化广播给所有渲染窗口；payload 为 { event, ...状态字段 } */
function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("update:event", payload);
  }
}

/** 更新状态并广播 + 刷新托盘菜单 */
function setState(state, extra = {}) {
  status = { ...status, ...extra, status: state };
  broadcast({ event: "state", ...status });
  if (trayRefresh) trayRefresh();
}

/** 自动检查开关：每次读盘，设置页改动即时生效 */
function autoCheckEnabled() {
  try {
    const cfg = config.loadConfig();
    return !!(cfg.update && cfg.update.autoCheck);
  } catch {
    return true;
  }
}

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等返回 0 */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** electron-updater 的 releaseNotes 可能是字符串或数组，统一为纯文本 */
function toNotes(releaseNotes) {
  if (typeof releaseNotes === "string") return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((r) => (r && typeof r.note === "string" ? r.note : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 发现新版本通知（仅自动检查触发；手动检查用户正看着设置页，不弹）。
 *  去重持久化在 config.json 的 update.notifiedVersion，同一版本跨会话只提醒一次。 */
function notifyAvailable(version) {
  if (config.getUpdateNotified() === version) return;
  config.setUpdateNotified(version);
  if (config.isPortable()) {
    notify("检测到新版本 " + version, "便携版不支持自动更新，请前往 GitHub 手动下载");
  } else {
    notify("发现新版本 " + version, "点击查看更新内容，可在设置页下载更新");
  }
}

/** 检查/下载/安装失败的统一收口（electron-updater 的 error 事件驱动，按当前阶段生成文案）：
 *  提示用户自行去 GitHub 手动更新，避免应用内重试无门 */
function onUpdateError(e) {
  const msg = e && e.message ? e.message : String(e || "未知错误");
  const action =
    status.status === "checking" ? "检查更新失败" :
    status.status === "downloading" ? "下载更新失败" : "更新失败";
  setState("error", { message: `${action}：${msg}。请前往 GitHub 手动下载更新` });
}

// ===== 安装版：electron-updater =====

function checkInstalled() {
  if (!app.isPackaged) {
    // 开发模式不参与更新（electron-updater 要求打包产物 + latest.yml）
    setState("up-to-date", { message: "开发模式不检查更新" });
    return status;
  }
  if (!autoUpdater) {
    setState("error", { message: "更新组件缺失，请前往 GitHub 手动下载更新" });
    return status;
  }
  setState("checking");
  // 错误统一由 error 事件收口（electron-updater 内部先 emit 再 reject），此处仅防 unhandled rejection
  autoUpdater.checkForUpdates().catch(() => {});
  return status;
}

// ===== 便携版：latest.yml 直链比对 =====
// 注意：主进程 fetch 不走系统代理（与渲染层网络不同），网络受限环境可能检查失败；
// 失败时置 error 状态提示前往 GitHub 手动更新，不影响应用其它功能。

async function checkPortable() {
  setState("checking");
  try {
    const res = await fetch(LATEST_YML_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const m = text.match(/^version:\s*([^\s]+)/m);
    if (!m) throw new Error("版本信息格式异常");
    const latest = m[1].trim();
    if (compareVersions(latest, app.getVersion()) > 0) {
      setState("available", { latestVersion: latest, notes: "", message: "便携版不支持自动更新" });
      if (!currentCheckIsManual) notifyAvailable(latest);
    } else {
      setState("up-to-date");
    }
  } catch (e) {
    onUpdateError(e, "检查更新失败");
  }
  return status;
}

/** 检查入口：manual=true 为设置页手动触发（带 30 秒防抖），否则为定时自动触发 */
function check(manual) {
  if (status.status === "checking") return status;
  if (manual) {
    const now = Date.now();
    if (now - lastManualCheckAt < MANUAL_COOLDOWN_MS) {
      // 防抖：写入瞬时提示（下次状态变化即被覆盖），避免用户误以为按钮没反应
      setState(status.status, { message: "刚刚检查过，请稍后再试" });
      return status;
    }
    lastManualCheckAt = now;
  }
  currentCheckIsManual = !!manual;
  if (config.isPortable()) return checkPortable();
  return checkInstalled();
}

/** 下载更新（仅 available 状态有效，用户点击触发） */
function download() {
  if (config.isPortable() || status.status !== "available" || !autoUpdater) return status;
  autoUpdater.downloadUpdate().catch(() => {});
  return status;
}

/** 静默安装并重启（quitAndInstall 内部会再次触发 app.quit()，用 installTriggered 防重入） */
function triggerInstall() {
  if (installTriggered || !autoUpdater || status.status !== "downloaded") return;
  installTriggered = true;
  autoUpdater.quitAndInstall(true, true); // isSilent：不弹安装向导；isForceRunAfter：装完自动重启
  // 兜底：安装器启动失败（杀软拦截/文件损坏）时 electron-updater 只发 error 事件、不会退出应用，
  // 若数秒后进程仍在运行，复位标志并报错，避免「退出被吞 + 本会话无法再装」的死锁
  setTimeout(() => {
    if (!app.isQuiting && installTriggered) {
      installTriggered = false;
      onUpdateError(new Error("安装程序未能启动"));
    }
  }, 10 * 1000);
}

/** before-quit 钩子判定：已下载完成且尚未触发安装 */
function pendingInstall() {
  return !installTriggered && status.status === "downloaded" && !!autoUpdater && !config.isPortable();
}

/** 托盘菜单提示项数据 */
function trayHint() {
  const has = status && (status.status === "available" || status.status === "downloaded") && status.latestVersion;
  return { hasUpdate: !!has, latestVersion: has || "" };
}

/** 打开 GitHub Releases 页（便携版手动下载 / 失败兜底入口） */
function openReleases() {
  shell.openExternal(GITHUB_RELEASES_URL);
}

/** 打开 GitHub 仓库主页（设置页常驻地址按钮） */
function openRepo() {
  shell.openExternal(GITHUB_REPO_URL);
}

/** 托盘「发现新版本」入口：打开主窗口并让前端切到设置页更新卡片 */
function focusUpdate() {
  if (showWindow) showWindow();
  broadcast({ event: "focus-update" });
}

function bindUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => setState("checking"));
  autoUpdater.on("update-available", (info) => {
    setState("available", { latestVersion: info.version, notes: toNotes(info.releaseNotes), percent: 0 });
    if (!currentCheckIsManual) notifyAvailable(info.version);
  });
  autoUpdater.on("update-not-available", () => setState("up-to-date"));
  autoUpdater.on("download-progress", (p) => {
    setState("downloading", { percent: Number.isFinite(p.percent) ? Math.round(p.percent) : 0 });
  });
  autoUpdater.on("update-downloaded", () => {
    setState("downloaded", { percent: 100 });
    notify("新版本已就绪", "退出应用时自动安装，也可在设置页立即重启安装");
  });
  autoUpdater.on("error", (e) => onUpdateError(e));
}

/**
 * 初始化：绑定事件并启动定时检查。
 * 「发现新版本」通知只在自动检查（currentCheckIsManual=false）时弹；手动检查由设置页按钮
 * 触发，用户正看着状态变化，不弹通知。
 */
function init(opts) {
  trayRefresh = (opts && opts.onTrayRefresh) || null;
  showWindow = (opts && opts.onShowWindow) || null;
  status = idleStatus();
  if (autoUpdater) {
    autoUpdater.autoDownload = false; // 下载由用户在设置页触发
    autoUpdater.autoInstallOnAppQuit = false; // 退出安装自行接管（默认实现会弹安装向导）
    bindUpdaterEvents();
  }
  // 开发模式不参与更新，不启动定时器（打包环境才跑「启动 60 秒 + 每 6 小时」）
  if (app.isPackaged) timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
}

function tick() {
  if (autoCheckEnabled() && status.status !== "downloading" && status.status !== "downloaded") {
    check(false);
  }
  timer = setTimeout(tick, CHECK_INTERVAL_MS);
}

function getStatus() {
  return status || idleStatus();
}

module.exports = {
  init, check, download, triggerInstall, pendingInstall, getStatus, trayHint, openReleases, openRepo, focusUpdate,
};
