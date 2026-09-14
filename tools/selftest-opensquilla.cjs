// OpenSquilla 适配器自测：五桶映射 / 增量 / 幂等 / 设备标识兜底 / schema 演进列级防御
// 运行：npm run selftest:opensquilla（electron 内置 Node，系统 Node v16 无 node:sqlite）
// 说明：使用临时目录 + OPEN_SQUILLA_HOME 环境变量隔离，不触碰真实 %APPDATA% 数据。
//       单位级用例走 _internal.mapRow（不落库）；端到端用例走 extract/临时 fixture 库。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const OPEN_SQUILLA = require("../electron/backend/adapter-opensquilla.cjs");
const { mapRow, num } = OPEN_SQUILLA._internal;

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  →  " + extra : ""}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

// ===== 临时环境构造（不触碰真实 %APPDATA%） =====
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensquilla-selftest-"));
const HOME = path.join(tmp, "opensquilla-home"); // adapter root（OPEN_SQUILLA_HOME）
const stateDir = path.join(HOME, "state");
fs.mkdirSync(stateDir, { recursive: true });
// 设备标识第 2 级：位于 root 上级目录的 gateway-ownership/<profile-hash>
fs.mkdirSync(path.join(tmp, "gateway-ownership", "profile-hash-abc"), { recursive: true });
const dbFile = path.join(stateDir, "sessions.db");
process.env.OPEN_SQUILLA_HOME = HOME;

const CTX = { deviceId: "dev-1", deviceName: "测试机" };
const T0 = 1788000000000;

const FULL_DDL = `
CREATE TABLE usage_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT, agent_id TEXT, run_kind TEXT, provider TEXT, model TEXT,
    started_at_ms INTEGER, completed_at_ms INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER
)`;

/** 重建 fixture 库并写入给定对象行（rows 为空则建空表，保证文件非空）。
 *  INSERT 只写表中实际存在的列：缺列表（如 SLIM_DDL）下其余字段落 NULL，由 adapter 回退。 */
