<script setup lang="ts">
import { onMounted, ref, computed, watch } from "vue";
import { useAppStore } from "../stores/app";
import { useUsageStore } from "../stores/usage";
import { formatNumber, formatCost, formatInteger } from "../composables/useFormat";
import * as api from "../api/ipc";
import EmptyState from "../components/EmptyState.vue";
import type { AggregateRow } from "../types";

const app = useAppStore();
const usage = useUsageStore();

// ===== 汇总（summary 已含费用字段） =====
const summary = computed(() => usage.summary);
const monthTrendPct = computed(() => {
  const s = summary.value;
  if (!s || s.monthCostPrev <= 0) return null;
  return ((s.monthCost - s.monthCostPrev) / s.monthCostPrev) * 100;
});

// ===== 费用趋势（SVG 面积图） =====
const trendRange = ref(30);
const trend = ref<{ date: string; cost: number }[]>([]);
const trendRequestId = ref(0);

const chart = computed(() => {
  const W = 920, H = 250, L = 52, R = 16, T = 18, B = 34;
  const data = trend.value;
  if (!data.length) return null;
  const pw = W - L - R, ph = H - T - B;
  const max = Math.max(...data.map((d) => d.cost), 0.01) * 1.15;
  const x = (i: number) => L + (i / Math.max(data.length - 1, 1)) * pw;
  const y = (v: number) => T + ph - (v / max) * ph;
  const points = data.map((d, i) => `${x(i)},${y(d.cost)}`).join(" ");
  const area = `M${x(0)},${y(0)} L` + data.map((d, i) => `${x(i)},${y(d.cost)}`).join(" L ") + ` L${x(data.length - 1)},${T + ph} Z`;
  const gridLines = [0, 1, 2, 3, 4].map((g) => ({
    y: T + ph - (g / 4) * ph,
    label: "¥" + Math.round((max * g) / 4),
  }));
  const step = Math.max(1, Math.ceil(data.length / 6));
  const xLabels = data.filter((_, i) => i % step === 0).map((d, i) => ({ x: x(i * step), label: d.date.slice(5) }));
  return { W, H, L, R, T, B, max, x, y, points, area, gridLines, xLabels, data };
});

async function loadTrend() {
  const requestId = ++trendRequestId.value;
  const rows = await api.getTrend(app.totalMode, trendRange.value, null, app.activeSource);
  if (requestId === trendRequestId.value) trend.value = rows;
}

function setRange(days: number) {
  trendRange.value = days;
  loadTrend();
}

// ===== 费用榜 =====
const dim = ref<"model" | "provider" | "device">("model");
const dimLabel = computed(() => (dim.value === "model" ? "模型" : dim.value === "provider" ? "供应商" : "设备"));
const rank = ref<AggregateRow[]>([]);
const rankRequestId = ref(0);
const maxCost = computed(() => Math.max(...rank.value.map((r) => r.cost || 0), 0.01));

function sharePct(cost: number): string {
  const pct = (cost / maxCost.value) * 100;
  return pct >= 1 ? pct.toFixed(1) + "%" : "<1%";
}

async function loadRank() {
  const requestId = ++rankRequestId.value;
  const rows = await api.getAggregate(app.totalMode, dim.value, null, null, app.activeSource);
  if (requestId !== rankRequestId.value) return;
  // 后端默认按 token 排序；费用榜语义是按费用降序（未配置的排最后）
  rank.value = [...rows].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
}

function setDim(d: "model" | "provider" | "device") {
  dim.value = d;
  loadRank();
}

// ===== 加载编排：跟随数据源切换与同步完成刷新（与总览页行为一致） =====
const sourceEnabled = computed(() => app.isSourceEnabled(app.activeSource));

function loadAll() {
  if (sourceEnabled.value) {
    usage.loadOverview(); // 复用总览加载（summary 含费用字段）
    loadTrend();
    loadRank();
  } else {
    usage.resetOverview();
    trend.value = [];
    rank.value = [];
  }
}

onMounted(loadAll);
watch(() => app.activeSource, loadAll);
watch(sourceEnabled, loadAll);
let wasRunning = app.sync.running;
watch(() => app.sync.running, (now) => {
  if (wasRunning && !now) loadAll();
  wasRunning = now;
});

function goBilling() {
  app.setPage("billing");
}
</script>

