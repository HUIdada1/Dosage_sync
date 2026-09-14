// Grok 适配器自测：五桶映射 / 增量 / 幂等 / 多模型 fork / 设备标识 / 边界降级
// 运行：npm run selftest:grok（纯 JSON 读取适配器，系统 Node 即可跑，无需电子内置 Node）
// 说明：使用临时目录 + GROK_HOME 环境变量隔离，不触碰真实 ~/.grok 数据。
//       单位级用例走 _internal.mapEntry（不落库）；端到端用例走 extract/临时 fixture 目录。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GROK = require("../electron/backend/adapter-grok.cjs");
const { mapEntry, num } = GROK._internal;

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

// ===== 临时环境构造（不触碰真实 ~/.grok） =====
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-selftest-"));
const HOME = path.join(tmp, "grok-home");
const sessionsDir = path.join(HOME, "sessions");
const projDir = path.join(sessionsDir, "C%3A%5Cproj");
const sessDir = path.join(projDir, "01a0a035-fe0c-7860-8b3e-a32795958bae");
fs.mkdirSync(sessDir, { recursive: true });
fs.writeFileSync(path.join(HOME, "agent_id"), "ag-xyz\n", "utf8");
process.env.GROK_HOME = HOME;

const CTX = { deviceId: "dev-1", deviceName: "测试机" };
const T0 = 1788540000000; // 2026-09-14 附近
const ISO = (ms) => new Date(ms).toISOString();

const SESSION_ID = "01a0a035-fe0c-7860-8b3e-a32795958bae";
const usagePath = path.join(sessDir, "usage.json");

/** 写入 fixture 账本（sess 级原样覆盖；extraTurns 追加到 sessions/<其他会话>/usage.json） */
function writeUsage(doc) {
  fs.writeFileSync(usagePath, JSON.stringify(doc, null, 2), "utf8");
}

console.log("\n[1] 单位级：mapEntry 五桶映射与边界");
const turn = { turnNumber: 3, endedAt: ISO(T0 + 5000) };
const r1 = mapEntry(CTX, SESSION_ID, turn, "grok-4.5-build", {
  inputTokens: 1000, outputTokens: 100, reasoningTokens: 50, cachedReadTokens: 900, cacheCreationTokens: 10,
});
eq("inputTokens 映射", r1.inputTokens, 1000);
eq("outputTokens", r1.outputTokens, 100);
eq("reasoningTokens", r1.reasoningTokens, 50);
eq("cachedReadTokens → cacheReadTokens", r1.cacheReadTokens, 900);
eq("cacheCreationTokens → cacheCreationTokens", r1.cacheCreationTokens, 10);
eq("provider 恒为 xAI", r1.providerId, "xAI");
eq("model 归一化（grok-4.5-build 保持）", r1.modelId, "grok-4.5-build");
eq("幂等 id 格式", r1.id, `dev-1:grok:${SESSION_ID}:3:grok-4.5-build`);
eq("sessionId 透传", r1.sessionId, SESSION_ID);
eq("时间戳 = turn.endedAt 毫秒", r1.startedAt, T0 + 5000);
eq("status 恒 success", r1.status, "success");
eq("模型名带供应商前缀归一化（xai/grok-4.6 → grok-4.6）",
  mapEntry(CTX, SESSION_ID, turn, "xai/grok-4.6", { inputTokens: 1 }).modelId, "grok-4.6");
eq("五桶全 0 跳过", mapEntry(CTX, SESSION_ID, turn, "grok-4.5", {}) === null, true);
eq("usage 缺失跳过", mapEntry(CTX, SESSION_ID, turn, "grok-4.5", null) === null, true);
eq("负值/非法桶归 0", mapEntry(CTX, SESSION_ID, turn, "m", { inputTokens: 1, outputTokens: -5, cachedReadTokens: "x" }).outputTokens === 0, true);
eq("非法时间戳跳过", mapEntry(CTX, SESSION_ID, { turnNumber: 1, endedAt: "bad" }, "m", { inputTokens: 1 }) === null, true);
eq("num 兜底", num(-1) === 0 && num("n") === 0 && num(7) === 7, true);

console.log("\n[2] 端到端：detect / validate / getDeviceId");
eq("detect() 命中临时 root", GROK.detect(), HOME);
eq("validate() 通过", GROK.validate(HOME), true);
eq("validate() 空目录不通过", GROK.validate(path.join(tmp, "empty")) === false, true);
eq("getDeviceId 读 agent_id", GROK.getDeviceId(HOME), "ag-xyz");
fs.rmSync(path.join(HOME, "agent_id"), { force: true });
eq("getDeviceId 缺失返回 null", GROK.getDeviceId(HOME), null);

