<script setup lang="ts">
import { computed } from "vue";
import { humanDate, formatInteger, formatCost, formatToken, formatPercent } from "../composables/useFormat";
import { useAppStore } from "../stores/app";
import type { HeatmapRow } from "../stores/usage";

const props = defineProps<{ show: boolean; date: string; data: HeatmapRow[] }>();
defineEmits<{ (e: "close"): void }>();

const app = useAppStore();

const day = computed(() => props.data.find((x) => x.date === props.date));
const total = computed(() => (day.value ? day.value.total : 0));
const cost = computed(() => (day.value && day.value.cost != null ? day.value.cost : null));
const currency = computed(() => app.config.billing?.displayCurrency || "CNY");
// 缓存命中率：与总览卡片同口径 cacheRead/input（input 含 cache_read），当日无调用时显示 —
const hitRate = computed(() => {
  const d = day.value;
  if (!d || !d.callCount) return null;
  return d.inputTokens && d.inputTokens > 0 ? (d.cacheReadTokens || 0) / d.inputTokens : 0;
});
const callCount = computed(() => (day.value && day.value.callCount != null ? day.value.callCount : 0));
</script>

<template>
  <Teleport to="body">
    <div class="overlay" :class="{ show }" @click="$emit('close')"></div>
    <div class="modal" :class="{ show }">
      <div class="m-head">
        <h3>{{ date ? humanDate(date) : "" }} · 当日用量</h3>
        <button class="d-close" @click="$emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="m-body">
        <div class="total-row">
          <span class="big mono">{{ formatToken(total) }}</span>
          <span class="sw">当日消耗</span>
        </div>
        <div v-if="app.config.billing?.enabled && cost !== null" class="total-row" style="margin-top: 8px">
          <span class="big mono" style="font-size: 18px">{{ formatCost(cost, 2, currency) }}</span>
          <span class="sw">当日费用</span>
        </div>
        <div class="total-row" style="margin-top: 8px">
          <span class="big mono" style="font-size: 15px">{{ hitRate !== null ? formatPercent(hitRate) : "—" }}</span>
          <span class="sw">缓存命中率</span>
        </div>
        <div class="total-row" style="margin-top: 8px">
          <span class="big mono" style="font-size: 15px">{{ formatInteger(callCount) }}</span>
          <span class="sw">调用次数</span>
        </div>
        <p class="m-hint">当日输入 / 输出 / 推理的分项构成，请在「用量明细」页按日期筛选查看。</p>
      </div>
    </div>
  </Teleport>
</template>