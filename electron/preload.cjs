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
  // 本机存储（备份压缩包）
  "get_backup_info",
  "browse_backup_file",
  "restore_backup",
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
  "get_data_dir_info",
  "browse_data_dir",
  "set_data_dir",
  "reset_data_dir",
  "get_app_version",
  "get_is_portable",
  "reset_local_cache",
  "set_autostart",
  // 软件更新
  "get_update_status",
  "check_update",
  "download_update",
  "install_update",
  "open_release_page",
  "open_repo_page",
]);

contextBridge.exposeInMainWorld("dosageSync", {
  invoke: (cmd, args) => {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      return Promise.reject(new Error(`未授权的 IPC 命令：${cmd}`));
    }
    return ipcRenderer.invoke(cmd, args);
  },
  /** 订阅主进程更新事件（唯一固定通道，主进程 updater.cjs 广播）；返回取消订阅函数 */
  onUpdateEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update:event", listener);
    return () => ipcRenderer.removeListener("update:event", listener);
  },
});
