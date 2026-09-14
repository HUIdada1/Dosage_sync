// CodeBuddy 适配器自测：字段映射 / 模型归因 / 增量 / 幂等 / 计费公式一致性
// 运行：npm run selftest:codebuddy（或 node tools/selftest-codebuddy.cjs）
// 说明：使用临时目录 + 环境变量隔离，不触碰真实 %LOCALAPPDATA%/CodeBuddyExtension 数据。
//       适配器不依赖 db.cjs（不触 node:sqlite），普通 node 即可运行。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEBUDDY = require("../electron/backend/adapter-codebuddy.cjs");

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
// Data/<userUuid>/CodeBuddyIDE/<installUuid>/history/<projectHash>/<sessionId>/{index.json, messages/}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-selftest-"));
const root = path.join(tmp, "CodeBuddyExtension");
const history = path.join(root, "Data", "user-uuid-A", "CodeBuddyIDE", "install-uuid-1", "history");

const sess1 = path.join(history, "projhash1", "sess-0001");
const sess2 = path.join(history, "projhash2", "sess-0002");
const sess3 = path.join(history, "projhash1", "sess-broken");
fs.mkdirSync(path.join(sess1, "messages"), { recursive: true });
fs.mkdirSync(sess2, { recursive: true });
fs.mkdirSync(sess3, { recursive: true });

// sess-0001：r1 归因 gemini（messages 关联）、r2 无归因（unknown）、r3 无 usage 跳过、r4 缺 startedAt 跳过
// r5 用秒级时间戳（CodeBuddy 部分版本可能下发秒），验证 toMs 换算
const T1 = 1788200000000; // ms
const T2 = 1788200060000;
const T5SEC = 1788200120; // 秒
fs.writeFileSync(
  path.join(sess1, "index.json"),
  JSON.stringify({
    messages: [{ id: "m1", type: 1, role: "user", isComplete: true }],
    requests: [
      { id: "req-aaa", type: 1, messages: [], state: "complete", startedAt: T1, usage: { inputTokens: 55490, outputTokens: 648, totalTokens: 56138, lastTokens: 22036 } },
      { id: "req-bbb", type: 1, messages: [], state: "complete", startedAt: T2, usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 } },
      { id: "req-ccc", type: 1, messages: [], state: "error", startedAt: T2 + 1000 }, // 无 usage → 跳过
      { id: "req-ddd", type: 1, messages: [], state: "complete", usage: { inputTokens: 10, outputTokens: 1 } }, // 无 startedAt → 跳过
      { id: "req-eee", type: 1, messages: [], state: "complete", startedAt: T5SEC, usage: { inputTokens: 2000, outputTokens: 100 } }, // 秒级时间戳
      { id: "req-zero", type: 1, messages: [], state: "complete", startedAt: T2 + 2000, usage: { inputTokens: 0, outputTokens: 0 } }, // 全零空轮次 → 跳过
    ],
  }),
  "utf8"
);
// extra 为 JSON 字符串（真实数据形态）；m2 归因 req-eee 验证对象形态兼容
fs.writeFileSync(
  path.join(sess1, "messages", "m1.json"),
  JSON.stringify({ role: "assistant", message: "hi", id: "m1", extra: JSON.stringify({ requestId: "req-aaa", modelId: "gemini-3.0-flash", modelName: "Gemini 3.0 Flash", traceId: "trace-1" }) }),
  "utf8"
);
fs.writeFileSync(
  path.join(sess1, "messages", "m2.json"),
  JSON.stringify({ role: "assistant", message: "yo", id: "m2", extra: { requestId: "req-eee", modelId: "deepseek-v4-pro" } }),
  "utf8"
);
fs.writeFileSync(
  path.join(sess2, "index.json"),
  JSON.stringify({ messages: [], requests: [{ id: "req-fff", type: 1, messages: [], state: "complete", startedAt: 1788300000000, usage: { inputTokens: 163012, outputTokens: 6314, totalTokens: 169326 } }] }),
  "utf8"
);
fs.writeFileSync(path.join(sess3, "index.json"), "{ not valid json", "utf8"); // 损坏索引 → 整会话跳过
fs.writeFileSync(path.join(sess3, "dummy.txt"), "x", "utf8");

process.env.CODEBUDDY_DATA_HOME = root;

// ---------- 1. 探测与校验 ----------
console.log("\n[1] 探测与校验");
eq("detect() 命中环境变量目录", CODEBUDDY.detect(), root);
eq("validate()：Data/ 存在即通过", CODEBUDDY.validate(root), true);
eq("validate()：无 Data/ 不通过", CODEBUDDY.validate(path.join(tmp, "empty")), false);
eq("getDeviceId() 返回 null 走统一回退链", CODEBUDDY.getDeviceId(), null);

