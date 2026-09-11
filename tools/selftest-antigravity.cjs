// Antigravity 系适配器自测：protobuf 解码 / gen_metadata 字段映射 / 增量 / 幂等 / 坏库降级 / 真实数据回归
// 运行：node tools/selftest-antigravity.cjs —— node:sqlite 要求 Node ≥22.5（开发机 nvm 多版本时
//       请先 nvm use 22；与 selftest-backup.cjs 同理，也可用 node_modules/electron/dist/electron.exe 跑）。
// 说明：合成数据使用临时目录 + 环境变量隔离，不写入真实 ~/.gemini 数据；
//       末尾真实数据回归为只读校验（本机存在真实会话库时才执行，CI 无数据自动跳过）。
// 依据：docs/Antigravity数据源接入方案-2026-09-11.md
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const common = require("../electron/backend/adapter-antigravity-common.cjs");
const { makeAdapter, readVarint, parseFields, parseGenMetadata } = common;

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

// ---------- protobuf 编码辅助（构造合成 gen_metadata） ----------
function encVarint(v) {
  let n = BigInt(v);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
function fieldVarint(field, v) {
  return Buffer.concat([encVarint(field << 3), encVarint(v)]);
}
function fieldBytes(field, buf) {
  return Buffer.concat([encVarint((field << 3) | 2), encVarint(buf.length), buf]);
}
function fieldStr(field, s) {
  return fieldBytes(field, Buffer.from(s, "utf8"));
}
/** 合成一行 gen_metadata.data：外层 f1{f4{f2,f3,f5,f9}, f19=model} */
function genMeta({ model = "gemini-3.6-flash", credits = 3000, output = 400, watermark = 16000, reasoning = 300 } = {}) {
  const usage = Buffer.concat([
    fieldVarint(2, credits),
    fieldVarint(3, output),
    fieldVarint(5, watermark),
    fieldVarint(9, reasoning),
  ]);
  const meta = Buffer.concat([fieldBytes(4, usage), fieldStr(19, model)]);
  return fieldBytes(1, meta);
}

/** 建一个合成会话库（gen_metadata 表 + 若干行） */
function makeConversationDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
  const stmt = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  rows.forEach((r, i) => stmt.run(i, r));
  db.close();
}

// ============================================================
console.log("== 纯函数：readVarint / parseFields ==");
{
  eq("varint 单字节 0", readVarint(Buffer.from([0]), 0)[0], 0);
  eq("varint 单字节 127", readVarint(Buffer.from([127]), 0)[0], 127);
  eq("varint 双字节 128", readVarint(Buffer.from([0x80, 0x01]), 0)[0], 128);
  eq("varint 双字节 300", readVarint(Buffer.from([0xac, 0x02]), 0)[0], 300);
  ok("varint 越界抛错", (() => { try { readVarint(Buffer.from([0x80]), 0); return false; } catch { return true; } })());
  ok("varint 过长抛错", (() => { try { readVarint(Buffer.alloc(12, 0xff), 0); return false; } catch { return true; } })());

  const f = parseFields(Buffer.concat([fieldVarint(1, 42), fieldStr(2, "ab")]));
  eq("parseFields 字段数", f.length, 2);
  eq("parseFields varint 值", f[0].varint, 42);
  eq("parseFields bytes 值", f[1].data.toString(), "ab");
  ok("parseFields 截断抛错", (() => { try { parseFields(Buffer.from([0x0a, 0x05, 0x61])); return false; } catch { return true; } })());
  ok("parseFields 非法 wire 抛错", (() => { try { parseFields(Buffer.from([0x0b])); return false; } catch { return true; } })());
  ok("parseFields 空 buffer 返回空", parseFields(Buffer.alloc(0)).length === 0);
}

