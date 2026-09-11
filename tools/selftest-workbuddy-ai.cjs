// WorkBuddy AI 适配器自测：字段映射 / 无 device-id / 缓存与推理补入 / 增量 / 幂等 / 双源隔离
// 运行：npm run selftest:workbuddy-ai（或 node tools/selftest-workbuddy-ai.cjs）
// 说明：使用临时目录 + 环境变量隔离，不触碰真实 ~/.workbuddy / ~/.workbuddy-ai 数据。
//       适配器不依赖 db.cjs（不触 node:sqlite），普通 node 即可运行。
// 依据：docs/WorkBuddyAI数据源接入方案-2026-09-11.md
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AI = require("../electron/backend/adapter-workbuddy-ai.cjs");
const WB = require("../electron/backend/adapter-workbuddy.cjs");

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
// WorkBuddy AI：projects/<编码cwd>-<会话时间戳>/<sessionId>.jsonl（并存的 flat 目录变体也要命中）
// WorkBuddy   ：projects/<编码cwd>/<sessionId>.jsonl
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ai-selftest-"));
const rootAi = path.join(tmp, ".workbuddy-ai");
const rootWb = path.join(tmp, ".workbuddy");

// AI：带时间戳的项目目录
const projTs = path.join(rootAi, "projects", "c-Users-XX-WorkBuddy AI-2026-09-11-10-11-13");
// AI：不带时间戳的项目目录（兼容变体）
const projFlat = path.join(rootAi, "projects", "plain-proj");
// WorkBuddy：普通项目目录
const projWb = path.join(rootWb, "projects", "c-Users-XX-proj");

fs.mkdirSync(projTs, { recursive: true });
fs.mkdirSync(projFlat, { recursive: true });
fs.mkdirSync(projWb, { recursive: true });

// WorkBuddy 有 device-id，WorkBuddy AI 没有（这是两源的实质差异）
fs.writeFileSync(path.join(rootWb, "device-id"), "wb-uuid-0001\n", "utf8");

const T1 = Date.now() - 3 * 3600 * 1000; // 较早
const T2 = Date.now() - 1 * 3600 * 1000; // 较晚

// sid-ai-0001：完整字段 / 缺失缓存字段 / 非法类型行 / 损坏行 / 空行 / 同 messageId 重复
const transcriptAi = [
  // L1 user 消息（无 message.usage）→ 跳过
  `{"id":"u-1","timestamp":${T1},"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}],"sessionId":"sid-ai-0001"}`,
  // L2 assistant 完整字段：input 含缓存命中 + 推理 + 缓存写入
  `{"id":"a-1","timestamp":${T1},"type":"message","role":"assistant","status":"completed","message":{"usage":{"input_tokens":10000,"output_tokens":200,"total_tokens":10200,"cache_read_input_tokens":3000}},"providerData":{"messageId":"msg-ai-1","model":"deepseek-v4.1-flash","requestModelId":"auto","rawUsage":{"completion_tokens_details":{"reasoning_tokens":150},"prompt_cache_write_tokens":500}},"sessionId":"sid-ai-0001"}`,
  // L3 非 message 类型 → 跳过
  `{"type":"ai-title","timestamp":${T1 + 1},"title":"标题"}`,
  // L4 缺失 cache_read / 未知模型（供应商兜底名）
  `{"id":"a-2","timestamp":${T1 + 1000},"type":"message","role":"assistant","message":{"usage":{"input_tokens":5000,"output_tokens":100,"total_tokens":5100}},"providerData":{"messageId":"msg-ai-2","model":"hy3","rawUsage":{}},"sessionId":"sid-ai-0001"}`,
  // L5 同 messageId 重复行（token 不同）→ 去重，保留首条
  `{"id":"a-2-dup","timestamp":${T1 + 2000},"type":"message","role":"assistant","message":{"usage":{"input_tokens":99999,"output_tokens":999}},"providerData":{"messageId":"msg-ai-2","model":"hy3"},"sessionId":"sid-ai-0001"}`,
  // L6 file-history-snapshot → 跳过
  `{"type":"file-history-snapshot","timestamp":${T1 + 3000}}`,
  // L7 损坏行 → 跳过
  `{ not valid json`,
  // L8 空行
  ``,
].join("\n");
fs.writeFileSync(path.join(projTs, "sid-ai-0001.jsonl"), transcriptAi, "utf8");

