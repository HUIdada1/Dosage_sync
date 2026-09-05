// 数据源适配器注册表
// 所有已支持数据源的统一注册表
"use strict";
const zcode = require("./adapter-zcode.cjs");
const codex = require("./adapter-codex.cjs");
const dsh = require("./adapter-dsh.cjs");
// 【暂时隐藏 Antigravity 系】注释掉注册即下线其同步/探测/设置入口，恢复时取消注释即可
// const antigravity = require("./adapter-antigravity.cjs");
// const antigravityIde = require("./adapter-antigravity-ide.cjs");

const sources = [zcode, codex, dsh /* , antigravity, antigravityIde */];

function byId(id) {
  return sources.find((s) => s.id === id);
}

module.exports = { sources, byId };
