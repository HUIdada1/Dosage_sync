// 用量数据状态：总览摘要、设备、趋势、热力图、聚合、明细
import { defineStore } from "pinia";
import type { AggregateRow, DeviceBreakdown, DeviceMeta, Summary, UsageRecord } from "../types";
import * as api from "../api/ipc";
import { useAppStore } from "./app";

let trendRequestId = 0;
let overviewRequestId = 0;

export const useUsageStore = defineStore("usage", {
  state: () => ({
    summary: null as Summary | null,
    devices: [] as DeviceMeta[],
    deviceBreakdowns: [] as DeviceBreakdown[],
    trend: [] as { date: string; total: number; models?: Record<string, number> }[],
    heatmap: [] as { date: string; total: number }[],
    aggregate: [] as AggregateRow[],
    records: [] as UsageRecord[],
    recordsTotal: 0,
    loading: false,
    loadError: "",
    trendDays: 7, // 趋势图当前范围（天），默认「近七天」
    selectedDeviceId: null as string | null, // null 表示查看全部电脑数据
  }),
  getters: {
    selectedDevice: (s) => (s.selectedDeviceId ? s.devices.find((d) => d.deviceId === s.selectedDeviceId) : undefined),
    isFiltered: (s) => s.selectedDeviceId !== null,
  },
  actions: {
    resetOverview() {
      overviewRequestId++;
      this.summary = null;
      this.devices = [];
      this.deviceBreakdowns = [];
      this.trend = [];
      this.heatmap = [];
      this.selectedDeviceId = null;
      this.loadError = "";
      this.loading = false;
    },
    async loadOverview() {
      const app = useAppStore();
      const mode = app.totalMode;
      const deviceId = this.selectedDeviceId;
      const source = app.activeSource;
      const requestId = ++overviewRequestId;
      this.loading = true;
      try {
        // 热力图滚动一年窗口：今天往前 364 天 → 今天（最右侧恒为今天）
        const now = new Date();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const start = new Date(end);
        start.setDate(start.getDate() - 364);
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const [summary, devices, deviceBreakdowns, trend, heatmap] = await Promise.all([
          api.getSummary(mode, deviceId, source),
          api.getDevices(mode, source),
          api.getDeviceBreakdowns(mode, deviceId, source),
          api.getTrend(mode, this.trendDays, deviceId, source),
          api.getHeatmap(mode, fmt(start), fmt(end), deviceId, source),
        ]);
        if (requestId !== overviewRequestId) return;
        this.summary = summary;
        this.devices = devices;
        this.deviceBreakdowns = deviceBreakdowns;
        this.trend = trend;
        this.heatmap = heatmap;
        this.loadError = "";
      } catch (e) {
        // 单次查询失败时保留旧数据并给出可见提示，避免切换设备后「看似没反应」
        if (requestId === overviewRequestId) this.loadError = e instanceof Error ? e.message : "总览数据加载失败";
      } finally {
        if (requestId === overviewRequestId) this.loading = false;
      }
    },
    async selectDevice(deviceId: string | null) {
      // 点击即选中；取消选择走「全部电脑」或横幅「查看全部」按钮，避免二次点击误取消
      this.selectedDeviceId = deviceId;
      await this.loadOverview();
    },
    async setDevice(deviceId: string | null) {
      this.selectedDeviceId = deviceId;
      await this.loadOverview();
    },
    async loadTrend(days: number) {
      const app = useAppStore();
      this.trendDays = days;
      const requestId = ++trendRequestId;
      const next = await api.getTrend(app.totalMode, days, this.selectedDeviceId, app.activeSource);
      if (requestId === trendRequestId) this.trend = next;
    },
    async loadAggregate(dim: "model" | "provider" | "device" | "source", from: number | null, to: number | null) {
      const app = useAppStore();
      this.aggregate = (await api.getAggregate(app.totalMode, dim, from, to, app.activeSource)) as AggregateRow[];
    },
    async loadRecords(filter: Parameters<typeof api.getRecords>[0]) {
      const res = await api.getRecords(filter);
      this.records = res.records;
      this.recordsTotal = res.total;
    },
  },
});
