// 应用级状态：配置、主题、当前数据源、同步状态
import { defineStore } from "pinia";
import type { AppConfig, SyncProgress, SyncStage, TotalMode } from "../types";
import * as api from "../api/ipc";

const defaultConfig: AppConfig = {
  deviceName: "这台电脑",
  webdav: { endpoint: "", username: "", password: "", root: "/dosage-sync", preset: "feiniu" },
  sources: [
    { source: "zcode", enabled: true, dataDir: null },
    { source: "codex", enabled: false, dataDir: null },
    { source: "dsh", enabled: false, dataDir: null },
    { source: "antigravity", enabled: false, dataDir: null },
    { source: "antigravity-ide", enabled: false, dataDir: null },
  ],
  schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true },
  totalMode: "full",
  theme: "light",
  portableMode: false,
};

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    activePage: "overview" as "overview" | "detail" | "log" | "settings",
    activeSource: "zcode" as string,
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
  },
  actions: {
    async load() {
      try {
      const loaded = await api.loadConfig();
      Object.assign(this.config, loaded);
      if (loaded.webdav) Object.assign(this.config.webdav, loaded.webdav);
      if (loaded.schedule) Object.assign(this.config.schedule, loaded.schedule);
      } catch {
        this.config = { ...defaultConfig };
      }
      this.loaded = true;
      this.applyTheme(this.config.theme);
      this.loadDataDir();
      this.startProgressPolling();
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
    setPage(page: "overview" | "detail" | "log" | "settings") {
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
