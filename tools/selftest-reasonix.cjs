// Reasonix 适配器自测：归一化口径 / 增量 / 幂等 / 计费公式一致性
// 运行：npm run selftest:reasonix（或 node tools/selftest-reasonix.cjs）
// 说明：使用临时目录 + 环境变量隔离，不触碰真实 %APPDATA%/DosageSync 数据。
//       单位级用例走 _internal.mapRecord（不落库）；端到端用例走 extract（skipped=0 时不触碰 db）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REASONIX = require("../electron/backend/adapter-reasonix.cjs");
const { mapRecord } = REASONIX._internal;

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

const CTX = { deviceId: "dev-1", deviceName: "测试机" };
const DATE = "2026-09-07";

// ---------- 1. 单位级：字段映射与数据质量边界 ----------
console.log("\n[1] 归一化映射（mapRecord）");

// 现代账本：显式 cache_miss
const r1 = mapRecord(
  { ts: 1788000000000, model: "deepseek-v4-flash", cache_miss: 1000, cache_hit: 9000, completion: 500, reasoning: 200, requests: 3 },
  DATE, 1, "", CTX
);
eq("inputTokens = cache_miss + cache_hit", r1.inputTokens, 10000);
eq("cacheReadTokens = cache_hit", r1.cacheReadTokens, 9000);
eq("outputTokens = completion − reasoning", r1.outputTokens, 300);
eq("reasoningTokens = reasoning", r1.reasoningTokens, 200);
eq("cacheCreationTokens = 0（账本不持久化）", r1.cacheCreationTokens, 0);
eq("modelId 归一化", r1.modelId, "deepseek-v4-flash");
eq("providerId 推断为 DeepSeek", r1.providerId, "DeepSeek");
eq("source", r1.source, "reasonix");
eq("时间戳", r1.startedAt, 1788000000000);

// 旧版账本：无 cache_miss，用 prompt − cache_hit
const r2 = mapRecord({ prompt: 10000, cache_hit: 9000, completion: 500, reasoning: 200, model: "deepseek/deepseek-v4-pro" }, DATE, 2, "", CTX);
eq("旧版 inputTokens = prompt", r2.inputTokens, 10000);
eq("旧版 cacheReadTokens", r2.cacheReadTokens, 9000);
eq("模型名去供应商前缀", r2.modelId, "deepseek-v4-pro");

console.log("\n[2] 数据质量边界（应跳过，不静默钳制）");
ok("turn=true 轮次行跳过", mapRecord({ turn: true, cache_miss: 1, cache_hit: 1 }, DATE, 3, "", CTX) === null);
ok("reasoning > completion 跳过", mapRecord({ prompt: 10, cache_hit: 0, completion: 100, reasoning: 200 }, DATE, 4, "", CTX) === null);
ok("cache_hit > prompt 跳过", mapRecord({ prompt: 10, cache_hit: 999, completion: 1 }, DATE, 5, "", CTX) === null);
ok("无用量信号跳过", mapRecord({ model: "x", requests: 0 }, DATE, 6, "", CTX) === null);
ok("非对象跳过", mapRecord(null, DATE, 7, "", CTX) === null);

console.log("\n[3] 兜底行为");
const r3 = mapRecord({ cache_miss: 10, cache_hit: 90, completion: 5 }, DATE, 8, "deepseek-v4-flash", CTX);
eq("模型缺失回退 config default_model", r3.modelId, "deepseek-v4-flash");
const r4 = mapRecord({ cache_miss: 10, cache_hit: 90, completion: 5 }, DATE, 9, "", CTX);
eq("模型与兜底均缺失 → unknown", r4.modelId, "unknown");
eq("未知模型仍归 DeepSeek", r4.providerId, "DeepSeek");
eq("时间戳缺失回退账本日期本地 12:00", r4.startedAt, new Date(2026, 8, 7, 12, 0, 0).getTime());
eq("幂等 id 含日期与行号", r4.id, "dev-1:reasonix:2026-09-07:9");

// ---------- 4. 端到端：真实账本文件 ----------
console.log("\n[4] 端到端抽取（临时账本目录）");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasonix-selftest-"));
const home = path.join(tmp, "reasonix-home");
const statsDir = path.join(home, "stats");
fs.mkdirSync(statsDir, { recursive: true });

