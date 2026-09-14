// Qoder / Qoder CN 适配器自测：字段映射 / 官方模型 credits / BYOK token / 增量 / 幂等 / 双源隔离
// 运行：npm run selftest:qoder（或 node tools/selftest-qoder.cjs）
// 说明：使用临时目录 + 环境变量隔离，不触碰真实 ~/.qoder / ~/.qoder-cn 数据。
//       适配器不依赖 db.cjs（不触 node:sqlite），普通 node 即可运行。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const QODER = require("../electron/backend/adapter-qoder.cjs");
const QODER_CN = require("../electron/backend/adapter-qoder-cn.cjs");

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

// ---------- 端到端：构造真实目录结构 ----------
// projects/<路径编码项目>/<sessionId>.jsonl（assistant 行带 message.usage）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-selftest-"));
const root = path.join(tmp, ".qoder");
const rootCn = path.join(tmp, ".qoder-cn");
const proj = path.join(root, "projects", "E--test-proj");
const projCn = path.join(rootCn, "projects", "E-------------");
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(projCn, { recursive: true });
fs.writeFileSync(path.join(root, "installation_id"), "q-uuid-intl-0001\n", "utf8");
fs.writeFileSync(path.join(rootCn, "installation_id"), "q-uuid-cn-0001\n", "utf8");

const T1 = 1789000000000; // 官方模型请求（较早）
const T2 = 1789000600000; // BYOK 请求（较晚）
const iso = (ms) => new Date(ms).toISOString();

// sess-0001：
//  L1 官方模型最终消息（usage.token 全 0 + credits）→ 入库
//  L2 官方模型 thinking 中间消息（无 usage）→ 跳过
//  L3 BYOK 自定义模型（完整 token + cache_read，无 credits）→ 入库
//  L4 损坏行 → 跳过
//  L5 有 usage 但无 uuid/request_id → 跳过（无法幂等去重）
const transcript = [
  `{"type":"assistant","uuid":"u-1","timestamp":"${iso(T1)}","message":{"id":"chatcmpl-1","role":"assistant","model":"qmodel_38max","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","credits":3.0417,"original_credits":3.0417,"billable":true,"request_id":"req-1","context_usage_ratio":0.13228}},"sessionId":"sid-0001","entrypoint":"cli","version":"1.1.35"}`,
  `{"type":"assistant","uuid":"u-0","timestamp":"${iso(T1 - 1000)}","message":{"id":"chatcmpl-1","role":"assistant","model":"qmodel_38max","stop_reason":null,"content":[{"type":"thinking","thinking":"..."}]}}`,
  `{"type":"assistant","uuid":"u-2","timestamp":"${iso(T2)}","message":{"id":"chatcmpl-2","role":"assistant","model":"qoder-custom-40cf1391-96a4/deepseek-v4-pro-0813","stop_reason":"end_turn","content":[{"type":"text","text":"你好"}],"usage":{"input_tokens":25013,"cache_creation_input_tokens":0,"cache_read_input_tokens":2048,"output_tokens":56,"request_id":"req-2","context_usage_ratio":0.125}},"modelSource":"custom","sessionId":"sid-0001","entrypoint":"cli","version":"1.1.47"}`,
  `{ not valid json`,
  `{"type":"assistant","uuid":"","timestamp":"${iso(T2 + 1000)}","message":{"id":"chatcmpl-3","role":"assistant","model":"qmodel_lite","stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":1}}}`,
].join("\n");
fs.writeFileSync(path.join(proj, "sid-0001.jsonl"), transcript, "utf8");

// 第二个项目目录：仅一条新请求（增量 / mtime 测试用）
const transcript2 = `{"type":"assistant","uuid":"u-3","timestamp":"${iso(T2 + 60000)}","message":{"id":"chatcmpl-4","role":"assistant","model":"lite","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0,"credits":0.5}},"sessionId":"sid-0002","entrypoint":"cli"}`;
const file2 = path.join(root, "projects", "C--Users-testuser", "sid-0002.jsonl");
fs.mkdirSync(path.dirname(file2), { recursive: true });
fs.writeFileSync(file2, transcript2, "utf8");

// CN 版：一条官方模型记录（验证双源隔离与 id 前缀）
const transcriptCn = `{"type":"assistant","uuid":"u-cn-1","timestamp":"${iso(T1)}","message":{"id":"chatcmpl-cn","role":"assistant","model":"qmodel_38max","stop_reason":"end_turn","usage":{"input_tokens":0,"output_tokens":0,"credits":1.25}},"sessionId":"sid-cn","entrypoint":"cli"}`;
fs.writeFileSync(path.join(projCn, "sid-cn.jsonl"), transcriptCn, "utf8");

process.env.QODER_DATA_HOME = root;
process.env.QODERCN_DATA_HOME = rootCn;

