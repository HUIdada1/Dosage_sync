// 配置与数据目录管理（Node 主进程侧）
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** 判断是否为便携模式：exe 同目录存在 portable.flag */
function isPortable() {
  try {
    const exeDir = path.dirname(process.execPath);
    return fs.existsSync(path.join(exeDir, "portable.flag"));
  } catch {
    return false;
  }
}

/** 数据目录：便携模式跟随 exe 目录，否则 %APPDATA%/DosageSync */
function dataDir() {
  let dir;
  if (isPortable()) {
    dir = path.join(path.dirname(process.execPath), "data");
  } else {
    const base = process.env.APPDATA || ".";
    dir = path.join(base, "DosageSync");
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 汇总库路径 */
function dbPath() {
  return path.join(dataDir(), "dosage-sync.sqlite");
}

/** 配置文件路径 */
function configPath() {
  return path.join(dataDir(), "config.json");
}

/** 默认配置（与前端 src/types/index.ts 及 stores/app.ts 保持一致） */
function defaultConfig() {
  return {
    deviceName: "这台电脑",
    webdav: {
      endpoint: "",
      username: "",
      password: "",
      root: "/dosage-sync",
      preset: "feiniu",
    },
    sources: [
      { source: "zcode", enabled: true, dataDir: null },
      { source: "codex", enabled: false, dataDir: null },
      { source: "dsh", enabled: false, dataDir: null },
      // 【暂时隐藏 Antigravity 系】
      // { source: "antigravity", enabled: false, dataDir: null },
      // { source: "antigravity-ide", enabled: false, dataDir: null },
    ],
    schedule: {
      hourly: false,
      hourlyInterval: 1,
      daily: false,
      dailyTime: "23:30",
      autoStart: false,
      minimizeToTray: true,
    },
    totalMode: "full",
    theme: "light",
    portableMode: false,
  };
}

/** 深合并：用默认配置补齐缺失字段，避免旧配置升级后缺键 */
function mergeConfig(def, cfg) {
  const out = { ...def };
  if (!cfg || typeof cfg !== "object") return out;
  for (const k of Object.keys(def)) {
    if (k in cfg) {
      const dv = def[k];
      const cv = cfg[k];
      if (dv && typeof dv === "object" && !Array.isArray(dv) && cv && typeof cv === "object") {
        out[k] = mergeConfig(dv, cv);
      } else {
        out[k] = cv;
      }
    }
  }
  return out;
}

/** 加载配置（不存在则返回默认） */
function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return defaultConfig();
  try {
    const text = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    const merged = mergeConfig(defaultConfig(), parsed);
    const configured = new Map(
      (Array.isArray(parsed.sources) ? parsed.sources : [])
        .filter((item) => item && typeof item === "object")
        .map((item) => [item.source, item])
    );
    merged.sources = defaultConfig().sources.map((fallback) => {
      const saved = configured.get(fallback.source);
      return saved
        ? {
            source: fallback.source,
            enabled: typeof saved.enabled === "boolean" ? saved.enabled : fallback.enabled,
            dataDir: typeof saved.dataDir === "string" && saved.dataDir ? saved.dataDir : null,
          }
        : fallback;
    });
    return merged;
  } catch (e) {
    // 配置损坏时回退默认，避免应用无法启动
    return defaultConfig();
  }
}

/** 保存配置 */
function saveConfig(cfg) {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

module.exports = { dataDir, dbPath, configPath, loadConfig, saveConfig, defaultConfig, isPortable };
