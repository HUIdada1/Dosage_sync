<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../stores/app";

const app = useAppStore();

const stages = ["抽取", "上传", "拉取", "合并"];

const stageIndex = computed(() => {
  const map: Record<string, number> = { idle: -1, extract: 0, upload: 1, download: 2, merge: 3, done: 4, cancelled: 0 };
  return map[app.sync.stage] ?? -1;
});

const done = computed(() => app.sync.stage === "done");
</script>

<template>
  <div class="syncbar anim">
    <div class="head">
      <span class="stitle">
        <svg :class="{ done }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>
        <span>{{ app.sync.stageLabel || "待同步" }}</span>
      </span>
      <span class="pct"><b>{{ Math.round(app.sync.percent) }}</b>%</span>
      <button v-if="app.sync.running" class="cancel" @click="app.cancelSync()">取消</button>
    </div>
    <div class="track"><div class="fill" :style="{ width: app.sync.percent + '%' }"></div></div>
    <div class="stages">
      <div v-for="(s, i) in stages" :key="s" class="stage" :class="{ done: i < stageIndex, active: i === stageIndex }">
        <span class="sdot"></span>{{ s }}
      </div>
    </div>
  </div>
</template>