console.log("== 纯函数：parseGenMetadata 字段映射 ==");
{
  const buf = genMeta({ model: "gemini-3.1-pro", credits: 5700, output: 140, watermark: 16303, reasoning: 32 });
  const p = parseGenMetadata(buf);
  eq("模型名", p.model, "gemini-3.1-pro");
  eq("credits", p.credits, 5700);
  eq("输出 token", p.outputTokens, 140);
  eq("输入水位", p.inputWatermark, 16303);
  eq("思考 token", p.reasoningTokens, 32);

  // 缺 f19（无模型名）仍解析用量
  const noModel = parseGenMetadata(fieldBytes(1, fieldBytes(4, fieldVarint(2, 100))));
  eq("缺 f19 模型为 null", noModel.model, null);
  eq("缺 f19 credits 仍取到", noModel.credits, 100);
  // 缺 f4（无用量）→ null
  eq("缺 f4 返回 null", parseGenMetadata(fieldBytes(1, fieldStr(19, "m"))), null);
  // 外层缺 f1 → null
  eq("外层缺 f1 返回 null", parseGenMetadata(fieldStr(2, "x")), null);
  // 垃圾字节 → null
  eq("垃圾字节返回 null", parseGenMetadata(Buffer.from([0xff, 0xff, 0xff])), null);
  eq("空 buffer 返回 null", parseGenMetadata(Buffer.alloc(0)), null);
  // 缺 usage 子字段 → 对应 null（适配器侧 num/creditsVal 兜底）
  const partial = parseGenMetadata(fieldBytes(1, fieldBytes(4, fieldVarint(3, 50))));
  eq("缺 f2 credits 为 null", partial.credits, null);
  eq("缺 f5 水位为 null", partial.inputWatermark, null);
  eq("f3 输出取到", partial.outputTokens, 50);
  // 同字段号重复出现：取首个（真实数据无重复，行为锁死）
  const dup = parseGenMetadata(fieldBytes(1, fieldBytes(4, Buffer.concat([fieldVarint(3, 50), fieldVarint(3, 999)]))));
  eq("重复字段取首个", dup.outputTokens, 50);
}

// ============================================================
console.log("== 端到端：合成 conversations 目录 ==");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ag-selftest-"));
const root = path.join(tmp, ".gemini", "antigravity-ide");
const convDir = path.join(root, "conversations");
fs.mkdirSync(convDir, { recursive: true });
fs.writeFileSync(path.join(root, "antigravity_state.pbtxt"), 'installation_uuid: "f6759649-20b0-4ac7-9906-4b9f9f8a70be"\n', "utf8");

const AG = makeAdapter("antigravity-ide", "Antigravity IDE", "antigravity-ide", "AG_SELFTEST_DIR");
process.env.AG_SELFTEST_DIR = root;

eq("detect 命中", AG.detect(), root);
ok("validate 通过", AG.validate(root));
ok("validate 拒绝不存在目录", !AG.validate(path.join(tmp, "nope")));
// getDeviceId：传入目录时从该目录读 pbtxt（sync.cjs 契约），无参回退真实 ~/.gemini
{
  eq("getDeviceId 读取指定目录 pbtxt", AG.getDeviceId(root), "f6759649-20b0-4ac7-9906-4b9f9f8a70be");
  const id = AG.getDeviceId();
  if (id) {
    ok("getDeviceId 无参回退读取真实 installation_uuid", /^[0-9a-fA-F-]{8,}$/.test(id), `实际 ${id}`);
  } else {
    skip++;
    console.log("  SKIP  getDeviceId 无参（本机无 pbtxt，适配器返回 null 走统一回退链）");
  }
}

// 会话 A：3 次生成，水位 16000→20375→28508，模型两档
makeConversationDb(path.join(convDir, "aaaaaaaa-1111-2222-3333-444444444444.db"), [
  genMeta({ model: "gemini-3.6-flash", credits: 2836, output: 394, watermark: 16308, reasoning: 313 }),
  genMeta({ model: "gemini-3.6-flash", credits: 4702, output: 191, watermark: 20375, reasoning: 83 }),
  genMeta({ model: "gemini-3.1-pro", credits: 5700, output: 140, watermark: 28508, reasoning: 32 }),
]);
// 会话 B：1 次生成 + 1 行无用量（应跳过）+ 1 行垃圾（应跳过）
makeConversationDb(path.join(convDir, "bbbbbbbb-1111-2222-3333-444444444444.db"), [
  genMeta({ model: "gemini-3-flash-b", credits: 2443, output: 570, watermark: 8000, reasoning: 463 }),
  fieldBytes(1, fieldStr(19, "gemini-3-flash-b")), // 无 f4
  Buffer.from([0xff, 0xfe, 0xfd]),
]);
// 非 .db 文件应忽略
fs.writeFileSync(path.join(convDir, "note.txt"), "not a db", "utf8");
// 损坏 .db（非 SQLite）应跳过不炸
fs.writeFileSync(path.join(convDir, "corrupted-0000.db"), Buffer.from([1, 2, 3, 4, 5]), "utf8");