<template>
  <div>
    <template v-if="sourceEnabled">
      <div class="page-title">费用</div>
      <div class="page-sub">
        按模型单价动态计费 · 历史费用跟随价格版本重算 · 显示币种
        <b>{{ app.config.billing?.displayCurrency || "CNY" }}</b>（USD 汇率 {{ app.config.billing?.usdToCny ?? 7.2 }}）
      </div>

      <!-- 未配置价格提醒 -->
      <div v-if="summary && summary.unpricedModels > 0" class="cost-banner anim">
        <span class="bdot warn"></span>
        <div class="btext">
          <b>{{ summary.unpricedModels }}</b> 个模型尚未配置价格，相关 {{ formatInteger(summary.unpricedRecords) }} 条记录暂未计入费用（约
          {{ formatNumber(summary.unpricedTokens) }} tokens）
        </div>
        <button class="btn-outline" @click="goBilling">去计费规则补齐</button>
      </div>

      <!-- 费用 KPI -->
      <div class="kpis cost-kpis" v-if="summary">
        <div class="kpi"><i class="k-line-glow"></i>
          <div class="k-label"><span class="kdot"></span>本月费用</div>
          <div class="k-value mono">{{ formatCost(summary.monthCost) }}</div>
          <div class="k-foot">
            <span v-if="monthTrendPct !== null" class="up" :class="{ down: monthTrendPct < 0 }">{{ monthTrendPct >= 0 ? "+" : "" }}{{ monthTrendPct.toFixed(1) }}%</span>
            <span v-else>—</span>
            较上月同期 · 本月 1 日至今
          </div>
        </div>
        <div class="kpi"><i class="k-line-glow"></i>
          <div class="k-label"><span class="kdot"></span>今日费用</div>
          <div class="k-value mono">{{ formatCost(summary.todayCost) }}</div>
          <div class="k-foot">今日 0 点起 · {{ formatInteger(summary.todayRecordCount) }} 次调用</div>
        </div>
        <div class="kpi"><i class="k-line-glow"></i>
          <div class="k-label"><span class="kdot"></span>累计费用</div>
          <div class="k-value mono">{{ formatCost(summary.totalCost) }}</div>
          <div class="k-foot">全部记录 · {{ (app.config.billing?.displayCurrency || "CNY") === "CNY" ? "USD 部分按汇率折算" : "CNY 部分按汇率折算" }}</div>
        </div>
        <div class="kpi" :class="{ 'warn-kpi': summary.unpricedModels > 0 }"><i class="k-line-glow"></i>
          <div class="k-label"><span class="kdot"></span>未配置价格</div>
          <div class="k-value mono">{{ summary.unpricedModels }} <span class="unit">个模型</span></div>
          <div class="k-foot">{{ formatInteger(summary.unpricedRecords) }} 条记录 · {{ formatNumber(summary.unpricedTokens) }} tokens 未计入</div>
        </div>
      </div>
      <div class="skeleton sk-kpi" v-else style="height: 96px; margin-bottom: 18px"></div>

      <!-- 费用趋势 -->
      <div class="card">
        <div class="card-head">
          <h2>费用趋势</h2><span class="hint">每日费用（{{ app.config.billing?.displayCurrency || "CNY" }}）· 悬停查看单日金额</span>
          <div class="right">
            <div class="tabs">
              <button class="tab" :class="{ active: trendRange === 7 }" @click="setRange(7)">近7天</button>
              <button class="tab" :class="{ active: trendRange === 30 }" @click="setRange(30)">近30天</button>
              <button class="tab" :class="{ active: trendRange === 90 }" @click="setRange(90)">近90天</button>
            </div>
          </div>
        </div>
        <div v-if="chart" class="chart-wrap">
          <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" preserveAspectRatio="none" style="width: 100%; height: auto">
            <defs>
              <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="var(--accent)" stop-opacity=".22" />
                <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <g v-for="(g, i) in chart.gridLines" :key="'g' + i">
              <line :x1="chart.L" :x2="chart.W - chart.R" :y1="g.y" :y2="g.y" stroke="var(--border)" stroke-dasharray="2 5" />
              <text :x="chart.L - 8" :y="g.y + 3.5" text-anchor="end" class="chart-axis">{{ g.label }}</text>
            </g>
            <path :d="chart.area" fill="url(#costGrad)" />
            <polyline :points="chart.points" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
            <line :x1="chart.x(chart.data.length - 1)" :x2="chart.x(chart.data.length - 1)" :y1="chart.T" :y2="chart.T + (chart.H - chart.T - chart.B)" stroke="var(--border-strong)" stroke-dasharray="3 4" />
            <circle v-for="(d, i) in chart.data" :key="'p' + i" :cx="chart.x(i)" :cy="chart.y(d.cost)" r="3"
              fill="var(--surface)" stroke="var(--accent)" stroke-width="1.6" class="chart-dot">
              <title>{{ d.date }} · {{ formatCost(d.cost) }}</title>
            </circle>
            <text v-for="(l, i) in chart.xLabels" :key="'x' + i" :x="l.x" :y="chart.H - 10" text-anchor="middle" class="chart-axis">{{ l.label }}</text>
          </svg>
        </div>
        <div v-else class="skeleton sk-chart" style="height: 230px; margin-bottom: 0"></div>
      </div>

      <!-- 费用榜 -->
      <div class="card">
        <div class="card-head">
          <h2>费用榜</h2><span class="hint">全部时间 · {{ app.sourceName(app.activeSource) }} · 按费用降序</span>
          <div class="right">
            <div class="tabs">
              <button class="tab" :class="{ active: dim === 'model' }" @click="setDim('model')">按模型</button>
              <button class="tab" :class="{ active: dim === 'provider' }" @click="setDim('provider')">按供应商</button>
              <button class="tab" :class="{ active: dim === 'device' }" @click="setDim('device')">按设备</button>
            </div>
          </div>
        </div>
        <div style="overflow-x: auto">
          <table class="table">
            <thead><tr>
              <th style="width: 28px"></th><th>{{ dimLabel }}</th>
              <th class="num">调用</th><th class="num">Token</th><th class="num">费用</th><th>费用占比</th>
            </tr></thead>
            <tbody>
              <tr v-for="(r, i) in rank" :key="r.key" :style="{ '--i': i }">
                <td class="rank-cell mono">{{ i + 1 }}</td>
                <td class="mono">{{ r.key }}</td>
                <td class="num mono">{{ formatInteger(r.count) }}</td>
                <td class="num mono">{{ formatNumber(r.totalTokens) }}</td>
                <td class="num mono cost-col">
                  <span v-if="r.cost > 0 || r.unpricedRecords === 0">{{ formatCost(r.cost) }}</span>
                  <span v-else class="pill warn">未配置价格</span>
                </td>
                <td>
                  <span class="share">
                    <span class="track"><span class="fill" :style="{ width: Math.max((r.cost / maxCost) * 100, 1.2) + '%' }"></span></span>
                    <span class="pct mono">{{ sharePct(r.cost) }}</span>
                  </span>
                </td>
              </tr>
              <tr v-if="!rank.length">
                <td colspan="6" style="text-align: center; color: var(--text-3); padding: 24px 0">暂无费用数据，请先执行一次同步</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 口径脚注 -->
      <div class="card" style="padding: 14px 20px">
        <div class="caliper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          <div>
            计费口径：<b>净输入 × 输入价</b> + <b>缓存命中 × 缓存读价</b> + <b>缓存写入 × 缓存写价</b> + <b>(输出 + 推理) × 输出价</b>，均按记录发生时刻生效的价格版本计算。<br>
            Antigravity 系（配额百分比点）不参与计费 · 失败/取消记录按实际消耗 token 照常计费 · 改汇率后全部费用即时重算。
          </div>
        </div>
      </div>
    </template>

    <div v-else class="card">
      <EmptyState :title="app.sourceName(app.activeSource) + ' 未启用'" desc="请先在设置中启用该数据源并完成同步，费用统计将随后可用。" @action="app.setPage('settings')" />
    </div>
  </div>
