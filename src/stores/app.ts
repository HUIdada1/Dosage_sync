// 应用级状态：配置、主题、当前数据源、同步状态
import { defineStore } from "pinia";
import type { AppConfig, SourceInfo, SyncProgress, SyncStage, TotalMode } from "../types";
import * as api from "../api/ipc";

// 浏览器 mock / 后端加载失败时的兜底默认值；后端权威默认值见 electron/backend/config.cjs
import { TOTAL_MODES } from "../types";
const defaultConfig: AppConfig = {
  deviceName: "这台电脑",
  webdav: { endpoint: "", username: "", password: "", root: "/dosage-sync", preset: "feiniu" },
  sources: [
    { source: "zcode", enabled: true, dataDir: null },
    { source: "codex", enabled: false, dataDir: null },
    { source: "dsh", enabled: false, dataDir: null },
    // 【暂时隐藏 Antigravity 系】
    // { source: "antigravity", enabled: false, dataDir: null },
    // { source: "antigravity-ide", enabled: false, dataDir: null },
  ],
  schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true, notifyOnSuccess: false },
  totalMode: "full",
  theme: "light",
  billing: {
    enabled: false,
    displayCurrency: "CNY" as const,
    usdToCny: 7.2,
    importProxy: "",
    remotePricing: {
      enabled: false,
      url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
      hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
      intervalHours: 24,
    },
  },
};

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    activePage: "overview" as "overview" | "detail" | "costs" | "billing" | "log" | "settings",
    activeSource: "zcode" as string,
    // 数据源清单（id/name 来自后端适配器，唯一事实源；enabled 为磁盘配置中的状态）
    sources: [] as SourceInfo[],
    sync: { running: false, stage: "idle" as SyncStage, stageLabel: "", percent: 0, message: "", lastSyncAt: null } as SyncProgress & { lastSyncAt: number | null },
    syncing: false,
    syncDialogOpen: false,
    syncStartError: "",
    dataDir: "",
  }),
  getters: {
    isDark: (s) => s.config.theme === "dark",
    totalMode: (s) => s.config.totalMode,
    isSourceEnabled: (s) => (source: string) => !!s.config.sources.find((item) => item.source === source)?.enabled,
    sourceName: (s) => (source: string) => s.sources.find((item) => item.id === source)?.name || source,
  },
  actions: {
    async load() {
      try {
      const loaded = await api.loadConfig();
      Object.assign(this.config, loaded);
      if (loaded.webdav) Object.assign(this.config.webdav, loaded.webdav);
      if (loaded.schedule) Object.assign(this.config.schedule, loaded.schedule);
      // 口径兜底：后端已归一化，这里再防 mock/异常值（platform 选项已移除，等效 compact）
      if (!TOTAL_MODES[this.config.totalMode]) this.config.totalMode = "compact";
      } catch {
        this.config = { ...defaultConfig };
      }
      this.loaded = true;
      this.applyTheme(this.config.theme);
      this.loadDataDir();
      this.loadSources();
      this.startProgressPolling();
    },
    /** 来源清单：name 唯一事实源在后端适配器，前端不再硬编码；失败时退回本地配置（仅 id） */
    async loadSources() {
      try {
        this.sources = await api.listSources();
      } catch {
        this.sources = this.config.sources.map((s) => ({ id: s.source, name: s.source, enabled: s.enabled }));
      }
    },
    async loadDataDir() {
      try {
        this.dataDir = await api.getDataDir();
      } catch {
        this.dataDir = "";
      }
    },
    async save() {
      return api.saveConfig(this.config);
    },
    applyTheme(theme: "light" | "dark") {
      this.config.theme = theme;
      document.documentElement.setAttribute("data-theme", theme);
    },
    toggleTheme() {
      this.applyTheme(this.isDark ? "light" : "dark");
      this.save();
    },
    setTotalMode(mode: TotalMode) {
      this.config.totalMode = mode;
      this.save();
    },
    setActiveSource(source: string) {
      this.activeSource = source;
    },
    setPage(page: "overview" | "detail" | "costs" | "billing" | "log" | "settings") {
      this.activePage = page;
    },
    async startSync() {
      this.syncing = true;
      this.syncDialogOpen = true;
      this.syncStartError = "";
      // 立即同步前落盘，确保刚编辑的 WebDAV 配置由主进程读取到
      const saved = await api.saveConfig(this.config);
      if (!saved.ok) {
        this.syncing = false;
        this.syncStartError = saved.message;
        this.sync = { ...this.sync, running: false, stage: "error", stageLabel: "失败", message: saved.message };
        return;
      }
      // start_sync 后台运行、立即返回，进度通过轮询 get_sync_progress 更新
      try {
        await api.startSync();
        this.refreshProgress();
      } catch (e) {
        const message = e instanceof Error ? e.message : "同步启动失败";
        this.syncing = false;
        this.sync = { ...this.sync, running: false, stage: "error", stageLabel: "失败", message };
      }
    },
    closeSyncDialog() {
      if (!this.sync.running && !this.syncing) this.syncDialogOpen = false;
    },
    async cancelSync() {
      await api.cancelSync();
    },
    async refreshProgress() {
      const progress = await api.getSyncProgress();
      this.sync = { ...progress, lastSyncAt: progress.lastSyncAt ?? this.sync.lastSyncAt ?? null };
      // 同步结束（含失败/取消）后关闭「同步中」态
      if (!this.sync.running) this.syncing = false;
    },
    // 进度轮询：每 600ms 拉取一次；空闲且非同步中时降频为 1500ms，有同步任务时自动恢复
    startProgressPolling() {
      const tick = async () => {
        try {
          await this.refreshProgress();
        } catch {
          /* 忽略单次轮询错误 */
        }
        const busy = this.sync.running || this.syncing;
        setTimeout(tick, busy ? 600 : 1500);
      };
      tick();
    },
  },
});
