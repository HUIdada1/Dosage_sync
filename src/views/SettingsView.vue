<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAppStore } from "../stores/app";
import { useUsageStore } from "../stores/usage";
import * as api from "../api/ipc";
import { TOTAL_MODES } from "../types";
import type { TotalMode, SourceHealth } from "../types";

const app = useAppStore();
const usage = useUsageStore();
const cfg = app.config;

const testResult = ref<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
const saveResult = ref<{ ok: boolean; message: string } | null>(null);
const saving = ref(false);
const health = ref<SourceHealth[]>([]);
const version = ref("");
const isPortable = ref(false);
const exportResult = ref<{ ok: boolean; message: string } | null>(null);
const resetResult = ref<{ ok: boolean; message: string } | null>(null);
let exportResultTimer = 0;
let resetResultTimer = 0;

const presets = [
  { key: "feiniu", label: "飞牛 fnOS" },
  { key: "nextcloud", label: "Nextcloud" },
  { key: "nutstore", label: "坚果云" },
  { key: "synology", label: "群晖" },
  { key: "custom", label: "自定义" },
];

const hourlyIntervals = [1, 2, 3, 6, 12];

onMounted(async () => {
  health.value = await api.healthSource();
  version.value = await api.getAppVersion();
  isPortable.value = await api.getIsPortable();
});

async function save() {
  saving.value = true;
  try {
    saveResult.value = await app.save();
    window.setTimeout(() => { saveResult.value = null; }, 3200);
  } catch (e) {
    saveResult.value = { ok: false, message: `设置保存失败：${e instanceof Error ? e.message : "未知错误"}` };
  } finally {
    saving.value = false;
  }
}
/** 开关/主题类改动即时生效并自动落盘（凭据等文本输入仍走「保存设置」） */
async function autoSave() {
  const r = await app.save();
  if (!r.ok) {
    saveResult.value = r;
    window.setTimeout(() => { saveResult.value = null; }, 3200);
  }
}
async function testConn() {
  testResult.value = await api.testWebdav(cfg.webdav);
}
async function detect(source: string) {
  const r = await api.detectSource(source);
  // 探测永远指向该源的默认目录，因此不写入 dataDir 钉死路径；
  // 并清掉旧版本可能留下的固定值，恢复「自动探测」语义（有变化才落盘）
  const s = cfg.sources.find((x) => x.source === source);
  if (s && s.dataDir) {
    s.dataDir = null;
    await autoSave();
  }
  const current = health.value.find((item) => item.source === source);
  if (current) {
    current.detected = !!r.path;
    current.dataDir = r.path;
    current.readable = r.ok;
  }
}
async function toggleSource(source: string) {
  const item = cfg.sources.find((entry) => entry.source === source);
  if (item) {
    item.enabled = !item.enabled;
    await autoSave();
  }
}
async function toggleSchedule(key: "hourly" | "daily" | "minimizeToTray" | "notifyOnSuccess") {
  cfg.schedule[key] = !cfg.schedule[key];
  await autoSave();
}
async function setTheme(theme: "light" | "dark") {
  app.applyTheme(theme);
  await autoSave();
}
function openDataDir() {
  api.openDataDir();
}
async function toggleAutoStart() {
  // 便携版的登录自启会注册临时解压副本路径（退出即失效），直接不响应
  if (isPortable.value) return;
  cfg.schedule.autoStart = !cfg.schedule.autoStart;
  await api.setAutostart(cfg.schedule.autoStart);
  await save();
}
async function setHourlyInterval(e: Event) {
  const v = parseInt((e.target as HTMLSelectElement).value, 10);
  if (Number.isFinite(v) && v > 0) {
    cfg.schedule.hourlyInterval = v;
    await autoSave();
  }
}
async function exportData(fmt: "csv" | "json") {
  // 设置页无筛选上下文，导出全部明细；按筛选导出请到「用量明细」页
  const r = await api.exportData(fmt);
  exportResult.value = r?.ok
    ? { ok: true, message: `导出成功：${r.path}` }
    : { ok: false, message: r?.message || "导出失败" };
  window.clearTimeout(exportResultTimer);
  exportResultTimer = window.setTimeout(() => { exportResult.value = null; }, 6000);
}
async function resetCache() {
  const ok = window.confirm(
    "确定清空本地缓存吗？\n\n将删除本地全部明细记录与增量同步记账，WebDAV 上的数据不受影响，下次同步会自动重新拉取合并。"
  );
  if (!ok) return;
  const r = await api.resetLocalCache();
  resetResult.value = r;
  window.clearTimeout(resetResultTimer);
  resetResultTimer = window.setTimeout(() => { resetResult.value = null; }, 6000);
  if (r?.ok) {
    usage.resetOverview();
    await usage.loadOverview();
  }
}
</script>