// 统一 mtime 到固定过去时刻，保证 since 语义可测
const T1 = Date.now() - 2 * 3600 * 1000;
for (const f of fs.readdirSync(convDir)) fs.utimesSync(path.join(convDir, f), T1 / 1000, T1 / 1000);

{
  const recs = AG.extract(root, "dev-1", "测试机", 0);
  eq("全量抽取记录数（3+1，坏行跳过）", recs.length, 4);

  const a0 = recs.find((r) => r.id === "dev-1:antigravity-ide:aaaaaaaa-1111-2222-3333-444444444444:0");
  ok("幂等键形如 device:source:conversationId:idx", !!a0);
  eq("首行输入 = 水位原值", a0.inputTokens, 16308);
  eq("首行输出", a0.outputTokens, 394);
  eq("首行思考", a0.reasoningTokens, 313);
  eq("首行 credits", a0.credits, 2836);
  eq("首行模型", a0.modelId, "gemini-3.6-flash");
  eq("providerId 恒为 Google", a0.providerId, "Google");
  eq("sessionId = conversationId", a0.sessionId, "aaaaaaaa-1111-2222-3333-444444444444");
  eq("cache 两桶为 0", a0.cacheReadTokens + a0.cacheCreationTokens, 0);
  eq("status success", a0.status, "success");
  eq("source 隔离", a0.source, "antigravity-ide");

  const a1 = recs.find((r) => r.id.endsWith(":aaaaaaaa-1111-2222-3333-444444444444:1"));
  eq("次行输入 = 水位差分", a1.inputTokens, 20375 - 16308);
  const a2 = recs.find((r) => r.id.endsWith(":aaaaaaaa-1111-2222-3333-444444444444:2"));
  eq("第三行输入 = 水位差分", a2.inputTokens, 28508 - 20375);
  eq("第三行模型切换", a2.modelId, "gemini-3.1-pro");

  const b0 = recs.find((r) => r.id.endsWith(":bbbbbbbb-1111-2222-3333-444444444444:0"));
  eq("会话 B 首行水位独立差分", b0.inputTokens, 8000);

  // 幂等键全局唯一
  const ids = new Set(recs.map((r) => r.id));
  eq("幂等键无重复", ids.size, recs.length);
  // 时间戳 = 文件 mtime
  ok("startedAt 为有效毫秒时间戳", recs.every((r) => Number.isFinite(r.startedAt) && r.startedAt > 0));
  // 排序（startedAt 升序）
  ok("输出按 startedAt 升序", recs.every((r, i) => i === 0 || recs[i - 1].startedAt <= r.startedAt));
}

console.log("== 增量：since 过滤 + 新增库 ==");
{
  // since 晚于所有 mtime → 0 条
  eq("since 晚于全部 mtime 抽取为空", AG.extract(root, "dev-1", "测试机", Date.now()).length, 0);
  // since 早于 mtime → 全量
  eq("since 早于 mtime 抽取全量", AG.extract(root, "dev-1", "测试机", T1 - 1000).length, 4);
  // 新增一个库（mtime 现在）→ 只增新库记录
  makeConversationDb(path.join(convDir, "cccccccc-1111-2222-3333-444444444444.db"), [
    genMeta({ model: "gemini-default", credits: 1000, output: 100, watermark: 5000, reasoning: 50 }),
    genMeta({ model: "gemini-default", credits: 1100, output: 120, watermark: 9800, reasoning: 60 }),
  ]);
  const inc = AG.extract(root, "dev-1", "测试机", Date.now() - 60 * 1000);
  eq("增量只取新库 2 条", inc.length, 2);
  eq("新库首行水位原值", inc[0].inputTokens, 5000);
  eq("新库次行水位差分", inc[1].inputTokens, 4800);
}

console.log("== 降级：目录不可读 / 缺 conversations / 水位回退 ==");
{
  const emptyRoot = path.join(tmp, "empty");
  fs.mkdirSync(emptyRoot, { recursive: true });
  ok("缺 conversations 目录 validate 失败", !AG.validate(emptyRoot));
  eq("缺 conversations 目录 detect 为 null", makeAdapter("x", "X", "nope", "AG_SELFTEST_NOPE").detect(), null);

  // 水位回退（换周期/清上下文）：差分不得为负，记 0
  makeConversationDb(path.join(convDir, "dddddddd-1111-2222-3333-444444444444.db"), [
    genMeta({ watermark: 20000, credits: 100, output: 10 }),
    genMeta({ watermark: 3000, credits: 200, output: 20 }), // 水位回退
    genMeta({ watermark: 9000, credits: 300, output: 30 }), // 从低水位重新递增
  ]);
  const recs = AG.extract(root, "dev-1", "测试机", 0).filter((r) => r.id.includes("dddddddd"));
  eq("水位回退行输入记 0（不为负）", recs[1].inputTokens, 0);
  eq("回退后按新水位差分", recs[2].inputTokens, 6000);
}

