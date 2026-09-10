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
    { source: "workbuddy", enabled: true, dataDir: null },
    { source: "reasonix", enabled: true, dataDir: null },
    // 【暂时隐藏 Antigravity 系】
    // { source: "antigravity", enabled: false, dataDir: null },
    // { source: "antigravity-ide", enabled: false, dataDir: null },
  ],
  sourceVisibility: {
    order: ["zcode", "codex", "dsh", "workbuddy", "reasonix"],
    hidden: [],
    initialized: false,
  },
  schedule: { hourly: false, hourlyInterval: 1, daily: false, dailyTime: "23:30", autoStart: false, minimizeToTray: true, notifyOnSuccess: false },
  totalMode: "full",
  theme: "light",
  update: { autoCheck: true },
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

/** 「全部」汇总视图的虚拟源 id：查询时由 querySource 归一化为 null（后端 null = 不按源过滤） */
export const ALL_SOURCES = "all";

export const useAppStore = defineStore("app", {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    loaded: false,
    activePage: "overview" as "overview" | "detail" | "costs" | "billing" | "log" | "settings",
    activeSource: ALL_SOURCES as string,
    // 数据源清单（id/name 来自后端适配器，唯一事实源；enabled 为磁盘配置中的状态）
    sources: [] as SourceInfo[],
    sync: { running: false, stage: "idle" as SyncStage, stageLabel: "", percent: 0, message: "", lastSyncAt: null, localOnly: false } as SyncProgress & { lastSyncAt: number | null },
    syncing: false,
    syncDialogOpen: false,
    syncStartError: "",
    dataDir: "",
  }),
  getters: {
    isDark: (s) => s.config.theme === "dark",
    totalMode: (s) => s.config.totalMode,
    isSourceEnabled: (s) => (source: string) => !!s.config.sources.find((item) => item.source === source)?.enabled,
    sourceName: (s) => (source: string) => (source === ALL_SOURCES ? "全部" : s.sources.find((item) => item.id === source)?.name || source),
    /** 传给后端查询的源参数：「全部」归一化为 null（后端 null = 不按源过滤，即各分类累加） */
    querySource: (s) => (s.activeSource === ALL_SOURCES ? null : s.activeSource),
    /** 顶栏「全部」圆点：任一可见源已启用即亮 */
    anyVisibleSourceEnabled(): boolean {
      return this.visibleSources.some((item) => this.isSourceEnabled(item.id));
    },
    /** 当前激活源是否有数据可看（「全部」= 任一可见源启用） */
    activeSourceEnabled(): boolean {
      return this.activeSource === ALL_SOURCES ? this.anyVisibleSourceEnabled : this.isSourceEnabled(this.activeSource);
    },
    /** 按 sourceVisibility.order 排序后的全部来源（含隐藏项，供设置页排序用） */
    orderedSources: (s) => {
      const vis = s.config.sourceVisibility;
      const rank = new Map((vis.order || []).map((id, i) => [id, i]));
      return [...s.sources].sort(
        (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      );
    },
    /** 顶栏可见来源：按 order 排序 + 过滤 hidden */
    visibleSources: (s) => {
      const vis = s.config.sourceVisibility;
      const hidden = new Set(vis.hidden || []);
      const rank = new Map((vis.order || []).map((id, i) => [id, i]));
      return [...s.sources]
        .filter((item) => !hidden.has(item.id))
        .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    },
  },
  actions: {
    async load() {
      try {
      const loaded = await api.loadConfig();
      Object.assign(this.config, loaded);
      if (loaded.webdav) Object.assign(this.config.webdav, loaded.webdav);
      if (loaded.schedule) Object.assign(this.config.schedule, loaded.schedule);
      if (loaded.update && typeof loaded.update === "object") Object.assign(this.config.update, loaded.update);
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
        this.sources = this.config.sources.map((s) => ({ id: s.source, name: s.source, enabled: s.enabled, visible: true }));
      }
      // 兜底：当前激活项若被隐藏或已不存在，回退到「全部」；「全部」本身永远合法
      if (this.activeSource !== ALL_SOURCES) {
        const visibleIds = this.visibleSources.map((s) => s.id);
        if (!visibleIds.includes(this.activeSource)) this.activeSource = ALL_SOURCES;
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
    /** 切换顶栏项的显示/隐藏（隐藏 ≠ 停用同步） */
    async setSourceVisible(source: string, visible: boolean) {
      const vis = this.config.sourceVisibility;
      const hidden = new Set(vis.hidden || []);
      if (visible) hidden.delete(source);
      else hidden.add(source);
      vis.hidden = Array.from(hidden);
      // 若隐藏的是当前激活项，自动回退到「全部」
      if (!visible && this.activeSource === source) this.activeSource = ALL_SOURCES;
      await this.save();
    },
    /**
     * 排序：将 source 移动到 targetIndex（可见/全部项在 orderedSources 中的下标）。
     * 直接重写 order 数组并持久化。
     */
    async moveSource(source: string, targetIndex: number) {
      const vis = this.config.sourceVisibility;
      const order = this.orderedSources.map((s) => s.id);
      const from = order.indexOf(source);
      if (from < 0) return;
      const to = Math.max(0, Math.min(targetIndex, order.length - 1));
      if (from === to) return;
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      vis.order = order;
      await this.save();
    },
    /** 将来源上移一位 */
    async moveSourceUp(source: string) {
      const idx = this.orderedSources.findIndex((s) => s.id === source);
      if (idx > 0) await this.moveSource(source, idx - 1);
    },
    /** 将来源下移一位 */
    async moveSourceDown(source: string) {
      const idx = this.orderedSources.findIndex((s) => s.id === source);
      if (idx >= 0 && idx < this.orderedSources.length - 1) await this.moveSource(source, idx + 1);
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