<template>
  <div>
    <div class="page-title">设置</div>
    <div class="page-sub">WebDAV · 数据源 · 调度 · 外观</div>

    <div class="card">
      <div class="setting-group">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          WebDAV 存储
        </div>
        <div class="form-grid">
          <div class="form-field"><label>存储预设</label>
            <select class="f-select" v-model="cfg.webdav.preset"><option v-for="p in presets" :key="p.key" :value="p.key">{{ p.label }}</option></select>
          </div>
          <div class="form-field"><label>地址</label><input class="f-input" v-model="cfg.webdav.endpoint" placeholder="https://dav.example.com/dav" /></div>
          <div class="form-field"><label>账号</label><input class="f-input" v-model="cfg.webdav.username" /></div>
          <div class="form-field"><label>密码</label><input class="f-input" type="password" v-model="cfg.webdav.password" /></div>
          <div class="form-field"><label>根目录</label><input class="f-input" v-model="cfg.webdav.root" placeholder="/dosage-sync" /></div>
          <div class="form-field"><label>电脑名</label><input class="f-input" v-model="cfg.deviceName" placeholder="如：公司笔记本" /></div>
          <div class="form-field full">
            <button class="btn-outline" @click="testConn">测试连接</button>
            <span v-if="testResult" class="hint" :style="{ marginLeft: '10px', color: testResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ testResult.message }}</span>
          </div>
        </div>
      </div>

      <div class="setting-group">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>
          数据源
        </div>
        <div v-for="h in health" :key="h.source" class="switch-row">
          <div class="s-left">
            <div class="s-title">{{ h.name }}</div>
            <div class="s-desc">
              <template v-if="h.readable">{{ h.dataDir }} · <span style="color: var(--ok)">可读取</span><span v-if="!app.isSourceEnabled(h.source)" style="color: var(--accent-strong)"> · 检测到可用数据，可一键启用</span></template>
              <template v-else-if="h.detected">{{ h.dataDir }} · <span style="color: var(--err)">数据不可读取</span></template>
              <template v-else>未检测到数据目录</template>
            </div>
          </div>
          <div class="source-actions">
            <button
              v-if="h.readable && !app.isSourceEnabled(h.source)"
              class="btn-outline"
              title="检测到本机有该源的可用数据，点击立即接入"
              @click="toggleSource(h.source)"
            >一键启用</button>
            <button class="btn-outline" @click="detect(h.source)">重新探测</button>
            <div
              class="switch"
              :class="{ on: cfg.sources.find((item) => item.source === h.source)?.enabled }"
              role="switch"
              :aria-checked="!!cfg.sources.find((item) => item.source === h.source)?.enabled"
              :title="app.isSourceEnabled(h.source) ? '停用数据源' : '启用数据源'"
              @click="toggleSource(h.source)"
            ></div>
          </div>
        </div>
      </div>

      <div class="setting-group">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          调度
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每小时同步</div><div class="s-desc">{{ cfg.schedule.hourly ? `每 ${cfg.schedule.hourlyInterval} 小时自动上传本机并拉取他机` : "关闭中，开启后自动上传本机并拉取他机" }}</div></div><div style="display:flex;align-items:center;gap:10px"><select v-if="cfg.schedule.hourly" class="f-select" style="width:110px" :value="String(cfg.schedule.hourlyInterval || 1)" @change="setHourlyInterval"><option v-for="n in hourlyIntervals" :key="n" :value="String(n)">{{ n }} 小时</option></select><div class="switch" :class="{ on: cfg.schedule.hourly }" @click="toggleSchedule('hourly')"></div></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每天固定时间</div><div class="s-desc">每天 {{ cfg.schedule.dailyTime }} 同步一次（错过自动补跑）</div></div><div class="switch" :class="{ on: cfg.schedule.daily }" @click="toggleSchedule('daily')"></div></div>
        <div class="switch-row">
          <div class="s-left"><div class="s-title">开机自启</div><div class="s-desc">{{ isPortable ? "便携版不支持开机自启（注册的会是临时副本）" : "登录 Windows 后自动运行" }}</div></div>
          <div class="switch" :class="{ on: cfg.schedule.autoStart, disabled: isPortable }" :style="isPortable ? 'opacity:.4' : ''" @click="toggleAutoStart"></div>
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">关闭最小化到托盘</div><div class="s-desc">点关闭按钮不退出，仅最小化</div></div><div class="switch" :class="{ on: cfg.schedule.minimizeToTray }" @click="toggleSchedule('minimizeToTray')"></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">同步成功也通知</div><div class="s-desc">默认关闭，仅同步失败时弹系统通知</div></div><div class="switch" :class="{ on: cfg.schedule.notifyOnSuccess }" @click="toggleSchedule('notifyOnSuccess')"></div></div>
      </div>

      <div class="setting-group">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" opacity=".2"/></svg>
          外观与口径
        </div>
        <div class="switch-row">
          <div class="s-left"><div class="s-title">主题</div><div class="s-desc">浅色 / 深色，默认浅色</div></div>
          <div class="tabs">
            <button class="tab" :class="{ active: cfg.theme === 'light' }" @click="setTheme('light')">浅色</button>
            <button class="tab" :class="{ active: cfg.theme === 'dark' }" @click="setTheme('dark')">深色</button>
          </div>
        </div>
        <div class="switch-row">
          <div class="s-left"><div class="s-title">总量口径</div><div class="s-desc">{{ TOTAL_MODES[cfg.totalMode].desc }}</div></div>
          <div class="tabs">
            <button v-for="(v, k) in TOTAL_MODES" :key="k" class="tab" :class="{ active: cfg.totalMode === k }" @click="app.setTotalMode(k as TotalMode)">{{ v.label }}</button>
          </div>
        </div>
      </div>

      <div class="setting-group" style="margin-bottom: 0">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          数据与关于
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">导出 CSV</div><div class="s-desc">导出全部明细（按筛选导出请到「用量明细」页）</div></div><button class="btn-outline" @click="exportData('csv')">导出</button></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">导出 JSON</div><div class="s-desc">导出统一用量模型原始数据</div></div><button class="btn-outline" @click="exportData('json')">导出</button></div>
        <div v-if="exportResult" class="switch-row"><div class="s-left"><div class="s-desc" :style="{ color: exportResult.ok ? 'var(--ok)' : 'var(--err)', wordBreak: 'break-all' }">{{ exportResult.message }}</div></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">清空本地缓存</div><div class="s-desc">删除本地明细与同步记账，WebDAV 数据不动，下次同步自动重拉</div></div><div style="display:flex;align-items:center;gap:10px"><span v-if="resetResult" class="hint" :style="{ color: resetResult.ok ? 'var(--ok)' : 'var(--err)' }">{{ resetResult.message }}</span><button class="btn-outline" @click="resetCache">清空</button></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">数据缓存目录</div><div class="s-desc">本地汇总库与配置的存放位置（SQLite 缓存）</div></div><span class="hint mono" style="max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ app.dataDir || "—" }}</span></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">打开数据目录</div><div class="s-desc">在资源管理器中打开缓存目录</div></div><button class="btn-outline" @click="openDataDir">打开</button></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">版本</div><div class="s-desc">Dosage Sync</div></div><span class="hint mono">{{ version }}</span></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">作者</div><div class="s-desc">用量同步工具</div></div><span class="hint">沐辉玄制作</span></div>
      </div>

      <div style="margin-top: 20px; display: flex; justify-content: flex-end">
        <span v-if="saveResult" class="save-feedback" :class="{ ok: saveResult.ok }">{{ saveResult.message }}</span>
        <button class="btn-sync" :disabled="saving" @click="save">{{ saving ? "保存中" : "保存设置" }}</button>
      </div>
    </div>
  </div>
</template>