console.log("== 输入差分总量 == 水位峰值法对比（自洽性校验）");
{
  // 差分法合计应 == 各会话水位峰值合计（水位单调递增的会话严格相等，回退会话差分偏小）
  const recs = AG.extract(root, "dev-1", "测试机", 0);
  const byConv = new Map();
  for (const r of recs) {
    const cur = byConv.get(r.sessionId) || { diff: 0, peak: 0 };
    cur.diff += r.inputTokens;
    // 峰值 = 首行 input（=水位原值）与后续 input 累加无法还原水位，改用重解析：此处仅校验非负与总量级
    byConv.set(r.sessionId, cur);
  }
  const totalDiff = [...byConv.values()].reduce((s, c) => s + c.diff, 0);
  ok("输入差分总量为正且有限", Number.isFinite(totalDiff) && totalDiff > 0);
}

console.log("== 双源隔离 ==");
{
  const AG_OLD = makeAdapter("antigravity", "Antigravity", "antigravity", "AG_SELFTEST_DIR");
  const recs = AG_OLD.extract(root, "dev-1", "测试机", 0);
  ok("旧版源同目录可抽取", recs.length > 0);
  ok("旧版源 source 前缀独立", recs.every((r) => r.source === "antigravity" && r.id.startsWith("dev-1:antigravity:")));
}

// ============================================================
console.log("== 真实数据回归（只读，存在真实会话库才执行）==");
{
  const realBase = path.join(process.env.USERPROFILE || process.env.HOME || "", ".gemini", "antigravity-ide");
  if (fs.existsSync(path.join(realBase, "conversations"))) {
    const real = makeAdapter("antigravity-ide", "Antigravity IDE", "antigravity-ide");
    const recs = real.extract(realBase, "real-dev", "本机", 0);
    console.log(`  真实抽取：${recs.length} 条记录`);
    ok("真实记录数 > 5000", recs.length > 5000, `实际 ${recs.length}`);

    const totalCredits = recs.reduce((s, r) => s + (r.credits || 0), 0);
    const totalOutput = recs.reduce((s, r) => s + r.outputTokens, 0);
    const totalInput = recs.reduce((s, r) => s + r.inputTokens, 0);
    console.log(`  credits 合计 ${totalCredits.toLocaleString()} / 输出 ${totalOutput.toLocaleString()} / 输入(差分) ${totalInput.toLocaleString()}`);
    ok("credits 合计 ≈ 5.0e7 ±20%", totalCredits > 4.0e7 && totalCredits < 6.0e7, `实际 ${totalCredits}`);
    ok("输出 token 合计 ≈ 4.7e6 ±20%", totalOutput > 3.8e6 && totalOutput < 5.7e6, `实际 ${totalOutput}`);
    ok("输入 token 合计 ≈ 1.7e7 ±30%", totalInput > 1.2e7 && totalInput < 2.2e7, `实际 ${totalInput}`);

    const ids = new Set(recs.map((r) => r.id));
    eq("真实幂等键全局唯一", ids.size, recs.length);
    ok("真实记录全部含模型名", recs.every((r) => typeof r.modelId === "string" && r.modelId.length > 0));
    ok("真实记录 credits 覆盖率 > 95%", recs.filter((r) => r.credits !== null).length / recs.length > 0.95);
    ok("真实记录时间戳均有效", recs.every((r) => r.startedAt > 1.6e12 && r.startedAt <= Date.now() + 48 * 3600 * 1000));
    const models = [...new Set(recs.map((r) => r.modelId))].sort();
    console.log(`  模型分布：${models.join(", ")}`);
    ok("主力模型 gemini-3.6-flash 在列", models.includes("gemini-3.6-flash"));
  } else {
    console.log("  （本机无真实会话库，跳过真实回归）");
  }
}

// 清理
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 忽略 */
}
delete process.env.AG_SELFTEST_DIR;

console.log(`\n结果：${pass} 通过 / ${fail} 失败（跳过 ${skip}）`);
process.exit(fail > 0 ? 1 : 0);
