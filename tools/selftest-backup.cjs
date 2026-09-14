// 本机存储（备份压缩包）自测：zip 读写往返 / 备份目录解析 / 备份→改库改配置→整包还原一致性 / 非法包拒绝
// 运行：electron node_modules/electron/dist/electron.exe 不可用时也可 node tools/selftest-backup.cjs
//       但 db.cjs 依赖 node:sqlite（本机 Node 无），故必须用 electron.exe 跑：
//       "node_modules/electron/dist/electron.exe" tools/selftest-backup.cjs
// 说明：monkey-patch os.homedir 指向临时目录，数据目录/配置/备份全部落在临时目录，不触碰真实 ~/.Dosage_sync。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

// ---------- 隔离：homedir/APPDATA 指向临时目录（必须在 require config.cjs 之前） ----------
// APPDATA 也要隔离：config.dataDir() 首次调用会执行 migrateLegacyAppData，把真实机器
// %APPDATA%\DosageSync 的旧版数据复制进临时目录，污染测试断言
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-selftest-"));
const realHomedir = os.homedir;
os.homedir = () => tmp;
process.env.APPDATA = path.join(tmp, "appdata");

const config = require("../electron/backend/config.cjs");
const db = require("../electron/backend/db.cjs");
const sync = require("../electron/backend/sync.cjs");
const zip = require("../electron/backend/zip.cjs");

// ---------- 1. zip 读写往返 ----------
console.log("\n[1] zip 读写往返");
{
  const entries = [
    { name: "dosage-sync.sqlite", data: Buffer.from("x".repeat(300000) + "DB-END", "utf8") },
    { name: "config.json", data: Buffer.from(JSON.stringify({ deviceName: "测试机", 中文键: "值" }), "utf8") },
  ];
  const buf = zip.createZip(entries);
  const out = zip.readZip(buf);
  eq("条目数一致", out.length, 2);
  eq("库名称一致", out[0].name, "dosage-sync.sqlite");
  ok("库内容一致", out[0].data.toString() === entries[0].data.toString());
  ok("配置内容一致（含中文）", out[1].data.toString() === entries[1].data.toString());
  ok("压缩生效（体积明显变小）", buf.length < entries[0].data.length / 5, `zip ${buf.length}B / 原始 ${entries[0].data.length}B`);
  eq("空条目往返", zip.readZip(zip.createZip([])).length, 0);
  let rejected = false;
  try { zip.readZip(Buffer.from("not a zip at all")); } catch { rejected = true; }
  ok("损坏输入被拒绝", rejected);
}

// ---------- 2. 备份目录解析 ----------
console.log("\n[2] 备份目录解析");
const dataDir = config.dataDir();
eq("默认备份目录=数据缓存目录", config.resolveBackupDir({ localBackup: { dir: "" } }), dataDir);
eq("自定义备份目录生效", config.resolveBackupDir({ localBackup: { dir: "D:\\my-backup\\ " } }), "D:\\my-backup");
eq("配置缺失时跟随数据缓存目录", config.resolveBackupDir(null), dataDir);
const customBackup = path.join(tmp, "custom-backup");
eq("自定义备份目录读取（loadConfig 归一化）", (() => {
  config.saveConfig({ ...config.loadConfig(), localBackup: { dir: customBackup } });
  return config.loadConfig().localBackup.dir;
})(), customBackup);
// 还原为默认，后续走数据缓存目录
config.saveConfig({ ...config.loadConfig(), localBackup: { dir: "" } });

// ---------- 3. 备份 → 改库改配置 → 整包还原 ----------
console.log("\n[3] 备份与整包还原");
const T = 1789000000000;
function rec(id, startedAt) {
  return {
    id, deviceId: "dev-test", deviceName: "测试机", source: "zcode", providerId: "测试供应商", modelId: "glm-5.3",
    inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 200,
    startedAt, completedAt: startedAt + 1000, durationMs: 1000, status: "success",
  };
}
db.insertRecords([rec("dev-test:zcode:r1", T), rec("dev-test:zcode:r2", T + 60000)]);
db.addLog("extract", "info", "自测种子日志");
const cfgBefore = config.loadConfig();
cfgBefore.sources.forEach((s) => { s.enabled = false; }); // 全部停用：抽取阶段不读真实数据源，测试完全自包含
cfgBefore.deviceName = "备份时的名字";
config.saveConfig(cfgBefore); // 备份读的是磁盘上的 config.json，改动必须先落盘