function buildDb(tableSql, rows) {
  fs.rmSync(dbFile, { force: true });
  const db = new DatabaseSync(dbFile);
  db.exec(tableSql);
  if (rows.length > 0) {
    const cols = db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name);
    if (cols.length === 0) throw new Error("fixture 表无列");
    const stmt = db.prepare(`INSERT INTO usage_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const o of rows) stmt.run(...cols.map((c) => (c in o ? o[c] : null)));
  }
  db.close();
}

const ROW = (o) => ({
  event_id: o.event_id,
  session_id: o.session_id || "sess-1",
  agent_id: o.agent_id || "main",
  run_kind: o.run_kind || "session_turn",
  provider: "provider" in o ? o.provider : "tokenrhythm",
  model: "model" in o ? o.model : "deepseek-v4-pro",
  started_at_ms: o.started_at_ms,
  completed_at_ms: o.completed_at_ms ?? o.started_at_ms + 5000,
  input_tokens: o.input ?? 0,
  output_tokens: o.output ?? 0,
  reasoning_tokens: o.reasoning ?? 0,
  cache_read_tokens: o.cache_read ?? 0,
  cache_write_tokens: o.cache_write ?? 0,
  total_tokens: o.total ?? ((o.input ?? 0) + (o.output ?? 0) + (o.reasoning ?? 0) + (o.cache_read ?? 0) + (o.cache_write ?? 0)),
});

console.log("\n[1] 单位级：mapRow 五桶映射与边界");
const r1 = mapRow(CTX, {
  event_id: "evt-1", session_id: "sess-1", agent_id: "main", run_kind: "session_turn",
  provider: "tokenrhythm", model: "deepseek-v4-pro", started_at_ms: T0, completed_at_ms: T0 + 5000,
  input_tokens: 1000, output_tokens: 100, reasoning_tokens: 50, cache_read_tokens: 900, cache_write_tokens: 10,
});
eq("inputTokens 总口径映射", r1.inputTokens, 1000);
eq("outputTokens", r1.outputTokens, 100);
eq("reasoningTokens", r1.reasoningTokens, 50);
eq("cacheReadTokens", r1.cacheReadTokens, 900);
eq("cacheWriteTokens → cacheCreationTokens", r1.cacheCreationTokens, 10);
eq("provider 用事件原文（决策点 A：tokenrhythm）", r1.providerId, "tokenrhythm");
eq("model 归一化", r1.modelId, "deepseek-v4-pro");
eq("mode 透传 run_kind", r1.mode, "session_turn");
eq("agent 透传", r1.agent, "main");
eq("幂等 id 格式", r1.id, "dev-1:opensquilla:evt-1");
eq("时间戳毫秒直用", r1.startedAt, T0);
eq("completedAt", r1.completedAt, T0 + 5000);
eq("status 恒 success", r1.status, "success");

eq("日期快照后缀归并（0813 → 无后缀）", mapRow(CTX, { event_id: "e", model: "deepseek-v4-pro-0813", started_at_ms: T0, input_tokens: 1 }).modelId, "deepseek-v4-pro");
eq("五桶全 0 跳过", mapRow(CTX, { event_id: "e2", started_at_ms: T0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 }) === null, true);
eq("缺 event_id 跳过", mapRow(CTX, { started_at_ms: T0, input_tokens: 1 }) === null, true);
eq("非法时间戳跳过", mapRow(CTX, { event_id: "e3", started_at_ms: "bad", input_tokens: 1 }) === null, true);
const rFall = mapRow(CTX, { event_id: "e4", started_at_ms: T0, input_tokens: 1 });
eq("provider 缺失兜底", rFall.providerId, "未知供应商:opensquilla");
eq("model 缺失 → unknown", rFall.modelId, "unknown");
eq("num 兜底：负值/非法归 0", num(-5) === 0 && num("x") === 0 && num(3) === 3, true);

console.log("\n[2] 端到端：detect / validate / getDeviceId 三级兜底");
buildDb(FULL_DDL, []);
fs.writeFileSync(path.join(stateDir, "install_telemetry.json"), JSON.stringify({ install_id: "ins-1" }), "utf8");
eq("detect() 命中临时 root", OPEN_SQUILLA.detect(), HOME);
eq("validate() 通过", OPEN_SQUILLA.validate(HOME), true);
eq("validate() 空目录不通过", OPEN_SQUILLA.validate(path.join(tmp, "empty")) === false, true);
eq("getDeviceId 第 1 级：install_id", OPEN_SQUILLA.getDeviceId(HOME), "ins-1");
fs.rmSync(path.join(stateDir, "install_telemetry.json"), { force: true });
eq("getDeviceId 第 2 级：gateway-ownership profile hash（root 上级目录）", OPEN_SQUILLA.getDeviceId(HOME), "profile-hash-abc");
fs.rmSync(path.join(tmp, "gateway-ownership"), { recursive: true, force: true });
eq("getDeviceId 第 3 级：返回 null", OPEN_SQUILLA.getDeviceId(HOME), null);

console.log("\n[3] 端到端：extract 全量 / 增量 / 幂等");
buildDb(FULL_DDL, [
  ROW({ event_id: "evt-a", started_at_ms: T0, input: 1000, output: 100, reasoning: 50, cache_read: 900 }),
  ROW({ event_id: "evt-b", started_at_ms: T0 + 60000, model: "glm-5.2", run_kind: "session_naming", input: 120, output: 400 }),
  ROW({ event_id: "evt-c", started_at_ms: T0 + 120000, run_kind: "onboarding_probe", agent_id: "system", input: 5, output: 1 }),
  ROW({ event_id: "evt-zero", started_at_ms: T0 + 180000, total: 0 }), // unknown 失败重试行 → 跳过
  ROW({ event_id: "evt-d", started_at_ms: T0 + 240000, model: "kimi-k2.7-code", input: 200, output: 20, cache_write: 30 }),
]);
const all = OPEN_SQUILLA.extract(HOME, "dev-1", "测试机", 0);
eq("全量 4 条（total=0 行被排除）", all.length, 4);
eq("按时间升序", all.every((r, i) => i === 0 || r.startedAt > all[i - 1].startedAt), true);
eq("来源全部为 opensquilla", all.every((r) => r.source === "opensquilla"), true);
eq("session_naming 计入（决策点 B：全收）", all.some((r) => r.mode === "session_naming"), true);
eq("onboarding_probe 计入（agent=system）", all.some((r) => r.mode === "onboarding_probe" && r.agent === "system"), true);
eq("cacheWrite → cacheCreation（evt-d=30）", all.find((r) => r.id.endsWith(":evt-d")).cacheCreationTokens, 30);

const since = T0 + 50000;
const inc = OPEN_SQUILLA.extract(HOME, "dev-1", "测试机", since);
eq("增量：since 过滤后 3 条", inc.length, 3);
eq("增量不含 evt-a", inc.every((r) => !r.id.endsWith(":evt-a")), true);

const again = OPEN_SQUILLA.extract(HOME, "dev-1", "测试机", 0);
const ids = (a) => a.map((r) => r.id + "|" + r.inputTokens + "," + r.outputTokens + "," + r.reasoningTokens).join(";");
eq("幂等：重复抽取 id 与五桶一致", ids(again), ids(all));

console.log("\n[4] schema 演进列级防御（缺列回退 / 面目全非抛错）");
// 缺 provider / cache_read / cache_write / total_tokens：回退 0 与五桶和表达式
const SLIM_DDL = `
CREATE TABLE usage_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT, agent_id TEXT, run_kind TEXT, model TEXT,
    started_at_ms INTEGER, completed_at_ms INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER
)`;
buildDb(SLIM_DDL, [ROW({ event_id: "evt-x", started_at_ms: T0, input: 700, output: 300, provider: "", model: "" })]);
const slim = OPEN_SQUILLA.extract(HOME, "dev-1", "测试机", 0);
eq("缺列库仍可抽取", slim.length, 1);
eq("缺失 provider 回退未知供应商", slim[0].providerId, "未知供应商:opensquilla");
eq("缺失 model 回退 unknown", slim[0].modelId, "unknown");
eq("缺失 cache_write 回退 0", slim[0].cacheCreationTokens, 0);
eq("缺 total_tokens 用五桶和回退（700+300=1000>0）", slim[0].inputTokens + slim[0].outputTokens > 0, true);
// 面目全非（连 event_id/started_at_ms 都没有）→ 抛错
fs.rmSync(dbFile, { force: true });
const dbX = new DatabaseSync(dbFile);
dbX.exec("CREATE TABLE usage_events (id TEXT)");
dbX.close();
let threw = false;
try {
  OPEN_SQUILLA.extract(HOME, "dev-1", "测试机", 0);
} catch (e) {
  threw = true;
  ok("面目全非库抛错并带定位信息", /event_id\/started_at_ms/.test(e.message), e.message);
}
ok("面目全非库确实抛错", threw, "未抛错");

console.log("\n[5] 真实库只读抽查（本机已装时）");
const appdata = process.env.APPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Roaming");
const realRoot = path.join(appdata, "@opensquilla", "desktop-electron", "opensquilla");
if (fs.existsSync(path.join(realRoot, "state", "sessions.db"))) {
  const real = OPEN_SQUILLA.extract(realRoot, "dev-local", "本机", 0);
  ok(`真实库可读：${real.length} 条事件`, real.length > 0, "条数为 0");
  ok("真实库 provider 全为事件原文 tokenrhythm", real.every((r) => r.providerId === "tokenrhythm"), undefined);
} else {
  console.log("  SKIP  本机未安装 OpenSquilla，跳过真实库抽查");
}

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.OPEN_SQUILLA_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);