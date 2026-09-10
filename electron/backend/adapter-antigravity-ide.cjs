// Antigravity IDE（新版）数据源适配器
// 用量来源：%APPDATA%/Antigravity IDE/User/globalStorage/state.vscdb 的配额状态缓存
// 设备标识：~/.gemini/antigravity-ide/antigravity_state.pbtxt 的 installation_uuid
// 统计口径与解析细节见 adapter-antigravity-common.cjs
"use strict";
const { makeAdapter } = require("./adapter-antigravity-common.cjs");

module.exports = makeAdapter("antigravity-ide", "Antigravity IDE", "antigravity-ide", "Antigravity IDE");