(async () => {
  // 3.1 强制备份模式跑一轮（webdav 未配置 → 本地模式：抽取 → 打包）
  const runResult = await sync.run(cfgBefore, { mode: "backup" });
  eq("备份模式 run 完成", runResult && runResult.ok, true);
  const progress = sync.progress();
  eq("完成提示为「备份完成」", progress.message, "备份完成");
  eq("进度阶段 done", progress.stage, "done");

  // 3.2 压缩包内容校验
  const backupPath = path.join(config.resolveBackupDir(cfgBefore), config.BACKUP_FILE);
  ok("压缩包已生成", fs.existsSync(backupPath), backupPath);
  const entries = zip.readZip(fs.readFileSync(backupPath));
  eq("包含汇总库", entries.some((e) => e.name === "dosage-sync.sqlite"), true);
  eq("包含配置文件", entries.some((e) => e.name === "config.json"), true);
  const backupInfo = { lastBackupAt: Number(db.getMeta("local_backup_at")) || 0 };
  ok("备份时间已记账", backupInfo.lastBackupAt > 0);

  // 3.3 备份后追加数据 + 修改配置（这些改动应被整包还原抹掉）
  db.insertRecords([rec("dev-test:zcode:r3", T + 120000), rec("dev-test:zcode:r4", T + 180000)]);
  const cfgMutated = config.loadConfig();
  cfgMutated.deviceName = "备份之后改的名字";
  config.saveConfig(cfgMutated);
  eq("改动已生效（r3 存在）", db.getRecords({ deviceId: "dev-test" }).records.some((r) => r.id === "dev-test:zcode:r3"), true);
  eq("改动已生效（配置名已改）", config.loadConfig().deviceName, "备份之后改的名字");

  // 3.4 非法包拒绝（不得破坏现有数据）
  const badZip = path.join(tmp, "bad.zip");
  fs.writeFileSync(badZip, Buffer.from("definitely not a zip"));
  let rejected = false;
  try { await sync.startRestore(badZip); } catch { rejected = true; }
  ok("非法压缩包被拒绝", rejected);
  eq("拒绝后数据未受影响（r3 仍在）", db.getRecords({ deviceId: "dev-test" }).records.some((r) => r.id === "dev-test:zcode:r3"), true);

  // 3.5 整包还原
  const restoreResult = await sync.startRestore(backupPath);
  eq("还原成功", restoreResult && restoreResult.ok, true);
  const after = db.getRecords({ deviceId: "dev-test", limit: 100 });
  ok("备份后的新增记录已被还原抹掉（无 r3/r4）", !after.records.some((r) => r.id === "dev-test:zcode:r3" || r.id === "dev-test:zcode:r4"));
  ok("备份时的记录完整保留（r1/r2）", after.records.some((r) => r.id === "dev-test:zcode:r1") && after.records.some((r) => r.id === "dev-test:zcode:r2"));
  eq("设置还原到备份时点", config.loadConfig().deviceName, "备份时的名字");
  eq("还原中标志已释放", sync.progress().restoring, false);
  ok("安全副本已清理", !fs.existsSync(db_path(".restore-bak")));
  ok("无 .tmp 残留", !fs.existsSync(path.join(config.dataDir(), "dosage-sync.sqlite.restore-bak")));

  // 3.6 还原后再备份一轮（验证关库重开后的循环可用性）
  db.insertRecords([rec("dev-test:zcode:r5", T + 240000)]);
  const run2 = await sync.run(config.loadConfig(), { mode: "backup" });
  eq("还原后再次备份完成", run2 && run2.ok, true);
  const entries2 = zip.readZip(fs.readFileSync(backupPath));
  const dbEntry2 = entries2.find((e) => e.name === "dosage-sync.sqlite");
  ok("第二次备份包含 r5（覆盖式更新）", dbEntry2 && dbEntry2.data.toString("latin1").includes("dev-test:zcode:r5"));

  finish();
})().catch((e) => {
  fail++;
  console.error(`  FAIL  自测异常中断  →  ${e.stack || e.message}`);
  finish();
});

function db_path(suffix) {
  return config.dbPath() + suffix;
}

function finish() {
  os.homedir = realHomedir;
  console.log(`\n结果：${pass} 通过，${fail} 失败${fail ? "  →  临时目录已保留：" + tmp : "（临时目录 " + tmp + "）"}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* electron 占用时保留 */ }
  process.exit(fail ? 1 : 0);
}
