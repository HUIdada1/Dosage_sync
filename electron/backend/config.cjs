// 配置与数据目录管理（Node 主进程侧）
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Electron safeStorage（主进程可用；纯 Node 环境如脚本直跑时降级明文）
let safeStorage = null;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object" && electron.safeStorage) safeStorage = electron.safeStorage;
} catch {
  /* 非 Electron 环境 */
}

// 密文前缀：config.json 中 WebDAV 密码带此前缀表示经 safeStorage 加密（OS 级密钥，随系统用户绑定）
const ENC_PREFIX = "enc:v1:";

/** 明文 → 密文；safeStorage 不可用时原样返回（降级明文存储） */
function encryptPassword(plain) {
  if (!plain || typeof plain !== "string" || plain.startsWith(ENC_PREFIX)) return plain ?? "";
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return plain;
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString("base64");
  } catch {
    return plain;
  }
}

/** 密文 → 明文；解密失败（密文来自其他机器/系统用户）返回空串，需重新填写 */
function decryptPassword(stored) {
  if (!stored || typeof stored !== "string" || !stored.startsWith(ENC_PREFIX)) return stored ?? "";
  if (!safeStorage) return "";
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return "";
  }
}

/**
 * 便携模式基准目录（exe 所在目录），非便携返回 null。
 * electron-builder 便携版运行时把应用解压到 %TEMP% 且退出即删，process.execPath 指向临时副本；
 * 真正的 exe 目录由 portable stub 注入的 PORTABLE_EXECUTABLE_DIR 提供，必须优先使用它。
 * 安装版/开发环境仍支持在 exe 同目录放 portable.flag 手动开启便携模式。
 */
function portableBaseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, "portable.flag"))) return exeDir;
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 判断是否为便携模式：数据目录跟随 exe 所在目录 */
function isPortable() {
  return portableBaseDir() !== null;
}

/**
 * 旧版便携判定失效（process.execPath 指向 TEMP 解压副本）导致数据落在 %APPDATA%/DosageSync；
 * 修复后便携模式首次运行时把旧数据复制到 exe 旁 data/（复制而非移动，失败不影响使用）。
 */
function migrateLegacyAppData(targetDir) {
  try {
    const legacy = process.env.APPDATA ? path.join(process.env.APPDATA, "DosageSync") : null;
    if (!legacy || legacy === targetDir) return;
    const dbTarget = path.join(targetDir, "dosage-sync.sqlite");
    const dbLegacy = path.join(legacy, "dosage-sync.sqlite");
    // 新目录已初始化或旧目录无数据时不迁移
    if (fs.existsSync(dbTarget) || !fs.existsSync(dbLegacy)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of ["dosage-sync.sqlite", "dosage-sync.sqlite-wal", "dosage-sync.sqlite-shm", "config.json", "config.json.bak"]) {
      const src = path.join(legacy, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, name));
    }
  } catch {
    /* 迁移失败静默：继续用新目录（空数据），旧目录数据保留 */
  }
}

/** 数据目录：便携模式跟随 exe 目录，否则 %APPDATA%/DosageSync */
function dataDir() {
  let dir;
  const portableDir = portableBaseDir();
  if (portableDir) {
    dir = path.join(portableDir, "data");
    migrateLegacyAppData(dir);
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
      notifyOnSuccess: false,
    },
    totalMode: "full",
    theme: "light",
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
    // WebDAV 密码：密文解密为明文交给上层使用（明文旧配置保持原样，保存时自动迁移为密文）
    if (merged.webdav) merged.webdav.password = decryptPassword(merged.webdav.password);
    // 总量口径归一化：platform 选项从未实现（等效 compact），已从 UI 移除，旧配置值回退为 compact
    if (merged.totalMode !== "full" && merged.totalMode !== "compact") merged.totalMode = "compact";
    return merged;
  } catch (e) {
    // 配置损坏时留档（.bak）并回退默认，避免应用无法启动
    try { fs.renameSync(p, p + ".bak"); } catch { /* 留档失败忽略 */ }
    return defaultConfig();
  }
}

/** 保存配置（先写临时文件再原子替换；WebDAV 密码落盘前经 safeStorage 加密） */
function saveConfig(cfg) {
  const p = configPath();
  const out = { ...cfg, webdav: { ...(cfg.webdav || {}) } };
  if (out.webdav) out.webdav.password = encryptPassword(out.webdav.password);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

module.exports = { dataDir, dbPath, configPath, loadConfig, saveConfig, defaultConfig, isPortable };
