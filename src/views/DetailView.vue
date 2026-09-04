<script setup lang="ts">
import { onMounted, ref, reactive, watch } from "vue";
import { useUsageStore } from "../stores/usage";
import { useAppStore } from "../stores/app";
import { formatInteger, formatDateTime } from "../composables/useFormat";
import * as api from "../api/ipc";
import Drawer from "../components/Drawer.vue";
import type { UsageRecord } from "../types";

const usage = useUsageStore();
const app = useAppStore();

const filter = reactive({
  model: null as string | null,
  provider: null as string | null,
  device: null as string | null,
  status: null as string | null,
});

const page = ref(0);
const pageSize = 20;

const modelOptions = ref<string[]>([]);
const providerOptions = ref<string[]>([]);

const drawerShow = ref(false);
const drawerTitle = ref("");
const drawerRows = ref<{ k: string; v: string }[]>([]);

const statusText: Record<string, { label: string; cls: string }> = {
  success: { label: "成功", cls: "ok" },
  error: { label: "失败", cls: "err" },
  cancelled: { label: "已取消", cls: "warn" },
};

async function load() {
  await usage.loadRecords({
    from: null, to: null,
    deviceId: filter.device, source: app.activeSource,
    model: filter.model, provider: filter.provider, status: filter.status,
    limit: pageSize, offset: page.value * pageSize,
  });
}

async function loadOptions() {
  // 模型 / 供应商下拉从真实数据动态生成，避免硬编码漏项
  const [models, providers] = await Promise.all([
    api.getAggregate(app.totalMode, "model", null, null, app.activeSource),
    api.getAggregate(app.totalMode, "provider", null, null, app.activeSource),
  ]);
  modelOptions.value = models.map((m) => m.key);
  providerOptions.value = providers.map((p) => p.key);
}

onMounted(() => {
  load();
  loadOptions();
});

watch(() => app.activeSource, () => {
  filter.model = null;
  filter.provider = null;
  filter.device = null;
  filter.status = null;
  page.value = 0;
  load();
  loadOptions();
});

watch(() => app.totalMode, () => {
  load();
  loadOptions();
});

function pickModel(e: Event) { filter.model = (e.target as HTMLSelectElement).value || null; page.value = 0; load(); }
function pickProvider(e: Event) { filter.provider = (e.target as HTMLSelectElement).value || null; page.value = 0; load(); }
function pickDevice(e: Event) { filter.device = (e.target as HTMLSelectElement).value || null; page.value = 0; load(); }
function pickStatus(e: Event) { filter.status = (e.target as HTMLSelectElement).value || null; page.value = 0; load(); }

async function exportCsv() { await api.exportData("csv", null, null); }
async function exportJson() { await api.exportData("json", null, null); }

function openRecord(r: UsageRecord) {
  drawerTitle.value = "用量明细详情";
  drawerRows.value = [
    { k: "记录 ID", v: r.id },
    { k: "时间", v: formatDateTime(r.startedAt) },
    { k: "模型", v: r.modelId },
    { k: "供应商", v: r.providerId },
    { k: "变体 variant", v: r.variant || "—" },
    { k: "会话 session_id", v: r.sessionId || "—" },
    { k: "任务类型 task_type", v: r.taskType || "—" },
    { k: "agent", v: r.agent || "—" },
    { k: "模式 mode", v: r.mode || "—" },
    { k: "输入 tokens", v: formatInteger(r.inputTokens) },
    { k: "输出 tokens", v: formatInteger(r.outputTokens) },
    { k: "推理 tokens", v: formatInteger(r.reasoningTokens) },
    { k: "缓存命中", v: formatInteger(r.cacheReadTokens) },
    { k: "缓存写入", v: formatInteger(r.cacheCreationTokens) },
    { k: "状态", v: r.status },
  ];
  drawerShow.value = true;
}

const totalPages = () => Math.max(1, Math.ceil(usage.recordsTotal / pageSize));
</script>

<template>
  <div>
    <div class="page-title">用量明细</div>
    <div class="page-sub">统一用量记录 · 点击任意一行查看完整字段</div>
    <div class="card">
      <div class="filters" style="margin-bottom: 16px">
        <div class="f-group"><label>模型</label>
          <select class="f-select" :value="filter.model || ''" @change="pickModel"><option value="">全部模型</option><option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option></select>
        </div>
        <div class="f-group"><label>供应商</label>
          <select class="f-select" :value="filter.provider || ''" @change="pickProvider"><option value="">全部供应商</option><option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option></select>
        </div>
        <div class="f-group"><label>设备</label>
          <select class="f-select" :value="filter.device || ''" @change="pickDevice"><option value="">全部设备</option><option v-for="d in usage.devices" :key="d.deviceId" :value="d.deviceId">{{ d.deviceName }}</option></select>
        </div>
        <div class="f-group"><label>状态</label>
          <select class="f-select" :value="filter.status || ''" @change="pickStatus"><option value="">全部状态</option><option value="success">成功</option><option value="error">失败</option><option value="cancelled">已取消</option></select>
        </div>
        <div style="flex: 1"></div>
        <button class="btn-outline" @click="exportCsv">导出 CSV</button>
        <button class="btn-outline" @click="exportJson">导出 JSON</button>
      </div>
      <div style="overflow-x: auto">
        <table class="table">
          <thead><tr>
            <th>时间</th><th>模型</th><th>供应商</th><th>输入</th><th>输出</th><th>推理</th><th>缓存命中</th><th>状态</th>
          </tr></thead>
          <tbody>
            <tr v-for="(r, i) in usage.records" :key="r.id" :style="{ '--i': i }" @click="openRecord(r)">
              <td class="mono">{{ formatDateTime(r.startedAt) }}</td>
              <td class="mono">{{ r.modelId }}</td>
              <td>{{ r.providerId }}</td>
              <td class="num mono">{{ formatInteger(r.inputTokens) }}</td>
              <td class="num mono">{{ formatInteger(r.outputTokens) }}</td>
              <td class="num mono">{{ formatInteger(r.reasoningTokens) }}</td>
              <td class="num mono">{{ formatInteger(r.cacheReadTokens) }}</td>
              <td><span class="pill" :class="statusText[r.status]?.cls || 'blue'">{{ statusText[r.status]?.label || r.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span class="pg-info">共 {{ usage.recordsTotal }} 条 · 第 {{ page + 1 }} / {{ totalPages() }} 页</span>
        <button class="btn-ghost" :disabled="page === 0" @click="page--; load()">上一页</button>
        <button class="btn-ghost" :disabled="(page + 1) * pageSize >= usage.recordsTotal" @click="page++; load()">下一页</button>
      </div>
    </div>

    <Drawer :show="drawerShow" :title="drawerTitle" :rows="drawerRows" @close="drawerShow = false" />
  </div>
</template>
