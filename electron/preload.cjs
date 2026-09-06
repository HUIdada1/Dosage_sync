// 预加载脚本：通过 contextBridge 暴露安全的 IPC 调用桥给渲染进程
// 白名单机制：只放行后端 ipc.cjs 已注册的命令，防止渲染进程被注入后调用任意通道（纵深防御）
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_COMMANDS = new Set([
  // 配置
  "load_config",
  "save_config",
  "test_webdav",
  // 数据源
  "list_sources",
  "detect_source",
  "health_source",
  // 汇总查询
  "get_summary",
  "get_trend",
  "get_heatmap",
  "get_aggregate",
  "get_device_breakdowns",
  "get_records",
  // 同步
  "start_sync",
  "cancel_sync",
  "get_sync_progress",
  "get_sync_logs",
  "clear_sync_logs",
  // 设备
  "get_devices",
  "delete_device",
  // 导出
  "export_data",
  // 计费
  "get_prices",
  "get_price_versions",
  "save_price",
  "delete_model_prices",
  "get_unpriced_models",
  "import_prices_preview",
  "import_prices_apply",
  "pull_remote_pricing",
  "get_remote_pricing_status",
  // 其它
  "open_data_dir",
  "get_data_dir",
  "get_app_version",
  "get_is_portable",
  "reset_local_cache",
  "set_autostart",
]);

contextBridge.exposeInMainWorld("dosageSync", {
  invoke: (cmd, args) => {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      return Promise.reject(new Error(`未授权的 IPC 命令：${cmd}`));
    }
    return ipcRenderer.invoke(cmd, args);
  },
});
