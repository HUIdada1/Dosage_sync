// 统一用量模型与配置类型 —— 前后端共用结构（Node 侧对应 electron/backend）

/** 统一用量明细（所有数据源归一化后的结构） */
export interface UsageRecord {
  id: string; // 全局唯一 = `${deviceId}:${source}:${源记录id}`
  deviceId: string; // 电脑标识（ZCode 取 deviceMid）
  deviceName: string; // 用户起的电脑名
  source: string; // 软件源："zcode" | "codex" | ...
  providerId: string; // 供应商
  modelId: string; // 具体模型
  variant?: string; // 变体（reasoning 档位 low/max/high）
  taskType?: string;
  sessionId?: string;
  agent?: string;
  mode?: string;

  // 原始 token 分解（不预判口径）
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;

  startedAt: number; // epoch ms
  completedAt?: number;
  durationMs?: number;
  status: string; // success | error | cancelled ...
}

/** 统计口径 */
export type TotalMode = "full" | "compact" | "platform";

/** 总量口径定义 */
export const TOTAL_MODES: Record<TotalMode, { label: string; desc: string }> = {
  full: { label: "完整口径", desc: "输入 + 输出 + 推理" },
  compact: { label: "简洁口径", desc: "输入 + 输出" },
  platform: { label: "跟随平台", desc: "computed_total_tokens" },
};

/** 聚合结果（某维度下的分项统计） */
export interface AggregateRow {
  key: string; // 维度键（模型名 / 供应商名 / 设备名 / 日期）
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number; // 按当前口径计算的总量
  count: number; // 记录条数
}

/** 总览摘要 */
export interface Summary {
  totalTokens: number; // 全部设备总量（当前口径）
  todayTokens: number; // 今日总量
  localTokens: number; // 本机总量
  remoteTokens: number; // 其它设备总量
  cacheHitRate: number; // 缓存命中率（0~1）
  todayCacheHitRate: number; // 今日缓存命中率（0~1）
  cacheReadTokens: number; // 缓存命中量
  inputTokens: number; // 输入总量
  outputTokens: number; // 输出总量
  reasoningTokens: number; // 推理总量
  cacheCreationTokens: number; // 缓存写入量
  todayInputTokens: number; // 今日输入总量
  todayCacheReadTokens: number; // 今日缓存命中量
  deviceCount: number; // 设备数（含本机）
  recordCount: number; // 明细条数
  todayRecordCount: number; // 今日调用次数
  allTotalTokens?: number; // 全网总Token（单机视图时用于计算占比）
  selectedDeviceId?: string | null; // 当前聚焦的设备 ID
}

export interface DeviceBreakdown {
  deviceId: string;
  deviceName: string;
  isLocal: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  recordCount: number;
}

/** 设备元信息 */
export interface DeviceMeta {
  deviceId: string;
  deviceName: string;
  source: string;
  lastSyncAt: number | null;
  online: boolean;
  totalTokens: number;
  isLocal: boolean;
}

/** WebDAV 配置 */
export interface WebDavConfig {
  endpoint: string; // 如 https://dav.example.com/dav
  username: string;
  password: string;
  root: string; // 根目录，如 /dosage-sync
  preset: string; // feiniu | nextcloud | nutstore | synology | custom
}

/** 数据源配置 */
export interface SourceConfig {
  source: string; // zcode / codex / ...
  enabled: boolean;
  dataDir: string | null; // 数据目录（null 表示自动探测）
}

/** 调度配置 */
export interface ScheduleConfig {
  hourly: boolean; // 每小时同步
  hourlyInterval: number; // 小时数
  daily: boolean; // 每天固定时间
  dailyTime: string; // "23:30"
  autoStart: boolean; // 开机自启
  minimizeToTray: boolean; // 关闭最小化到托盘
}

/** 应用配置 */
export interface AppConfig {
  deviceName: string; // 本机电脑名
  webdav: WebDavConfig;
  sources: SourceConfig[];
  schedule: ScheduleConfig;
  totalMode: TotalMode; // 总量口径
  theme: "light" | "dark"; // 主题
  portableMode: boolean; // 便携模式
}

/** 同步日志 */
export interface SyncLog {
  id: number;
  time: number; // epoch ms
  kind: string; // extract | upload | download | merge
  level: "ok" | "error" | "info";
  message: string;
  detail?: string;
}

/** 同步阶段 */
export type SyncStage = "idle" | "extract" | "upload" | "download" | "merge" | "done" | "cancelled" | "error";

/** 同步进度快照 */
export interface SyncProgress {
  running: boolean;
  stage: SyncStage;
  stageLabel: string;
  percent: number; // 0~100
  message: string;
  lastSyncAt?: number | null;
}

export interface SyncLogSnapshot {
  logs: SyncLog[];
  stage: SyncStage;
  percent: number;
  message: string;
}

/** 数据源健康状态 */
export interface SourceHealth {
  source: string;
  name: string;
  detected: boolean;
  dataDir: string | null;
  readable: boolean;
  lastSyncAt: number | null;
}

/** 模型元数据 */
export interface ModelMeta {
  modelId: string;
  kind: "reasoning" | "chat" | "flash" | "embedding" | "other";
  tier: "flagship" | "standard" | "flash";
  providerName: string;
  tags: string[];
  price: { inputPerM: number; outputPerM: number };
}