// ---------- 1. 探测与校验 ----------
console.log("\n[1] 探测与校验");
eq("detect() 命中环境变量目录", QODER.detect(), root);
eq("validate()：projects/ 存在即通过", QODER.validate(root), true);
eq("validate()：无 projects/ 不通过", QODER.validate(tmp), false);
eq("getDeviceId() 读 installation_id", QODER.getDeviceId(root), "q-uuid-intl-0001");
eq("CN 版 detect 独立", QODER_CN.detect(), rootCn);
eq("CN 版 getDeviceId 独立", QODER_CN.getDeviceId(rootCn), "q-uuid-cn-0001");

// ---------- 2. 全量抽取：字段映射 ----------
console.log("\n[2] 全量抽取");
const all = QODER.extract(root, "dev-1", "测试机", 0);
eq("总记录数（thinking/损坏/无 uuid 行被剔除）", all.length, 3);
eq("按时间升序", all.every((r, i) => i === 0 || r.startedAt >= all[i - 1].startedAt), true);
eq("source 全部为 qoder", all.every((r) => r.source === "qoder"), true);

const official = all.find((r) => r.id.endsWith("u-1"));
ok("官方模型记录存在", !!official);
eq("官方模型幂等 id", official.id, "dev-1:qoder:u-1");
eq("官方模型 inputTokens=0", official.inputTokens, 0);
eq("官方模型 outputTokens=0", official.outputTokens, 0);
eq("官方模型 credits=3.0417", official.credits, 3.0417);
eq("官方模型 providerId=Qoder", official.providerId, "Qoder");
eq("官方模型模型名规范化 qmodel-38max", official.modelId, "qmodel-38max");
eq("官方模型 startedAt（ISO→ms）", official.startedAt, T1);
eq("官方模型 sessionId", official.sessionId, "sid-0001");
eq("官方模型 mode=entrypoint", official.mode, "cli");
eq("官方模型 status=success", official.status, "success");

const byok = all.find((r) => r.id.endsWith("u-2"));
ok("BYOK 记录存在", !!byok);
eq("BYOK inputTokens", byok.inputTokens, 25013);
eq("BYOK cacheReadTokens", byok.cacheReadTokens, 2048);
eq("BYOK outputTokens", byok.outputTokens, 56);
eq("BYOK 无 credits（缺失记 null 不造 0）", byok.credits, null);
eq("BYOK 模型名拆分并规范化（-0813 日期后缀剥离）", byok.modelId, "deepseek-v4-pro");
eq("BYOK 供应商按模型名推断 DeepSeek", byok.providerId, "DeepSeek");

const lite = all.find((r) => r.id.endsWith("u-3"));
eq("lite 模型 credits=0.5 保留", lite.credits, 0.5);

// ---------- 3. 增量：startedAt 精筛 + mtime 粗筛 ----------
console.log("\n[3] 增量抽取");
const SINCE = T1 + 30000; // 落在官方与 BYOK 请求之间
// mtime 粗筛：sid-0001 mtime 设为过去 → 整文件跳过，只剩 sid-0002
fs.utimesSync(path.join(proj, "sid-0001.jsonl"), new Date(T1), new Date(T1));
const inc1 = QODER.extract(root, "dev-1", "测试机", SINCE);
eq("mtime 早于 since 的转录整文件跳过", inc1.length, 1);
eq("仅剩 sid-0002 的新请求", inc1[0].id.endsWith("u-3"), true);

// mtime 晚于 since（两个转录都活跃）：文件被解析，但行级 startedAt 过滤剔除历史行，只剩 u-2 与 u-3
fs.utimesSync(path.join(proj, "sid-0001.jsonl"), new Date(), new Date());
const inc2 = QODER.extract(root, "dev-1", "测试机", SINCE);
eq("活跃转录的历史行被行级过滤", inc2.length, 2);
eq("增量包含 BYOK 行", inc2.some((r) => r.id.endsWith("u-2")), true);

// since=0 全量不受 mtime 影响
const full = QODER.extract(root, "dev-1", "测试机", 0);
eq("since=0 全量抽取不受理 mtime 影响", full.length, 3);

// ---------- 4. 幂等 ----------
console.log("\n[4] 幂等");
const ids = (a) => a.map((r) => r.id).join("|");
eq("重复抽取 id 集合一致", ids(QODER.extract(root, "dev-1", "测试机", 0)), ids(full));
eq("重复抽取 credits 一致", JSON.stringify(full.map((r) => r.credits)), JSON.stringify(all.map((r) => r.credits)));

// ---------- 5. 双源隔离 ----------
console.log("\n[5] Qoder / Qoder CN 双源隔离");
const cnAll = QODER_CN.extract(rootCn, "dev-1", "测试机", 0);
eq("CN 版记录数", cnAll.length, 1);
eq("CN 版 source=qoder-cn", cnAll[0].source, "qoder-cn");
eq("CN 版 id 前缀隔离", cnAll[0].id, "dev-1:qoder-cn:u-cn-1");
eq("CN 版 credits 保留", cnAll[0].credits, 1.25);
// 同 uuid 跨两源不会互相覆盖（id 前缀不同）
ok("两源 id 空间互不冲突", !cnAll.some((r) => all.some((x) => x.id === r.id)));

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.QODER_DATA_HOME;
delete process.env.QODERCN_DATA_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
