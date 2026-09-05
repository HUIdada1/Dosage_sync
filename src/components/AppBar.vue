<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../stores/app";

const app = useAppStore();

const sources = [
  { key: "zcode", label: "ZCode" },
  { key: "codex", label: "Codex" },
  { key: "dsh", label: "DeepSeek Harness" },
  // 【暂时隐藏 Antigravity 系】
  // { key: "antigravity", label: "Antigravity" },
  // { key: "antigravity-ide", label: "Antigravity IDE" },
];

const lastSyncLabel = computed(() => {
  const t = app.sync.lastSyncAt;
  return t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—";
});
</script>

<template>
  <header class="appbar">
    <div class="source-tabs">
      <button
        v-for="s in sources"
        :key="s.key"
        class="source-tab"
        :class="{ active: app.activeSource === s.key }"
        @click="app.setActiveSource(s.key)"
      >
        <span class="dot" v-if="app.isSourceEnabled(s.key)"></span>
        {{ s.label }}
      </button>
    </div>
    <div class="spacer"></div>
    <div class="sync-state">
      <span class="ok-dot"></span>
      <span v-if="app.sync.running">{{ app.sync.message }}</span>
      <span v-else>最后同步 {{ lastSyncLabel }}</span>
    </div>
    <button class="icon-btn" @click="app.toggleTheme()" :title="app.isDark ? '切换浅色' : '切换深色'">
      <svg v-if="!app.isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
    <button class="btn-sync" :class="{ loading: app.syncing }" :disabled="app.syncing" @click="app.startSync()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>
      {{ app.syncing ? "同步中" : "立即同步" }}
    </button>
  </header>
</template>