// ---------- 2. 全量抽取：字段映射与归因 ----------
console.log("\n[2] 全量抽取");
const all = CODEBUDDY.extract(root, "dev-1", "测试机", 0);
eq("总记录数（r3/r4/sess3/req-zero 被剔除）", all.length, 4);
ok("全零 token 空轮次被跳过", !all.some((r) => r.id.includes("req-zero")));
eq("按时间升序", all.every((r, i) => i === 0 || r.startedAt >= all[i - 1].startedAt), true);
eq("source 全部为 codebuddy", all.every((r) => r.source === "codebuddy"), true);

const r1 = all.find((r) => r.id.includes("req-aaa"));
ok("req-aaa 存在", !!r1);
eq("req-aaa inputTokens", r1.inputTokens, 55490);
eq("req-aaa outputTokens", r1.outputTokens, 648);
eq("req-aaa startedAt（毫秒）", r1.startedAt, T1);
eq("req-aaa sessionId", r1.sessionId, "sess-0001");
eq("req-aaa 归因模型 gemini-3.0-flash", r1.modelId, "gemini-3.0-flash");
eq("req-aaa 供应商推断 Google", r1.providerId, "Google");
eq("req-aaa status complete→success", r1.status, "success");
eq("幂等 id 结构（请求序号后缀防重试 id 碰撞）", r1.id, "dev-1:codebuddy:user-uuid-A:sess-0001:req-aaa:0");

const r2 = all.find((r) => r.id.includes("req-bbb"));
eq("req-bbb 无归因 → unknown", r2.modelId, "unknown");
eq("req-bbb 供应商兜底", r2.providerId, "未知供应商:tencent");

const r5 = all.find((r) => r.id.includes("req-eee"));
eq("req-eee 秒级时间戳换算毫秒", r5.startedAt, T5SEC * 1000);
eq("req-eee extra 为对象时也可归因", r5.modelId, "deepseek-v4-pro");

eq("reasoning/cache 一期记 0", all.every((r) => r.reasoningTokens === 0 && r.cacheReadTokens === 0 && r.cacheCreationTokens === 0), true);

// ---------- 3. 增量：startedAt 精筛 + mtime 粗筛 ----------
console.log("\n[3] 增量抽取");
const SINCE = 1788250000000; // 落在 sess1 与 sess2 之间
// mtime 粗筛：sess1 的索引 mtime 设为过去（早于 since），应整文件跳过
fs.utimesSync(path.join(sess1, "index.json"), new Date(T1), new Date(T1));
const inc1 = CODEBUDDY.extract(root, "dev-1", "测试机", SINCE);
eq("mtime 早于 since 的会话整文件跳过", inc1.length, 1);
eq("仅剩 sess-0002 的新请求", inc1[0].id.includes("req-fff"), true);

// mtime 晚于 since（会话仍在活跃追加）：文件被解析，但行级 startedAt 过滤剔除历史请求
fs.utimesSync(path.join(sess1, "index.json"), new Date(), new Date());
const inc2 = CODEBUDDY.extract(root, "dev-1", "测试机", SINCE);
eq("活跃会话历史请求被行级过滤", inc2.length, 1);

// since=0 全量不触发 mtime 粗筛
const full = CODEBUDDY.extract(root, "dev-1", "测试机", 0);
eq("since=0 全量抽取不受理 mtime 影响", full.length, 4);

// ---------- 4. 幂等 ----------
console.log("\n[4] 幂等");
const ids = (a) => a.map((r) => r.id).join("|");
eq("重复抽取 id 集合一致", ids(CODEBUDDY.extract(root, "dev-1", "测试机", 0)), ids(full));
eq("重复抽取 token 一致", JSON.stringify(full.map((r) => r.inputTokens)), JSON.stringify(all.map((r) => r.inputTokens)));

// ---------- 5. 计费公式一致性（v_record_cost 语义）----------
console.log("\n[5] 计费公式一致性");
// 项目口径：费用 = (净输入×输入价 + 缓存命中×读价 + 缓存写入×写价 + (输出+推理)×输出价) / 1e6
// codebuddy 一期 cache/reasoning 全 0：净输入 = inputTokens，(输出+推理) = outputTokens
const PIN = 1, PCR = 0.2, POUT = 4;
for (const r of all) {
  const costProject = ((r.inputTokens - r.cacheReadTokens) * PIN + r.cacheReadTokens * PCR + r.cacheCreationTokens * 1 + (r.outputTokens + r.reasoningTokens) * POUT) / 1e6;
  const costDirect = (r.inputTokens * PIN + r.outputTokens * POUT) / 1e6;
  ok(`计费一致：${r.modelId} in=${r.inputTokens} out=${r.outputTokens}`, Math.abs(costProject - costDirect) < 1e-12);
}

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.CODEBUDDY_DATA_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