</template>

<style scoped>
.cost-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--accent-soft-2);
  border-left: 3px solid var(--warn);
  border-radius: 12px;
  padding: 11px 16px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}
.cost-banner .bdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cost-banner .bdot.warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
.cost-banner .btext { font-size: 12.5px; color: var(--text-2); flex: 1; }
.cost-banner .btext b { color: var(--text); }
.cost-kpis { grid-template-columns: repeat(4, 1fr); }
.kpi .k-foot .up.down { color: var(--err); }
.chart-wrap svg { display: block; width: 100%; height: auto; }
.chart-axis { font-size: 10.5px; fill: var(--text-3); font-family: "Cascadia Code", Consolas, monospace; }
.chart-dot { cursor: pointer; }
.chart-dot:hover { stroke-width: 3; }
.rank-cell { color: var(--text-3); font-weight: 600; font-size: 12px; }
.cost-col { font-size: 13.5px; }
.share { display: inline-flex; align-items: center; gap: 8px; min-width: 150px; }
.share .track { display: block; flex: 1; height: 5px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.share .fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-2), var(--accent-strong)); }
.share .pct { font-size: 11px; color: var(--text-3); min-width: 44px; text-align: right; }
.caliper { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; color: var(--text-3); line-height: 1.7; }
.caliper svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 2px; color: var(--text-3); }
.caliper b { color: var(--text-2); font-weight: 600; }
</style>
