// Trae 系适配器自测：FFI 解密 / 字段映射 / 增量 / 幂等 / 三源隔离 / 坏库降级 / 真实数据回归
// 运行：npm run selftest:trae（或 node tools/selftest-trae.cjs）
// 说明：合成数据用 sqlcipher.dll 自身建加密库（与 Trae 同密钥同参数），临时目录 + 环境变量
//       隔离，不触碰真实 %APPDATA% 数据；末尾真实数据回归为只读校验（本机存在真实库时才执行）。
// 依据：docs/Trae数据源接入方案-2026-09-11.md
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sqlcipher = require("../electron/backend/sqlcipher.cjs");
const { makeTraeAdapter } = require("../electron/backend/adapter-trae-common.cjs");
const TRAE = require("../electron/backend/adapter-trae.cjs");
const TRAE_CN = require("../electron/backend/adapter-trae-cn.cjs");
const TRAE_SOLO = require("../electron/backend/adapter-trae-solo-cn.cjs");

let pass = 0;
let fail = 0;
let skip = 0;

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
function sk(name, why) {
  skip++;
  console.log(`  SKIP  ${name}${why ? "  →  " + why : ""}`);
}

// ---------- 建合成加密库（用 sqlcipher.dll 自身建，密钥与 Trae 一致） ----------
// open 一个不存在文件：sqlite3_open 会创建空文件，PRAGMA key 后 SELECT 校验对空加密库返回 0 不报错
function createDb(file, turns) {
  const db = sqlcipher.open(file);
  sqlcipher.queryAll(db, "CREATE TABLE chat_turn (id INTEGER PRIMARY KEY, turn_id TEXT, session_id TEXT, context TEXT, created_at bigint, turn_status TEXT, agent_type TEXT)");
  for (const t of turns) {
    const ctx = t.context ? t.context.replace(/'/g, "''") : "";
    sqlcipher.queryAll(
      db,
      `INSERT INTO chat_turn (turn_id, session_id, context, created_at, turn_status, agent_type) VALUES ('${t.turn_id}', '${t.session_id}', '${ctx}', ${t.created_at}, '${t.turn_status}', '${t.agent_type}')`
    );
  }
  sqlcipher.close(db);
}

// ---------- 合成数据 ----------
const T1 = 1789000000; // 秒级（Trae created_at 为秒）
const T2 = 1789000600;

const turnUsage = (prompt, completion, reasoning, cacheCreate, cacheRead) =>
  JSON.stringify({ token_usage: { prompt_tokens: prompt, completion_tokens: completion, reasoning_tokens: reasoning, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead, total_tokens: prompt + completion } });

// ============================================================
console.log("== 环境与 FFI ==");
{
  ok("sqlcipher DLL 可用", sqlcipher.available());
}

// ============================================================
console.log("== 端到端：合成加密库 → 适配器抽取 ==");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-selftest-"));
const root = path.join(tmp, "Trae");
const rootCn = path.join(tmp, "Trae CN");
const rootSolo = path.join(tmp, "TRAE SOLO CN");
for (const r of [root, rootCn, rootSolo]) {
  fs.mkdirSync(path.join(r, "ModularData", "ai-agent"), { recursive: true });
  fs.writeFileSync(path.join(r, "machineid"), `uuid-${path.basename(r)}`, "utf8");
}

// 国际版：两条有效 + 一条无 usage + 一条全 0 + 一条损坏 JSON
createDb(path.join(root, "ModularData", "ai-agent", "database.db"), [
  { turn_id: "t-1", session_id: "s-1", context: turnUsage(1000, 50, 10, 0, 800), created_at: T1, turn_status: "completed", agent_type: "builder_v3" },
  { turn_id: "t-2", session_id: "s-1", context: turnUsage(2000, 100, 0, 0, 1500), created_at: T2, turn_status: "success", agent_type: "solo_coder" },
  { turn_id: "t-3", session_id: "s-1", context: JSON.stringify({ other: 1 }), created_at: T2 + 1, turn_status: "completed", agent_type: "builder_v3" },
  { turn_id: "t-4", session_id: "s-1", context: turnUsage(0, 0, 0, 0, 0), created_at: T2 + 2, turn_status: "canceled", agent_type: "builder_v3" },
  { turn_id: "t-5", session_id: "s-1", context: "{bad json", created_at: T2 + 3, turn_status: "completed", agent_type: "builder_v3" },
]);
// CN 版：一条（cache 全 0）
createDb(path.join(rootCn, "ModularData", "ai-agent", "database.db"), [
  { turn_id: "cn-1", session_id: "s-9", context: turnUsage(5000, 200, 0, 0, 0), created_at: T1, turn_status: "completed", agent_type: "builder" },
]);
// SOLO：一条
createDb(path.join(rootSolo, "ModularData", "ai-agent", "database.db"), [
  { turn_id: "solo-1", session_id: "s-8", context: turnUsage(800, 20, 5, 0, 600), created_at: T2, turn_status: "completed", agent_type: "solo_work_lite" },
]);

process.env.TRAE_DATA_HOME = root;
process.env.TRAECN_DATA_HOME = rootCn;
process.env.TRAESOLOCN_DATA_HOME = rootSolo;

{
  // detect / validate / getDeviceId
  eq("trae detect", TRAE.detect(), root);
  eq("trae-cn detect", TRAE_CN.detect(), rootCn);
  eq("solo detect", TRAE_SOLO.detect(), rootSolo);
  ok("trae validate", TRAE.validate(root));
  eq("trae getDeviceId", TRAE.getDeviceId(root), "uuid-Trae");

  // extract 全量
  const recs = TRAE.extract(root, "dev1", "测试机", 0);
  eq("trae 全量抽取条数", recs.length, 2);
  const r1 = recs[0];
  eq("id 幂等键", r1.id, "dev1:trae:t-1");
  eq("source", r1.source, "trae");
  eq("inputTokens", r1.inputTokens, 1000);
  eq("outputTokens", r1.outputTokens, 50);
  eq("reasoningTokens", r1.reasoningTokens, 10);
  eq("cacheReadTokens", r1.cacheReadTokens, 800);
  eq("cacheCreationTokens", r1.cacheCreationTokens, 0);
  eq("startedAt 秒→毫秒", r1.startedAt, T1 * 1000);
  eq("sessionId", r1.sessionId, "s-1");
  eq("mode=agent_type", r1.mode, "builder_v3");
  eq("status completed→success", r1.status, "success");
  eq("modelId 归一", r1.modelId, "trae");
  ok("providerId 非空", typeof r1.providerId === "string" && r1.providerId.length > 0);

  // 增量
  const incr = TRAE.extract(root, "dev1", "测试机", T1 * 1000);
  eq("增量只剩 t-2", incr.length, 1);
  eq("增量取到 t-2", incr[0].id, "dev1:trae:t-2");

  // CN：cache 全 0 照入库
  const cnRecs = TRAE_CN.extract(rootCn, "dev1", "测试机", 0);
  eq("cn 抽取条数", cnRecs.length, 1);
  eq("cn cacheRead=0", cnRecs[0].cacheReadTokens, 0);
  eq("cn source 隔离", cnRecs[0].source, "trae-cn");
  eq("cn modelId", cnRecs[0].modelId, "trae-cn");

  // SOLO
  const soloRecs = TRAE_SOLO.extract(rootSolo, "dev1", "测试机", 0);
  eq("solo 抽取条数", soloRecs.length, 1);
  eq("solo source", soloRecs[0].source, "trae-solo-cn");
  eq("solo reasoning", soloRecs[0].reasoningTokens, 5);
}

// ============================================================
console.log("== 幂等键唯一性 ==");
{
  const recs = TRAE.extract(root, "dev1", "测试机", 0);
  const ids = new Set(recs.map((r) => r.id));
  eq("抽取 id 无重复", ids.size, recs.length);
}

// ============================================================
console.log("== 容错 ==");
{
  // 库文件不存在
  let threw = false;
  try {
    TRAE.extract(path.join(tmp, "nonexistent"), "dev1", "测试机", 0);
  } catch (e) {
    threw = /未找到/.test(e.message);
  }
  ok("库缺失抛错友好", threw);

  // 明文库（未加密）→ 解密失败报错
  const plainDir = path.join(tmp, "PlainApp");
  fs.mkdirSync(path.join(plainDir, "ModularData", "ai-agent"), { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const pdb = new DatabaseSync(path.join(plainDir, "ModularData", "ai-agent", "database.db"));
  pdb.exec("CREATE TABLE chat_turn (id INTEGER)");
  pdb.close();
  process.env.TRAE_DATA_HOME = plainDir;
  let decErr = false;
  try {
    TRAE.extract(plainDir, "dev1", "测试机", 0);
  } catch (e) {
    decErr = /解密失败/.test(e.message);
  }
  ok("明文库解密失败报错", decErr);
  process.env.TRAE_DATA_HOME = root;
}

// ============================================================
console.log("== 真实数据回归（只读，本机存在才执行）==");
{
  delete process.env.TRAE_DATA_HOME;
  delete process.env.TRAECN_DATA_HOME;
  delete process.env.TRAESOLOCN_DATA_HOME;
  const cases = [
    ["Trae", TRAE, 862],
    ["Trae CN", TRAE_CN, 441],
    ["TRAE SOLO CN", TRAE_SOLO, 1],
  ];
  for (const [label, adapter, expectMin] of cases) {
    const dir = adapter.detect();
    if (!dir) {
      sk(`${label} 真实数据回归`, "本机无该应用数据");
      continue;
    }
    let recs = null;
    let err = null;
    try {
      recs = adapter.extract(dir, "devX", "本机", 0);
    } catch (e) {
      err = e;
    }
    ok(`${label} 真实库可解密抽取`, recs !== null, err ? err.message : "");
    if (recs) {
      ok(`${label} 记录数 ≥ ${expectMin}（2026-09-11 实测）`, recs.length >= expectMin, `实际 ${recs.length}`);
      const total = recs.reduce((s, r) => s + r.inputTokens, 0);
      ok(`${label} 输入 token 汇总 > 0`, total > 0, `合计 ${total}`);
    }
  }
}

// ============================================================
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过`);
process.exit(fail > 0 ? 1 : 0);