// 非 .jsonl 兄弟文件：即使内含合法 usage 也不得被扫描（后缀过滤）
fs.writeFileSync(
  path.join(projTs, "sid-ai-0001.file-rollback.ndjson"),
  `{"timestamp":${T2 + 5000},"type":"message","message":{"usage":{"input_tokens":88888,"output_tokens":888}},"providerData":{"messageId":"ROLLBACK-SHOULD-NOT-BE-SCANNED","model":"hy3"}}`,
  "utf8",
);
fs.writeFileSync(
  path.join(projTs, "sid-ai-0001.meta.json"),
  `{"timestamp":${T2 + 6000},"type":"message","message":{"usage":{"input_tokens":77777,"output_tokens":777}},"providerData":{"messageId":"META-SHOULD-NOT-BE-SCANNED","model":"hy3"}}`,
  "utf8",
);

// sid-ai-0002：flat 项目目录（不带时间戳）+ 失败状态
fs.writeFileSync(
  path.join(projFlat, "sid-ai-0002.jsonl"),
  `{"id":"a-3","timestamp":${T2},"type":"message","role":"assistant","status":"error","message":{"usage":{"input_tokens":2000,"output_tokens":50,"total_tokens":2050,"cache_read_input_tokens":500}},"providerData":{"messageId":"msg-ai-3","model":"gpt-6-astra"},"sessionId":"sid-ai-0002"}`,
  "utf8",
);

// WorkBuddy 源：结构同构，用于双源隔离验证
fs.writeFileSync(
  path.join(projWb, "sid-wb-0001.jsonl"),
  `{"id":"w-1","timestamp":${T1},"type":"message","role":"assistant","status":"completed","message":{"usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168,"cache_read_input_tokens":7}},"providerData":{"messageId":"msg-wb-1","model":"glm-5.3"},"sessionId":"sid-wb-0001"}`,
  "utf8",
);

// ---------- 1. 探测与设备标识 ----------
console.log("\n[1] 探测与设备标识（目录前缀不串扰）");
process.env.WORKBUDDY_AI_DATA_HOME = rootAi;
process.env.WORKBUDDY_DATA_HOME = rootWb;

eq("AI detect 命中自身目录", AI.detect(), rootAi);
eq("WorkBuddy detect 命中自身目录", WB.detect(), rootWb);
ok("两源 detect 互不串扰", AI.detect() !== WB.detect());
eq("AI validate 通过", AI.validate(rootAi), true);
eq("AI 名字", AI.name, "WorkBuddy AI");
eq("AI id", AI.id, "workbuddy-ai");
eq("AI 无 device-id 时返回 null", AI.getDeviceId(rootAi), null);
eq("WorkBuddy 读取到 device-id", WB.getDeviceId(rootWb), "wb-uuid-0001");

// 目录名前缀陷阱：仅有 .workbuddy-ai 时，WorkBuddy 不得命中
const savedWbHome = process.env.WORKBUDDY_DATA_HOME;
delete process.env.WORKBUDDY_DATA_HOME;
process.env.USERPROFILE = tmp; // 仅本次探测：home=tmp，tmp 下只有 .workbuddy-ai / .workbuddy
process.env.HOME = tmp;
eq("前缀陷阱：home 仅含 .workbuddy-ai 时 WorkBuddy 仍命中 .workbuddy", WB.detect(), rootWb);
process.env.WORKBUDDY_DATA_HOME = savedWbHome;

// ---------- 2. 字段映射 ----------
console.log("\n[2] 字段映射");
const all = AI.extract(rootAi, "dev-1", "测试机", 0);
eq("记录数（跳过 user/非 message/损坏行/重复 messageId，不含非 jsonl 兄弟文件）", all.length, 3);

const r1 = all.find((r) => r.id === "dev-1:workbuddy-ai:msg-ai-1");
const r2 = all.find((r) => r.id === "dev-1:workbuddy-ai:msg-ai-2");
const r3 = all.find((r) => r.id === "dev-1:workbuddy-ai:msg-ai-3");
ok("三条记录均存在", !!(r1 && r2 && r3));