console.log("\n[3] 端到端：extract 全量 / 增量 / 幂等 / 多模型 fork");
writeUsage({
  sessionId: SESSION_ID,
  updatedAt: ISO(T0 + 60000),
  session: { inputTokens: 999, primaryModelId: "grok-4.5-build" },
  turns: [
    { turnNumber: 1, endedAt: ISO(T0), modelUsage: { "grok-4.5-build": { inputTokens: 1000, outputTokens: 100, reasoningTokens: 50, cachedReadTokens: 900, cacheCreationTokens: 10 } } },
    { turnNumber: 2, endedAt: ISO(T0 + 60000), modelUsage: {
      "grok-4.5-build": { inputTokens: 2000, outputTokens: 20 },
      "grok-4.6": { inputTokens: 300, outputTokens: 40, reasoningTokens: 10 },
    } },
    { turnNumber: 3, endedAt: ISO(T0 + 120000), modelUsage: { "grok-4.5-build": { inputTokens: 0, outputTokens: 0 } } }, // 全 0 → 跳过
    { turnNumber: 4, endedAt: "not-a-date", modelUsage: { "grok-4.5-build": { inputTokens: 5 } } }, // 非法时间戳 → 跳过
  ],
});
const all = GROK.extract(HOME, "dev-1", "测试机", 0);
eq("全量 3 条（全 0 与非法时间戳被排除）", all.length, 3);
eq("按时间非降序（同 turn 多模型记录时间戳相等）", all.every((r, i) => i === 0 || r.startedAt >= all[i - 1].startedAt), true);
eq("来源全部为 grok", all.every((r) => r.source === "grok"), true);
eq("多模型 fork 各自成条（grok-4.6 独立记录）", all.filter((r) => r.modelId === "grok-4.6").length, 1);
const fork = all.find((r) => r.modelId === "grok-4.6");
ok("grok-4.6 五桶独立映射（户口映射正确）",
  !!fork && fork.inputTokens === 300 && fork.outputTokens === 40 && fork.reasoningTokens === 10,
  JSON.stringify(fork));
eq("幂等 id 含模型维度", fork.id, `dev-1:grok:${SESSION_ID}:2:grok-4.6`);

const inc = GROK.extract(HOME, "dev-1", "测试机", T0 + 30000);
eq("增量：since 过滤后 2 条", inc.length, 2);
eq("增量不含 turn1", inc.every((r) => r.startedAt > T0 + 30000), true);

const again = GROK.extract(HOME, "dev-1", "测试机", 0);
const ids = (a) => a.map((r) => r.id + "|" + r.inputTokens + "," + r.outputTokens + "," + r.reasoningTokens + "," + r.cacheReadTokens + "," + r.cacheCreationTokens).join(";");
eq("幂等：重复抽取 id 与五桶一致", ids(again), ids(all));

console.log("\n[4] 边界降级：坏 JSON / turns 缺失 / mtime 早于 since / sessionId 回退目录名");
// 半截 JSON：跳过不抛错
fs.writeFileSync(usagePath, '{"sessionId": "x", "turns": [', "utf8");
eq("半截 JSON 跳过不抛错", GROK.extract(HOME, "dev-1", "测试机", 0).length, 0);
// turns 缺失：跳过
writeUsage({ sessionId: "no-turns" });
eq("turns 缺失跳过", GROK.extract(HOME, "dev-1", "测试机", 0).length, 0);
// sessionId 缺失回退会话目录名
writeUsage({ turns: [{ turnNumber: 1, endedAt: ISO(T0), modelUsage: { "grok-4.5": { inputTokens: 11 } } }] });
const fallback = GROK.extract(HOME, "dev-1", "测试机", 0);
eq("sessionId 回退目录名且可出记录", fallback[0].sessionId, SESSION_ID);
// mtime 早于 since：整文件跳过（先造未来轮次再把文件 mtime 拨回过去）
writeUsage({ sessionId: SESSION_ID, turns: [{ turnNumber: 1, endedAt: ISO(T0 + 999000), modelUsage: { "grok-4.5": { inputTokens: 11 } } }] });
const past = new Date(); past.setFullYear(2020);
fs.utimesSync(usagePath, past, past);
eq("mtime 早于 since 跳过", GROK.extract(HOME, "dev-1", "测试机", T0 + 500000).length, 0);
eq("mtime 优化不丢数据（since=0 仍全量）", GROK.extract(HOME, "dev-1", "测试机", 0).length, 1);

console.log("\n[5] 真实数据只读抽查（本机已装 Grok CLI 时）");
const realHome = path.join(process.env.USERPROFILE || ".", ".grok");
if (fs.existsSync(path.join(realHome, "sessions"))) {
  fs.utimesSync(usagePath, new Date(), new Date()); // 还原临时文件时间，避免影响后续清理想法
  const real = GROK.extract(realHome, "dev-local", "本机", 0);
  ok(`真实账本可读：${real.length} 条事件`, real.length > 0, "条数为 0");
  ok("真实账本 provider 全为 xAI", real.every((r) => r.providerId === "xAI"), undefined);
  const models = [...new Set(real.map((r) => r.modelId))];
  console.log(`  真实模型清单：${models.join(" / ")}`);
} else {
  console.log("  SKIP  本机未安装 Grok CLI，跳过真实库抽查");
}

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
delete process.env.GROK_HOME;

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);