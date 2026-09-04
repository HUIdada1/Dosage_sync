<!-- 沐辉玄制作：用量同步桌面应用入口 -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import AppBar from "./components/AppBar.vue";
import OverviewView from "./views/OverviewView.vue";
import DetailView from "./views/DetailView.vue";
import LogView from "./views/LogView.vue";
import SettingsView from "./views/SettingsView.vue";
import SyncDialog from "./components/SyncDialog.vue";

const app = useAppStore();
onMounted(() => {
  app.load();
  // 卡片聚光：单事件委托，把鼠标相对坐标写入 --mx/--my 供 .card::after 使用
  const content = document.querySelector(".content");
  content?.addEventListener("mousemove", ((e: MouseEvent) => {
    const card = (e.target as HTMLElement).closest?.(".card") as HTMLElement | null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${e.clientX - r.left}px`);
    card.style.setProperty("--my", `${e.clientY - r.top}px`);
  }) as EventListener);
});
</script>

<template>
  <div class="app-shell">
    <Sidebar />
    <div class="main-col">
      <AppBar />
      <main class="content">
        <OverviewView v-show="app.activePage === 'overview'" :class="{ 'page-anim': app.activePage === 'overview' }" />
        <DetailView v-show="app.activePage === 'detail'" :class="{ 'page-anim': app.activePage === 'detail' }" />
        <LogView v-show="app.activePage === 'log'" :class="{ 'page-anim': app.activePage === 'log' }" />
        <SettingsView v-show="app.activePage === 'settings'" :class="{ 'page-anim': app.activePage === 'settings' }" />
      </main>
    </div>
    <SyncDialog />
  </div>
</template>
