// Antigravity IDE（新版）数据源适配器
// 会话目录：~/.gemini/antigravity-ide/conversations（*.db SQLite）
// 应用数据：%APPDATA%/Antigravity IDE（含 User/globalStorage/state.vscdb）
// 用量统计：本地语言服务配额快照差值（见 adapter-antigravity-common.cjs）
"use strict";
const { makeAdapter } = require("./adapter-antigravity-common.cjs");

module.exports = makeAdapter(
  "antigravity-ide",
  "Antigravity IDE",
  "antigravity-ide",
  "Antigravity IDE",
  "antigravity ide",
  null
);
