// 预加载脚本：通过 contextBridge 暴露安全的 IPC 调用桥给渲染进程
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dosageSync", {
  invoke: (cmd, args) => ipcRenderer.invoke(cmd, args),
});