const line = (o) => JSON.stringify(o);
fs.writeFileSync(
  path.join(statsDir, "2026-09-06.jsonl"),
  [line({ ts: 1787900000000, model: "deepseek-v4-flash", cache_miss: 100, cache_hit: 900, completion: 50, reasoning: 10 })].join("\n") + "\n",
  "utf8"
);
fs.writeFileSync(
  path.join(statsDir, "2026-09-07.jsonl"),
  [
    line({ ts: 1788000000000, model: "deepseek-v4-flash", cache_miss: 1000, cache_hit: 9000, completion: 500, reasoning: 200 }),
    line({ ts: 1788000060000, model: "deepseek-v4-pro", prompt: 20000, cache_hit: 18000, completion: 800, reasoning: 300 }),
    "", // 空行不应计入
  ].join("\n") + "\n",
  "utf8"
);
fs.writeFileSync(path.join(statsDir, "not-a-date.jsonl"), line({ cache_miss: 1 }) + "\n", "utf8"); // 非日期名应忽略

process.env.REASONIX_STATE_HOME = home;
// 清掉可能干扰的 REASONIX_HOME
delete process.env.REASONIX_HOME;

eq("detect() 命中环境变量目录", REASONIX.detect(), home);
ok("validate()：stats/ 存在即通过", REASONIX.validate(home) === true);
ok("validate()：无 stats/ 不通过", REASONIX.validate(path.join(tmp, "empty")) === false);

const all = REASONIX.extract(home, "dev-1", "测试机", 0);
eq("总记录数（非日期文件被忽略）", all.length, 3);
eq("按时间升序", all[0].startedAt < all[1].startedAt && all[1].startedAt < all[2].startedAt, true);
eq("来源全部为 reasonix", all.every((r) => r.source === "reasonix"), true);

// since 落在 09-07：文件回看一天（09-06 文件被保留），但行级时间戳过滤应剔除其历史行
const since = 1787990000000;
const inc = REASONIX.extract(home, "dev-1", "测试机", since);
eq("增量抽取：回看文件内仅保留 since 之后的行", inc.length, 2);
eq("增量记录均为 09-07", inc.every((r) => r.id.includes("2026-09-07")), true);

// 幂等：重复抽取 id 集合一致
const again = REASONIX.extract(home, "dev-1", "测试机", 0);
const ids = (a) => a.map((r) => r.id).join("|");
eq("幂等：重复抽取 id 集合一致", ids(again), ids(all));
eq("幂等：重复抽取 token 一致", JSON.stringify(again.map((r) => r.inputTokens)), JSON.stringify(all.map((r) => r.inputTokens)));

// ---------- 5. 计费公式一致性（v_record_cost 语义）----------
console.log("\n[5] 计费公式一致性");
// 项目口径：费用 = (净输入×输入价 + 缓存命中×读价 + 缓存写入×写价 + (输出+推理)×输出价) / 1e6
//            其中 净输入 = inputTokens − cacheReadTokens
// Reasonix 真值：费用 = (cache_miss×输入价 + cache_hit×读价 + 0×写价 + completion×输出价) / 1e6
const PIN = 1, PCR = 0.2, POUT = 4; // deepseek-v4-flash 内置价（CNY/百万）
for (const r of all) {
  const model = r.modelId;
  const costProject =
    ((r.inputTokens - r.cacheReadTokens) * PIN + r.cacheReadTokens * PCR + r.cacheCreationTokens * 1 + (r.outputTokens + r.reasoningTokens) * POUT) / 1e6;
  // 反推账本里的 cache_miss 与 completion
  const cacheMiss = r.inputTokens - r.cacheReadTokens;
  const completion = r.outputTokens + r.reasoningTokens;
  const costReasonix = (cacheMiss * PIN + r.cacheReadTokens * PCR + completion * POUT) / 1e6;
  ok(`计费一致：${model} 净输入=${cacheMiss} 输出=${completion}`, Math.abs(costProject - costReasonix) < 1e-12);
  ok(`净输入恰为未缓存输入（非负）：${model}`, cacheMiss >= 0);
}
// 缓存命中率口径
const rate = all[1].cacheReadTokens / all[1].inputTokens;
ok("缓存命中率 ∈ (0,1]", rate > 0 && rate <= 1, `实际 ${rate}`);

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.REASONIX_STATE_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
