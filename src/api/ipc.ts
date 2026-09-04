// IPC 封装：Electron 环境下通过 preload 桥接调用主进程；浏览器环境下回退到本地 mock（便于独立开发/预览 UI）。
import type {
  AppConfig, Summary, DeviceMeta, DeviceBreakdown, SyncLog, SyncProgress, SourceHealth, UsageRecord, TotalMode, AggregateRow,
} from "../types";
import { mock } from "./mock";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Electron preload 桥接（window.dosageSync.invoke） */
declare global {
  interface Window {
    dosageSync?: { invoke: InvokeFn };
  }
}

function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.dosageSync;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isElectron()) {
    return (await window.dosageSync!.invoke(cmd, args)) as T;
  }
  // 浏览器回退：直接走 mock
  return (await mock.invoke(cmd, args)) as T;
}

// ===== 配置 =====
export const loadConfig = () => call<AppConfig>("load_config");
export const saveConfig = (cfg: AppConfig) => call<{ ok: boolean; message: string }>("save_config", { config: JSON.parse(JSON.stringify(cfg)) });
export const testWebdav = (cfg: AppConfig["webdav"]) => call<{ ok: boolean; message: string; latencyMs?: number }>("test_webdav", { config: { ...cfg } });

// ===== 数据源 =====
export const detectSource = (source: string) => call<{ ok: boolean; path: string | null; deviceId: string | null }>("detect_source", { source });
export const healthSource = () => call<SourceHealth[]>("health_source");

// ===== 汇总查询 =====
export const getSummary = (mode: TotalMode, deviceId?: string | null, source?: string | null) => call<Summary>("get_summary", { mode, deviceId, source });
export const getDevices = (mode: TotalMode, source?: string | null) => call<DeviceMeta[]>("get_devices", { mode, source });
export const getDeviceBreakdowns = (mode: TotalMode, deviceId?: string | null, source?: string | null) => call<DeviceBreakdown[]>("get_device_breakdowns", { mode, deviceId, source });
export const getTrend = (mode: TotalMode, days: number, deviceId?: string | null, source?: string | null) => call<{ date: string; total: number; models?: Record<string, number> }[]>("get_trend", { mode, days, deviceId, source });
export const getHeatmap = (mode: TotalMode, start: string, end: string, deviceId?: string | null, source?: string | null) => call<{ date: string; total: number }[]>("get_heatmap", { mode, start, end, deviceId, source });
export const getAggregate = (mode: TotalMode, dim: "model" | "provider" | "device" | "source", from: number | null, to: number | null, source?: string | null) =>
  call<AggregateRow[]>("get_aggregate", { mode, dim, from, to, source });
export const getRecords = (filter: {
  from: number | null; to: number | null; deviceId: string | null; source: string | null;
  model: string | null; provider: string | null; status: string | null; limit: number; offset: number;
}) => call<{ records: UsageRecord[]; total: number }>("get_records", filter);

// ===== 同步 =====
export const startSync = () => call<void>("start_sync");
export const cancelSync = () => call<void>("cancel_sync");
export const getSyncProgress = () => call<SyncProgress>("get_sync_progress");
export const getSyncLogs = () => call<SyncLog[]>("get_sync_logs");
export const clearSyncLogs = () => call<void>("clear_sync_logs");

// ===== 导出 =====
export const exportData = (format: "csv" | "json", from: number | null, to: number | null) =>
  call<{ ok: boolean; path: string | null; message: string }>("export_data", { format, from, to });

// ===== 其它 =====
export const openDataDir = () => call<void>("open_data_dir");
export const getDataDir = () => call<string>("get_data_dir");
export const getAppVersion = () => call<string>("get_app_version");
export const getModelMetas = () => call<Record<string, { kind: string; tier: string; providerName: string }>>("get_model_metas");
export const setAutostart = (enabled: boolean) => call<void>("set_autostart", { enabled });
