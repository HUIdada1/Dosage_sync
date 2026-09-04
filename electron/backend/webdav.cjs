// WebDAV 客户端（原生 fetch 实现）
// 协议子集：PROPFIND / GET / PUT / MKCOL，Basic 认证，XML multistatus 解析
"use strict";

const TIMEOUT_MS = 30000;

// 标准 PROPFIND 请求体（部分 WebDAV 服务器要求非空 body 才返回 207）
const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

function normalizeEndpoint(endpoint) {
  let e = String(endpoint || "").trim();
  if (!e) return "";
  if (!/^https?:\/\//i.test(e)) e = "http://" + e;
  return e.replace(/\/+$/, "");
}

/** 拼接 URL：endpoint + root + 相对路径 */
function joinUrl(endpoint, root, rel) {
  const base = normalizeEndpoint(endpoint);
  const parts = [base];
  if (root) parts.push(String(root).replace(/^\/+|\/+$/g, ""));
  if (rel) parts.push(String(rel).replace(/^\/+|\/+$/g, ""));
  return parts.filter(Boolean).join("/");
}

function authHeader(cfg) {
  const u = cfg.username || "";
  const p = cfg.password || "";
  const token = Buffer.from(`${u}:${p}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function request(method, url, cfg, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        ...(body ? { "Content-Type": "application/octet-stream" } : {}),
        Depth: "1",
        ...headers,
      },
      body: body || undefined,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 PROPFIND 返回的 multistatus XML 中的 href 列表 */
function parseHrefs(xml) {
  const out = [];
  const re = /<d:href>([^<]+)<\/d:href>|<href>([^<]+)<\/href>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const h = m[1] || m[2];
    if (h) out.push(h);
  }
  return out;
}

/** 从 href 中提取相对路径（去掉 endpoint 前缀） */
function relPath(href, endpoint, root) {
  let h = decodeURIComponent(String(href));
  const base = normalizeEndpoint(endpoint);
  if (h.startsWith(base)) h = h.slice(base.length);
  if (root) {
    const r = "/" + String(root).replace(/^\/+|\/+$/g, "");
    if (h.startsWith(r)) h = h.slice(r.length);
  }
  return h.replace(/^\/+|\/+$/g, "");
}

/**
 * 列出目录下所有条目。
 * 返回 [{ href, name, isDir, size, modified }]
 */
async function list(url, cfg) {
  const res = await request("PROPFIND", url, cfg, PROPFIND_BODY, { "Content-Type": "application/xml; charset=utf-8" });
  if (res.status === 404) return [];
  if (res.status === 207 || res.status === 200) {
    const xml = await res.text();
    const hrefs = parseHrefs(xml);
    const result = [];
    const seen = new Set();
    for (const h of hrefs) {
      if (seen.has(h)) continue;
      seen.add(h);
      result.push({
        href: h,
        name: decodeURIComponent(String(h).split("/").filter(Boolean).pop() || ""),
        isDir: String(h).endsWith("/"),
        size: 0,
        modified: null,
      });
    }
    return result;
  }
  if (res.status === 405 || res.status === 501) {
    // 服务器不支持 PROPFIND，降级为空
    return [];
  }
  throw new Error(`PROPFIND 失败：HTTP ${res.status}`);
}

async function get(url, cfg) {
  const res = await request("GET", url, cfg);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET 失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 读取远端文件并解码为 UTF-8 文本 */
async function getText(url, cfg) {
  const buf = await get(url, cfg);
  return buf == null ? null : buf.toString("utf8");
}

async function put(url, cfg, text) {
  const res = await request("PUT", url, cfg, text);
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`PUT 失败：HTTP ${res.status}，服务器拒绝写入，请检查账号写权限和 WebDAV 根目录（${url}）`);
    }
    throw new Error(`PUT 失败：HTTP ${res.status}（${url}）`);
  }
}

/** 确保业务目录存在：从 endpoint 已存在路径之后开始逐级 MKCOL。 */
async function ensureDir(url, cfg) {
  const u = new URL(url);
  const endpoint = new URL(normalizeEndpoint(cfg.endpoint));
  if (u.origin !== endpoint.origin) throw new Error(`WebDAV 地址不一致：${url}`);
  const endpointPath = endpoint.pathname.replace(/\/+$/, "");
  const targetPath = u.pathname.replace(/\/+$/, "");
  if (!targetPath.startsWith(endpointPath)) throw new Error(`WebDAV 目录不在 endpoint 下：${url}`);
  const extra = targetPath.slice(endpointPath.length).split("/").filter(Boolean);
  let current = `${endpoint.origin}${endpointPath}`;
  for (const seg of extra) {
    current += "/" + seg;
    const res = await request("MKCOL", current, cfg);
    // 已存在（405/409）、已跳转（301）等均视为成功
    if (!res.ok && res.status !== 405 && res.status !== 409 && res.status !== 301) {
      if (res.status === 403) throw new Error(`WebDAV 无权创建目录：HTTP 403，请检查账号写权限和根目录（${current}）`);
      throw new Error(`创建目录失败：HTTP ${res.status} ${current}`);
    }
  }
}

/** 测试连接：对根目录 PROPFIND（Depth 0），逐类错误码给出可读提示 */
async function test(cfg) {
  const started = Date.now();
  let url;
  try {
    url = joinUrl(cfg.endpoint, cfg.root, "");
  } catch {
    return { ok: false, message: "地址格式无效" };
  }
  let res;
  try {
    res = await request("PROPFIND", url, cfg, PROPFIND_BODY, {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    });
  } catch (e) {
    // 网络层失败：DNS 解析、拒绝连接、超时等
    const msg = e && e.name === "AbortError" ? "连接超时" : e.message || "网络错误";
    return { ok: false, message: `无法连接：${msg}`, latencyMs: Date.now() - started };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `WebDAV 访问被拒绝（HTTP ${res.status}），请检查账号权限和根目录（${Date.now() - started}ms）`, latencyMs: Date.now() - started };
  }
  if (res.status === 404) {
    return { ok: true, message: `连接成功 · ${Date.now() - started}ms（目录尚未创建，首次同步将自动创建）`, latencyMs: Date.now() - started };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, message: `连接成功 · ${Date.now() - started}ms`, latencyMs: Date.now() - started };
  }
  return { ok: false, message: `连接失败：HTTP ${res.status}（${Date.now() - started}ms）`, latencyMs: Date.now() - started };
}

module.exports = { joinUrl, normalizeEndpoint, list, get, getText, put, ensureDir, test, relPath };
