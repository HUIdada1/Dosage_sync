<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAppStore } from "../stores/app";

const props = defineProps<{ data: { date: string; total: number }[] }>();
const emit = defineEmits<{ (e: "pick", date: string): void }>();

const app = useAppStore();

// 用户指定的 15 级冷色调蓝色 (15 档渐变)
const HEAT_LEVELS = [
  '#CDFDFF', '#B3F8FF', '#9EF1FF', '#8CE7FF', '#7BDCFF',
  '#6CCEFF', '#5EBEFF', '#50ADFF', '#4399FF', '#3784FF',
  '#2B6DFF', '#2054FF', '#153AFF', '#0A1EFF', '#0000FF'
];

// 日期 → 总量
const totalMap = computed(() => {
  const m: Record<string, number> = {};
  props.data.forEach((d) => (m[d.date] = d.total));
  return m;
});

const maxTotal = computed(() => Math.max(0, ...props.data.map((d) => d.total)));

function cellColor(cell: { date: string | null }): string {
  if (!cell.date) return 'transparent';
  const v = totalMap.value[cell.date] || 0;
  if (v <= 0) {
    return app.isDark ? 'rgba(255, 255, 255, 0.06)' : '#ebf3f8';
  }
  const ratio = v / (maxTotal.value || 1);
  const idx = Math.max(0, Math.min(14, Math.floor(ratio * 15)));
  return HEAT_LEVELS[idx];
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 滚动 53 周窗口：包含左侧星期对齐
const grid = computed(() => {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  const first = new Date(start);
  const dow = first.getDay() || 7;
  first.setDate(first.getDate() - (dow - 1));

  const cells: { date: string | null }[] = [];
  const d = new Date(first);
  while (d <= end) {
    const key = fmt(d);
    const inWindow = d >= start;
    cells.push({ date: inWindow ? key : null });
    d.setDate(d.getDate() + 1);
  }
  return cells;
});

const weeks = computed(() => {
  const out: (typeof grid.value)[] = [];
  for (let i = 0; i < grid.value.length; i += 7) out.push(grid.value.slice(i, i + 7));
  return out;
});

// GitHub 格式月份标签（格子 12px + 列距 4px = 每周 16px）
const months = computed(() => {
  const firstWeekOf: Record<string, number> = {};
  weeks.value.forEach((week, wi) => {
    week.forEach((cell) => {
      if (!cell.date) return;
      const key = cell.date.slice(0, 7);
      const day = parseInt(cell.date.slice(8), 10);
      if (day === 1) {
        if (!(key in firstWeekOf)) firstWeekOf[key] = wi;
      } else if (!(key in firstWeekOf)) {
        firstWeekOf[key] = wi;
      }
    });
  });
  return Object.entries(firstWeekOf)
    .sort((a, b) => a[1] - b[1])
    .map(([key, wi]) => ({ offset: wi, label: parseInt(key.slice(5), 10) + "月" }));
});

const activeDays = computed(() => props.data.filter((d) => d.total > 0).length);

// 今日日期，用于标记当前格子光晕脉冲
const todayStr = fmt(new Date());

function cellTitle(cell: { date: string | null }): string {
  if (!cell.date) return "";
  const v = totalMap.value[cell.date] || 0;
  if (v <= 0) return `${cell.date} · 暂无用量记录`;
  return `${cell.date} · ${v.toLocaleString("en-US")} token`;
}

// 悬停提示 Tooltip 智能自适应定位
const tip = ref<{ text: string; x: number; y: number } | null>(null);
const tipEl = ref<HTMLElement | null>(null);

function showTip(cell: { date: string | null }, e: MouseEvent) {
  const text = cellTitle(cell);
  tip.value = text ? { text, x: e.clientX, y: e.clientY } : null;
}

function moveTip(e: MouseEvent) {
  if (tip.value) tip.value = { ...tip.value, x: e.clientX, y: e.clientY };
}

function hideTip() {
  tip.value = null;
}

const tipStyle = computed(() => {
  if (!tip.value) return {};
  const x = tip.value.x;
  const y = tip.value.y;
  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const width = tipEl.value ? tipEl.value.offsetWidth : 180;
  const height = tipEl.value ? tipEl.value.offsetHeight : 34;

  let left = x + offset;
  let top = y + offset;

  if (x + width + offset > vw - 12) {
    left = Math.max(8, x - width - 10);
  }
  if (y + height + offset > vh - 12) {
    top = Math.max(8, y - height - 10);
  }

  return {
    left: `${left}px`,
    top: `${top}px`
  };
});

const scrollEl = ref<HTMLElement | null>(null);

function scrollToEnd() {
  nextTick(() => {
    const el = scrollEl.value;
    if (el) el.scrollLeft = el.scrollWidth;
  });
}

onMounted(scrollToEnd);
watch(() => props.data, scrollToEnd);
</script>

<template>
  <div class="card anim top-heatmap-card">
    <div class="card-head">
      <div class="heat-head-title">
        <h2>全年用量热力图</h2>
      </div>
      <div class="right">
        <span class="heat-badge mono">近一年 · 活跃 {{ activeDays }} 天</span>
      </div>
    </div>
    <div ref="scrollEl" class="heat-scroll" @scroll="hideTip">
      <div class="heat-main">
        <div class="heat-months">
          <span v-for="(m, i) in months" :key="i" :style="{ left: m.offset * 16 + 'px' }">{{ m.label }}</span>
        </div>
        <div class="heat-body">
          <div v-for="(week, wi) in weeks" :key="wi" class="heat-col">
            <span
              v-for="(cell, ci) in week"
              :key="ci"
              class="heat-cell"
              :class="{ 'is-empty': !cell.date, 'is-today': cell.date === todayStr }"
              :style="{ background: cellColor(cell), '--d': wi * 7 + ci }"
              @mouseenter="showTip(cell, $event)"
              @mousemove="moveTip"
              @mouseleave="hideTip"
              @click="cell.date && emit('pick', cell.date)"
            ></span>
          </div>
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div v-if="tip" ref="tipEl" class="heat-tip" :style="tipStyle">{{ tip.text }}</div>
    </Teleport>
    <div class="heat-legend">
      <span class="heat-legend-label">无用量</span>
      <span class="cells"><i v-for="(c, i) in HEAT_LEVELS" :key="i" :style="{ background: c }"></i></span>
      <span class="heat-legend-label">高用量</span>
    </div>
  </div>
</template>