eq("source = workbuddy-ai", r1.source, "workbuddy-ai");
eq("id 前缀隔离", r1.id, "dev-1:workbuddy-ai:msg-ai-1");
eq("inputTokens", r1.inputTokens, 10000);
eq("outputTokens", r1.outputTokens, 200);
eq("cacheReadTokens（input 含缓存命中）", r1.cacheReadTokens, 3000);
eq("reasoningTokens 从 rawUsage 补入", r1.reasoningTokens, 150);
eq("cacheCreationTokens 从 rawUsage 补入", r1.cacheCreationTokens, 500);
eq("带点版本号模型不被截断", r1.modelId, "deepseek-v4.1-flash");
eq("providerId 按模型前缀推断", r1.providerId, "DeepSeek");
eq("variant 取 requestModelId", r1.variant, "auto");
eq("sessionId", r1.sessionId, "sid-ai-0001");
eq("completed 归一为 success", r1.status, "success");
eq("startedAt = timestamp(ms)", r1.startedAt, T1);

// 缺失缓存字段 → 0；未知模型 → 供应商兜底名（不用「未知供应商」）
eq("缺失 cache_read → 0", r2.cacheReadTokens, 0);
eq("缺失 reasoning → 0", r2.reasoningTokens, 0);
eq("缺失 cache_creation → 0", r2.cacheCreationTokens, 0);
eq("未知模型归一", r2.modelId, "hy3");
eq("未知模型供应商兜底为展示名", r2.providerId, "WorkBuddy AI");
eq("重复 messageId 保留首条（token 未被后行覆盖）", r2.inputTokens, 5000);

// flat 目录（不带时间戳）同样命中
eq("不带时间戳的项目目录亦被递归命中", r3.sessionId, "sid-ai-0002");
eq("error 状态原样透传", r3.status, "error");
eq("gpt* → OpenAI", r3.providerId, "OpenAI");

// 非 .jsonl 兄弟文件不得被扫
ok("file-rollback.ndjson 未被扫描", !all.some((r) => r.id.includes("ROLLBACK-SHOULD-NOT-BE-SCANNED")));
ok("meta.json 未被扫描", !all.some((r) => r.id.includes("META-SHOULD-NOT-BE-SCANNED")));

// credits 绝不入库（db.cjs 会把 credits 计入 token 总量，写入即双重计量）
ok("记录不含 credits 字段", !("credits" in r1) && !("credits" in r2) && !("credits" in r3));

// ---------- 3. 排序与增量 ----------
console.log("\n[3] 排序与增量");
eq("按 startedAt 升序", all.map((r) => r.startedAt).join(","), [T1, T1 + 1000, T2].join(","));

const inc1 = AI.extract(rootAi, "dev-1", "测试机", T1 + 1);
eq("增量：晚于 since 的条目", inc1.length, 2);
ok("增量不含早于 since 的条目", !inc1.some((r) => r.id.endsWith("msg-ai-1")));
ok("增量含较晚条目", inc1.some((r) => r.id.endsWith("msg-ai-2")) && inc1.some((r) => r.id.endsWith("msg-ai-3")));

const inc2 = AI.extract(rootAi, "dev-1", "测试机", Date.now() + 10000);
eq("增量：since 晚于全部 → 0 条（mtime 粗筛）", inc2.length, 0);

eq("since=0 全量不受 mtime 影响", AI.extract(rootAi, "dev-1", "测试机", 0).length, 3);

// ---------- 4. 幂等 ----------
console.log("\n[4] 幂等");
const ids = (a) => a.map((r) => r.id).sort().join("|");
eq("重复抽取 id 集合一致", ids(AI.extract(rootAi, "dev-1", "测试机", 0)), ids(all));
eq("重复抽取内容一致", JSON.stringify(AI.extract(rootAi, "dev-1", "测试机", 0)), JSON.stringify(all));

// ---------- 5. 双源隔离 ----------
console.log("\n[5] WorkBuddy / WorkBuddy AI 双源隔离");
const wbAll = WB.extract(rootWb, "dev-1", "测试机", 0);
eq("WorkBuddy 记录数", wbAll.length, 1);
eq("WorkBuddy source", wbAll[0].source, "workbuddy");
eq("WorkBuddy id 前缀隔离", wbAll[0].id, "dev-1:workbuddy:msg-wb-1");
eq("WorkBuddy 未知模型兜底为自身展示名", wbAll[0].providerId, "智谱 GLM");
ok("两源 id 空间互不冲突", !wbAll.some((r) => all.some((x) => x.id === r.id)));

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.WORKBUDDY_AI_DATA_HOME;
delete process.env.WORKBUDDY_DATA_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
