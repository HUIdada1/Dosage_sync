// Antigravity / Antigravity IDE 数据源公共工厂
// 两款软件本地均无 token 用量明细文件（用量在 Google 云端，本地只有会话记录）。
// 统计口径：配额余额快照法 —— 每次同步调用本地语言服务的
//   POST http(s)://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus
// 读取配额已用量（可分模型），与汇总库 meta 表中的上次快照求差值生成记录。
// 端口与 CSRF token 从 language_server_* 进程命令行/监听端口提取。
// 优雅降级：软件未运行、接口失败或结构变动时返回空记录并写日志，不影响其他源。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const db = require("./db.cjs");

const execFileAsync = promisify(execFile);

const RPC_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const PROCESS_TIMEOUT_MS = 15000;
const RPC_TIMEOUT_MS = 5000;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ".";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 深度搜索：返回首个满足条件的对象（响应嵌套层级可能随版本变化） */
function findDeep(node, pred, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (pred(node)) return node;
  for (const v of Object.values(node)) {
    const found = findDeep(v, pred, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 枚举 language_server_* 进程（PowerShell CIM，失败回退 wmic） */
async function listLanguageServerProcesses() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name LIKE \'language_server%\'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    const text = String(stdout || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      const { stdout } = await execFileAsync("wmic", ["process", "where", "name like 'language_server%'", "get", "ProcessId,ExecutablePath,CommandLine", "/format:list"], { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      const items = [];
      for (const block of String(stdout || "").split(/\r?\n\r?\n/)) {
        const get = (k) => (block.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim() || "";
        const pid = num(get("ProcessId"));
        if (pid !== null) items.push({ ProcessId: pid, ExecutablePath: get("ExecutablePath"), CommandLine: get("CommandLine") });
      }
      return items;
    } catch {
      return [];
    }
  }
}

/** 按安装目录匹配属于本数据源的进程（新版需排除旧版，反之亦然） */
function matchProcess(proc, installMatch, excludeMatch) {
  const hay = `${proc.ExecutablePath || ""} ${proc.CommandLine || ""}`.toLowerCase();
  if (!hay.trim()) return false;
  if (!hay.includes(installMatch.toLowerCase())) return false;
  if (excludeMatch && hay.includes(excludeMatch.toLowerCase())) return false;
  return true;
}

/** 从命令行参数提取 CSRF token（--csrf-token / --csrf_token 等写法） */
function extractCsrfToken(cmdline) {
  const m = String(cmdline || "").match(/--csrf[-_]?token(?:=|\s+"?)([A-Za-z0-9\-_]+)/i);
  return m ? m[1] : null;
}

/** 从命令行参数提取监听端口（--server_port / --port 等写法） */
function extractPortFromCmdline(cmdline) {
  const m = String(cmdline || "").match(/--(?:server[-_])?port(?:=|\s+"?)(\d{2,5})/i);
  return m ? num(m[1]) : null;
}

/** 通过 netstat 找该进程在本机环回地址上的监听端口 */
async function listeningPorts(pid) {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    const ports = [];
    for (const line of String(stdout || "").split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5 || cols[cols.length - 1] !== String(pid)) continue;
      const m = cols[1].match(/(?:127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0|\[::\]):(\d+)$/);
      if (m) ports.push(num(m[1]));
    }
    return ports.filter((p) => p !== null);
  } catch {
    return [];
  }
}

/** 调用 GetUserStatus（先试 https，失败回退 http） */
function postGetUserStatus(port, csrfToken, useHttps) {
  return new Promise((resolve, reject) => {
    const mod = useHttps ? https : http;
    const req = mod.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: RPC_PATH,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          ...(csrfToken ? { "X-Codeium-Csrf-Token": csrfToken } : {}),
        },
        rejectUnauthorized: false,
        timeout: RPC_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("响应非 JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end("{}");
  });
}

async function callGetUserStatus(port, csrfToken) {
  try {
    return await postGetUserStatus(port, csrfToken, true);
  } catch {
    return postGetUserStatus(port, csrfToken, false);
  }
}

/** 从 GetUserStatus 响应解析配额快照：{ used, models: { modelId: used } } */
function parseQuota(status) {
  const credits = findDeep(status, (o) => !Array.isArray(o) && o.promptCredits && typeof o.promptCredits === "object");
  const promptCredits = credits ? credits.promptCredits : null;

  let used = null;
  if (promptCredits) {
    used = num(promptCredits.used);
    if (used === null) {
      const limit = num(promptCredits.limit);
      const remaining = num(promptCredits.remaining);
      if (limit !== null && remaining !== null) used = limit - remaining;
    }
  }

  const modelsHolder = findDeep(status, (o) => Array.isArray(o.models) && o.models.some((m) => m && m.modelId && m.quota));
  const models = {};
  if (modelsHolder) {
    for (const m of modelsHolder.models) {
      if (!m || !m.modelId || !m.quota) continue;
      let mu = num(m.quota.used);
      if (mu === null) {
        const limit = num(m.quota.limit);
        const remaining = num(m.quota.remaining);
        if (limit !== null && remaining !== null) mu = limit - remaining;
      }
      if (mu !== null) models[String(m.modelId)] = mu;
    }
  }

  if (used === null && Object.keys(models).length === 0) return null;
  return { used: used ?? Object.values(models).reduce((s, v) => s + v, 0), models };
}

/** 提取本数据源的配额快照；不可用时返回 null */
async function fetchQuotaSnapshot(installMatch, excludeMatch) {
  const procs = (await listLanguageServerProcesses()).filter((p) => matchProcess(p, installMatch, excludeMatch));
  for (const proc of procs) {
    const csrf = extractCsrfToken(proc.CommandLine);
    const cmdPort = extractPortFromCmdline(proc.CommandLine);
    const ports = cmdPort !== null ? [cmdPort] : await listeningPorts(proc.ProcessId);
    for (const port of ports) {
      try {
        const status = await callGetUserStatus(port, csrf);
        const quota = parseQuota(status);
        if (quota) return quota;
      } catch {
        /* 尝试下一个端口/进程 */
      }
    }
  }
  return null;
}

/**
 * 生成 Antigravity 系数据源适配器。
 * @param id 源 id（antigravity / antigravity-ide）
 * @param name 显示名
 * @param homeSub ~/.gemini 下的子目录名（antigravity / antigravity-ide）
 * @param appDataName %APPDATA% 下的目录名（Antigravity / Antigravity IDE）
 * @param installMatch 进程路径/命令行匹配串（区分新旧版安装）
 * @param excludeMatch 排除串（旧版排除 "Antigravity IDE"）
 */
function makeAdapter(id, name, homeSub, appDataName, installMatch, excludeMatch) {
  const snapshotKey = `snapshot:${id}`;

  function detect() {
    const home = path.join(homeDir(), ".gemini", homeSub);
    if (fs.existsSync(home)) return home;
    const roaming = process.env.APPDATA ? path.join(process.env.APPDATA, appDataName) : null;
    if (roaming && fs.existsSync(roaming)) return roaming;
    return null;
  }

  function validate(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    return (
      fs.existsSync(path.join(dir, "conversations")) ||
      fs.existsSync(path.join(dir, "User", "globalStorage"))
    );
  }

  // Antigravity 无本地设备标识文件，返回 null 走统一回退链
  function getDeviceId() {
    return null;
  }

  /** 配额快照差值抽取；任何失败都优雅降级为空记录 */
  async function extract(dir, deviceId, deviceName) {
    if (process.platform !== "win32") {
      db.addLog("extract", "info", `${name} 配额快照仅支持 Windows，已跳过`);
      return [];
    }

    const quota = await fetchQuotaSnapshot(installMatch, excludeMatch);
    if (!quota) {
      db.addLog("extract", "info", `未检测到正在运行的 ${name} 语言服务，跳过配额快照`);
      return [];
    }

    const now = Date.now();
    const snap = { at: now, used: quota.used, models: quota.models };

    let prev = null;
    try {
      const raw = db.getMeta(snapshotKey);
      if (raw) prev = JSON.parse(raw);
    } catch {
      prev = null;
    }
    db.setMeta(snapshotKey, JSON.stringify(snap));

    // 首次同步只建立基线，避免把历史周期用量一次性计入当天
    if (!prev || typeof prev.used !== "number") {
      db.addLog("extract", "info", `${name} 已建立配额基线（已用 ${quota.used} 点），自下次同步起按差值统计`);
      return [];
    }

    const out = [];
    const prevModels = prev.models && typeof prev.models === "object" ? prev.models : {};
    const modelIds = Object.keys(quota.models);
    for (const modelId of modelIds) {
      const used = quota.models[modelId];
      const prevUsed = typeof prevModels[modelId] === "number" ? prevModels[modelId] : 0;
      // 配额周期重置（used 变小）：视为从 0 重新累计
      const delta = used >= prevUsed ? used - prevUsed : used;
      if (delta <= 0) continue;
      out.push({
        id: `${deviceId}:${id}:${now}:${modelId}`,
        deviceId,
        deviceName,
        source: id,
        providerId: "Google",
        modelId,
        // 单位为配额点数而非 token，仅在该源标签页内自洽
        inputTokens: Math.round(delta),
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        startedAt: now,
        completedAt: now,
        status: "success",
      });
    }

    // 无分模型数据时退回总量差值
    if (out.length === 0 && modelIds.length === 0) {
      const delta = quota.used >= prev.used ? quota.used - prev.used : quota.used;
      if (delta > 0) {
        out.push({
          id: `${deviceId}:${id}:${now}:quota`,
          deviceId,
          deviceName,
          source: id,
          providerId: "Google",
          modelId: "配额合计",
          inputTokens: Math.round(delta),
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          startedAt: now,
          completedAt: now,
          status: "success",
        });
      }
    }

    if (out.length > 0) {
      const total = out.reduce((s, r) => s + r.inputTokens, 0);
      db.addLog("extract", "info", `${name} 配额差值：本次消耗 ${total} 点（${out.length} 个模型）`);
    }
    return out;
  }

  return { id, name, detect, validate, getDeviceId, extract };
}

module.exports = { makeAdapter };
