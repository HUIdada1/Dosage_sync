<script setup lang="ts">
import { computed } from "vue";import { useAppStore } from "../stores/app";
import { useUsageStore } from "../stores/usage";
import { formatNumber, timeAgo } from "../composables/useFormat";
import * as api from "../api/ipc";
import type { DeviceMeta } from "../types";
import logoUrl from "../assets/logo.png";

const app = useAppStore();
const usage = useUsageStore();

const baseNavItems = [
  { key: "overview", label: "总览", icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { key: "detail", label: "用量明细", icon: '<path d="M3 4h18M3 12h18M3 20h18"/>' },
  { key: "costs", label: "费用", icon: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>' },
  { key: "billing", label: "计费规则", icon: '<path d="M4 21v-6M4 9V3M12 21v-9M12 6V3M20 21v-4M20 11V3"/><path d="M1.5 15h5M9.5 6h5M17.5 17h5"/>' },
  { key: "log", label: "同步日志", icon: '<path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>' },
  { key: "settings", label: "设置", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
] as const;

// 计费关闭时隐藏「费用」页入口；「计费规则」恒可见（否则无法开启计费）
const navItems = computed(() => baseNavItems.filter((item) => item.key !== "costs" || app.config.billing?.enabled));

const devices = computed(() => usage.devices);
const allTotalTokens = computed(() => usage.devices.reduce((s, d) => s + (d.totalTokens || 0), 0));

function onSelectDevice(deviceId: string | null) {
  if (app.activePage !== "overview") {
    app.setPage("overview");
  }
  usage.selectDevice(deviceId);
}

/** 删除退役设备：后端保证先删 WebDAV 远端数据、成功后才清本地记录 */
async function removeDevice(d: DeviceMeta) {
  const ok = window.confirm(
    `确定删除退役设备「${d.deviceName}」吗？\n\n将同时删除 WebDAV 上的该设备数据与本地记录，不可恢复。`
  );
  if (!ok) return;
  const r = await api.deleteDevice(d.deviceId);
  if (!r || !r.ok) {
    window.alert(r?.message || "删除设备失败");
    return;
  }
  if (usage.selectedDeviceId === d.deviceId) usage.selectedDeviceId = null;
  await usage.refreshDevices();
  await usage.loadOverview();
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <img :src="logoUrl" alt="Dosage Sync" />
      <div>
        <div class="name">Dosage Sync</div>
        <div class="sub">用量同步</div>
      </div>
    </div>

    <div class="nav-label">导航</div>
    <button
      v-for="item in navItems"
      :key="item.key"
      class="nav-item"
      :class="{ active: app.activePage === item.key }"
      @click="app.setPage(item.key)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="item.icon" />
      {{ item.label }}
    </button>

    <div class="nav-label devices">
      <span>设备</span>
      <button
        v-if="usage.selectedDeviceId"
        class="dev-filter-reset"
        @click.stop="usage.selectDevice(null)"
        title="重置为全部电脑汇总"
      >
        全部
      </button>
    </div>

    <!-- 全部电脑汇总选项 -->
    <div
      class="device all-device-item"
      :class="{ selected: usage.selectedDeviceId === null }"
      @click="onSelectDevice(null)"
      title="点击查看所有电脑数据汇总"
    >
      <span class="dot all-dot"></span>
      <div class="info">
        <div class="dname">全部电脑 <span class="tag tag-all">汇总</span></div>
        <div class="dmeta">{{ devices.length }} 台设备合计</div>
      </div>
      <div class="dnum"><b class="mono">{{ formatNumber(allTotalTokens) }}</b></div>
    </div>

    <!-- 各个设备选项 -->
    <div
      v-for="d in devices"
      :key="d.deviceId"
      class="device"
      :class="{
        me: d.isLocal,
        offline: !d.online,
        selected: usage.selectedDeviceId === d.deviceId
      }"
      @click="onSelectDevice(d.deviceId)"
      :title="'点击只查看「' + d.deviceName + '」的用量'"
    >
      <span class="dot"></span>
      <div class="info">
        <div class="dname">{{ d.deviceName }} <span v-if="d.isLocal" class="tag">本机</span></div>
        <div class="dmeta">{{ timeAgo(d.lastSyncAt) }}</div>
      </div>
      <div class="dnum"><b class="mono">{{ formatNumber(d.totalTokens) }}</b></div>
      <button
        v-if="!d.isLocal"
        class="dev-del"
        title="删除该退役设备（同时删除 WebDAV 上的数据）"
        @click.stop="removeDevice(d)"
      >×</button>
    </div>
  </aside>
</template>
