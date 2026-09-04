<script setup lang="ts">
import { onMounted, ref } from "vue";
import * as api from "../api/ipc";
import { formatDateTime } from "../composables/useFormat";
import type { SyncLog } from "../types";

const logs = ref<SyncLog[]>([]);

const kindText: Record<string, string> = {
  extract: "抽取", upload: "上传", download: "拉取", merge: "合并",
};

async function load() {
  logs.value = await api.getSyncLogs();
}
onMounted(load);

async function clear() {
  await api.clearSyncLogs();
  logs.value = [];
}
</script>

<template>
  <div>
    <div class="page-title">同步日志</div>
    <div class="page-sub">最近同步记录 · 失败会显示错误码</div>
    <div class="card">
      <div class="filters" style="margin-bottom: 14px">
        <div class="f-group"><label>类型</label><select class="f-select"><option>全部</option><option>上传</option><option>拉取</option><option>合并</option></select></div>
        <div class="f-group"><label>状态</label><select class="f-select"><option>全部</option><option>成功</option><option>失败</option></select></div>
        <div style="flex: 1"></div>
        <button class="btn-ghost" @click="clear">清空日志</button>
      </div>
      <ul class="log-list">
        <li v-for="(l, i) in logs" :key="l.id" class="log-item" :style="{ '--i': i }">
          <div class="licon" :class="l.level">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path v-if="l.level === 'ok'" d="M20 6 9 17l-5-5" />
              <template v-else-if="l.level === 'error'">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </template>
              <path v-else d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div class="lbody">
            <div class="ltitle">{{ kindText[l.kind] || l.kind }} · {{ l.message }}</div>
            <div class="ldesc">{{ l.detail }}</div>
          </div>
          <div class="ltime mono">{{ formatDateTime(l.time) }}</div>
        </li>
      </ul>
    </div>
  </div>
</template>
