<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useAppStore } from "../stores/app";
import { useUsageStore } from "../stores/usage";
import * as api from "../api/ipc";
import { TOTAL_MODES } from "../types";
import type { TotalMode, SourceHealth } from "../types";
import type { UpdateStatus } from "../api/ipc";

const app = useAppStore();
const usage = useUsageStore();
const cfg = app.config;
// 与后端 electron/backend/config.cjs 的 PASSWORD_MASK 一致：掩码值视为「未修改密码」
const PASSWORD_MASK = "••••••••";

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

// ===== 软件更新 =====
const update = ref<UpdateStatus | null>(null);
let offUpdateEvent: (() => void) | undefined;

/** 拉取当前更新状态（进入设置页 / 手动操作后刷新） */
async function refreshUpdateStatus() {
  try {
    update.value = await api.getUpdateStatus();
  } catch {
    update.value = null;
  }
}
async function checkUpdate() {
  await api.checkUpdate();
  await refreshUpdateStatus();
}
async function downloadUpdate() {
  await api.downloadUpdate();
  await refreshUpdateStatus();
}
async function installUpdate() {
  await api.installUpdate();
}
function openReleasePage() {
  api.openReleasePage();
}
function openRepoPage() {
  api.openRepoPage();
}
/** 自动检测开关：即时生效并落盘（定时检查每次读盘判定） */
async function toggleAutoCheck() {
  cfg.update.autoCheck = !cfg.update.autoCheck;
  await autoSave();
}

/** 更新状态行文案 */
const updateLine = computed(() => {
  const u = update.value;
  if (!u) return "点击「检查更新」获取最新版本信息";
  switch (u.status) {
    case "idle": return u.message || "点击「检查更新」获取最新版本信息";
    case "checking": return "正在检查更新…";
    case "up-to-date": return u.message || "已是最新版本";
    case "available": return u.isPortable
      ? `检测到新版本 v${u.latestVersion}（便携版请手动更新）`
      : `发现新版本 v${u.latestVersion}`;
    case "downloading": return `正在下载更新 ${u.percent}%`;
    case "downloaded": return "新版本已下载完成，点击「重启安装」立即生效；或退出应用时自动安装";
    case "error": return u.message || "更新失败，请前往 GitHub 手动下载";
    default: return "";
  }
});

const updateLineStyle = computed(() => {
  const s = update.value?.status;
  if (s === "error") return { color: "var(--err)" };
  if (s === "up-to-date") return { color: "var(--ok)" };
  if (s === "available" || s === "downloaded" || s === "downloading") return { color: "var(--accent-strong)" };
  return { color: "var(--text-3)" };
});

/** 主操作按钮（随状态切换）：检查 → 下载 → 重启安装 / 便携版与失败态 → 前往 GitHub */
const mainAction = computed(() => {
  const u = update.value;
  if (!u) return { label: "检查更新", disabled: false };
  switch (u.status) {
    case "checking": return { label: "检查中…", disabled: true };
    case "downloading": return { label: `下载中 ${u.percent}%`, disabled: true };
    case "available": return u.isPortable
      ? { label: "前往 GitHub 下载", disabled: false }
      : { label: "下载更新", disabled: false };
    case "downloaded": return { label: "重启安装", disabled: false };
    // 失败态给应用内重试入口；GitHub 兜底由常驻地址按钮 + 错误文案提供
    case "error": return { label: "重新检查", disabled: false };
    default: return { label: "检查更新", disabled: false };
  }
});

async function onMainAction() {
  const u = update.value;
  if (!u) {
    await checkUpdate();
    return;
  }
  switch (u.status) {
    case "available":
      if (u.isPortable) openReleasePage();
      else await downloadUpdate();
      break;
    case "downloaded":
      await installUpdate();
      break;
    case "error":
      await checkUpdate();
      break;
    default:
      await checkUpdate();
  }
}

// ===== 数据缓存目录 =====
const dataDirInfo = ref<{ dataDir: string; defaultDataDir: string; isCustom: boolean } | null>(null);
const dataDirInput = ref(""); // 手动输入的新路径（仅编辑态使用）
const dataDirResult = ref<{ ok: boolean; message: string } | null>(null);
const editingDataDir = ref(false);
let dataDirResultTimer = 0;

async function loadDataDirInfo() {
  try {
    dataDirInfo.value = await api.getDataDirInfo();
    dataDirInput.value = dataDirInfo.value?.dataDir || "";
  } catch {
    dataDirInfo.value = null;
  }
}
/** 浏览选择目录（系统对话框） */
async function browseDataDir() {
  const r = await api.browseDataDir();
  if (r?.ok && r.path) {
    dataDirInput.value = r.path;
    editingDataDir.value = true;
  }
}
function startEditDataDir() {
  dataDirInput.value = dataDirInfo.value?.dataDir || "";
  editingDataDir.value = true;
}
/** 保存新目录：可选迁移旧缓存数据（默认迁移） */
async function applyDataDir(migrate: boolean) {
  const target = dataDirInput.value.trim();
  const r = await api.setDataDir(target, migrate);
  dataDirResult.value = r;
  window.clearTimeout(dataDirResultTimer);
  dataDirResultTimer = window.setTimeout(() => { dataDirResult.value = null; }, 8000);
  if (r?.ok) {
    editingDataDir.value = false;
    dataDirInfo.value = { dataDir: r.dataDir || target, defaultDataDir: r.defaultDataDir || dataDirInfo.value?.defaultDataDir || "", isCustom: true };
    app.dataDir = r.dataDir || target;
  }
}
/** 恢复默认目录 */
async function resetDataDir() {
  const ok = window.confirm("确定恢复默认数据缓存目录吗？\n\n将回退到用户主目录下的 .Dosage_sync（重启后生效），当前自定义目录下的数据不会被删除。");
  if (!ok) return;
  const r = await api.resetDataDir();
  dataDirResult.value = r;
  window.clearTimeout(dataDirResultTimer);
  dataDirResultTimer = window.setTimeout(() => { dataDirResult.value = null; }, 8000);
  if (r?.ok) {
    editingDataDir.value = false;
    dataDirInfo.value = { dataDir: r.dataDir || "", defaultDataDir: r.defaultDataDir || "", isCustom: false };
    app.dataDir = r.dataDir || "";
  }
}

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
  loadDataDirInfo();
  refreshUpdateStatus();
  // 订阅主进程更新事件（状态变化 + 通知点击跳转信号）；浏览器演示环境无订阅源
  offUpdateEvent = api.onUpdateEvent?.((e) => {
    if (e.event === "focus-update") {
      app.setPage("settings");
      // 等 v-show 切页生效后滚动到更新卡片，让通知点击直达
      window.setTimeout(() => {
        document.getElementById("update-section")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
      return;
    }
    update.value = e;
  });
});

onUnmounted(() => {
  offUpdateEvent?.();
});

// 密码框防误触：显示的是掩码，任何编辑（哪怕只删一个字符）都先清空，避免
// 「残缺掩码」被后端当成新密码落盘（配合后端仅精确掩码才保留原密码的约定）
function onPasswordInput() {
  const v = cfg.webdav.password;
  if (v !== PASSWORD_MASK && v.includes("•")) cfg.webdav.password = "";
}
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

// ===== 工具栏切换项自定义（显隐 + 排序） =====
/** 排序列表：按 order 排序后的全部来源（含隐藏项），供拖拽与箭头使用 */
const orderedSources = computed(() => app.orderedSources);

function isVisible(source: string): boolean {
  return !(app.config.sourceVisibility.hidden || []).includes(source);
}

async function toggleVisible(source: string) {
  await app.setSourceVisible(source, !isVisible(source));
}

async function moveUp(source: string) {
  await app.moveSourceUp(source);
}

async function moveDown(source: string) {
  await app.moveSourceDown(source);
}

// —— 拖拽排序（HTML5 Drag and Drop）——
const dragSource = ref<string | null>(null);
const dragOverSource = ref<string | null>(null);

function onDragStart(source: string, e: DragEvent) {
  dragSource.value = source;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox 需要 setData 才能启动拖拽
    try { e.dataTransfer.setData("text/plain", source); } catch { /* 忽略 */ }
  }
}
function onDragOver(source: string, e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  if (dragOverSource.value !== source) dragOverSource.value = source;
}
function onDrop(source: string) {
  const from = dragSource.value;
  dragSource.value = null;
  dragOverSource.value = null;
  if (!from || from === source) return;
  // 拖到目标项的位置（目标在有序列表中的下标）
  const idx = orderedSources.value.findIndex((s) => s.id === source);
  if (idx < 0) return;
  app.moveSource(from, idx);
}
function onDragEnd() {
  dragSource.value = null;
  dragOverSource.value = null;
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
async function setDailyTime(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (/^\d{2}:\d{2}$/.test(v)) {
    cfg.schedule.dailyTime = v;
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
          <div class="form-field"><label>密码</label><input class="f-input" type="password" v-model="cfg.webdav.password" @input="onPasswordInput" placeholder="已保存密码显示为掩码；输入任意字符即进入修改，请填写完整新密码" /></div>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h8"/></svg>
          工具栏切换项
          <span class="sg-hint">拖拽或点击箭头调整顺序 · 关闭开关可隐藏</span>
        </div>
        <div class="visibility-list">
          <div
            v-for="(s, i) in orderedSources"
            :key="s.id"
            class="visibility-item"
            :class="{ dragging: dragSource === s.id, 'drag-over': dragOverSource === s.id && dragSource !== s.id, hidden: !isVisible(s.id) }"
            :draggable="true"
            @dragstart="onDragStart(s.id, $event)"
            @dragover="onDragOver(s.id, $event)"
            @drop="onDrop(s.id)"
            @dragend="onDragEnd"
          >
            <span class="drag-handle" title="拖拽排序">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
            </span>
            <div class="v-title">
              <span class="v-name">{{ s.name }}</span>
              <span class="v-sub">#{{ i + 1 }}</span>
            </div>
            <div class="v-actions">
              <button class="icon-btn-sm" :disabled="i === 0" title="上移" @click="moveUp(s.id)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
              </button>
              <button class="icon-btn-sm" :disabled="i === orderedSources.length - 1" title="下移" @click="moveDown(s.id)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
              </button>
              <div
                class="switch"
                :class="{ on: isVisible(s.id) }"
                role="switch"
                :aria-checked="isVisible(s.id)"
                :title="isVisible(s.id) ? '隐藏该项' : '显示该项'"
                @click="toggleVisible(s.id)"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div class="setting-group">
        <div class="sg-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
          调度
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每小时同步</div><div class="s-desc">{{ cfg.schedule.hourly ? `每 ${cfg.schedule.hourlyInterval} 小时自动上传本机并拉取他机` : "关闭中，开启后自动上传本机并拉取他机" }}</div></div><div style="display:flex;align-items:center;gap:10px"><select v-if="cfg.schedule.hourly" class="f-select" style="width:110px" :value="String(cfg.schedule.hourlyInterval || 1)" @change="setHourlyInterval"><option v-for="n in hourlyIntervals" :key="n" :value="String(n)">{{ n }} 小时</option></select><div class="switch" :class="{ on: cfg.schedule.hourly }" @click="toggleSchedule('hourly')"></div></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">每天固定时间</div><div class="s-desc">每天 {{ cfg.schedule.dailyTime }} 同步一次（错过自动补跑）</div></div><div style="display:flex;align-items:center;gap:10px"><input v-if="cfg.schedule.daily" type="time" class="f-input" style="width:110px" :value="cfg.schedule.dailyTime" @change="setDailyTime" /><div class="switch" :class="{ on: cfg.schedule.daily }" @click="toggleSchedule('daily')"></div></div></div>
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
        <div class="switch-row" style="align-items: flex-start">
          <div class="s-left">
            <div class="s-title">数据缓存目录</div>
            <div class="s-desc">本地汇总库（SQLite 缓存）与配置文件的存放位置</div>
            <div class="s-desc" style="color: var(--text-3); margin-top: 2px">默认：{{ dataDirInfo?.defaultDataDir || '用户主目录/.Dosage_sync' }}<span v-if="dataDirInfo?.isCustom" style="color: var(--accent-strong)"> · 已自定义</span></div>
            <div v-if="!editingDataDir" class="s-desc mono" style="word-break: break-all; margin-top: 4px">{{ dataDirInfo?.dataDir || '—' }}</div>
            <div v-else class="data-dir-edit">
              <input class="f-input mono" v-model="dataDirInput" placeholder="请输入目录绝对路径" style="width: 100%" />
              <div class="data-dir-actions">
                <button class="btn-outline" @click="browseDataDir">浏览…</button>
                <button class="btn-outline" @click="applyDataDir(true)" title="把原目录的汇总库与配置复制到新目录">迁移并保存</button>
                <button class="btn-outline" @click="applyDataDir(false)" title="保留原目录数据，在新目录新建缓存">仅新建保存</button>
                <button class="btn-outline" @click="editingDataDir = false">取消</button>
              </div>
              <div class="s-desc" style="color: var(--text-3)">修改后需重启应用生效；迁移会复制原目录数据，新建则保留原目录并在新目录重建缓存。</div>
            </div>
            <div v-if="dataDirResult" class="s-desc" :style="{ color: dataDirResult.ok ? 'var(--ok)' : 'var(--err)', marginTop: 4 }">{{ dataDirResult.message }}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px; flex-shrink: 0">
            <button v-if="!editingDataDir" class="btn-outline" @click="startEditDataDir">修改</button>
            <button v-if="dataDirInfo?.isCustom && !editingDataDir" class="btn-outline" @click="resetDataDir" title="恢复默认目录（当前自定义目录数据保留）">恢复默认</button>
          </div>
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">打开数据目录</div><div class="s-desc">在资源管理器中打开缓存目录</div></div><button class="btn-outline" @click="openDataDir">打开</button></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">版本</div><div class="s-desc">Dosage Sync{{ isPortable ? '（便携版）' : '' }}</div></div><span class="hint mono">{{ version }}</span></div>
        <div class="switch-row" id="update-section" style="align-items: flex-start">
          <div class="s-left">
            <div class="s-title">软件更新</div>
            <div class="s-desc" :style="updateLineStyle">{{ updateLine }}</div>
            <div v-if="update && update.status === 'available' && !update.isPortable && update.notes" class="s-desc" style="white-space: pre-wrap; color: var(--text-2); margin-top: 6px">{{ update.notes }}</div>
            <div v-if="update && update.status === 'downloading'" class="update-progress"><div class="update-progress-fill" :style="{ width: (update.percent || 0) + '%' }"></div></div>
          </div>
          <div class="update-actions">
            <button class="btn-outline" :disabled="mainAction.disabled" @click="onMainAction">{{ mainAction.label }}</button>
            <button class="btn-outline" title="https://github.com/HUIdada1/Dosage_sync" @click="openRepoPage">GitHub 地址 ↗</button>
          </div>
        </div>
        <div class="switch-row"><div class="s-left"><div class="s-title">自动检测新版本</div><div class="s-desc">启动后及每 6 小时自动检查一次，发现新版本时通知（便携版仅提示手动更新）</div></div><div class="switch" :class="{ on: cfg.update.autoCheck }" @click="toggleAutoCheck"></div></div>
        <div class="switch-row"><div class="s-left"><div class="s-title">作者</div><div class="s-desc">用量同步工具</div></div><span class="hint">沐辉玄制作</span></div>
      </div>

      <div style="margin-top: 20px; display: flex; justify-content: flex-end">
        <span v-if="saveResult" class="save-feedback" :class="{ ok: saveResult.ok }">{{ saveResult.message }}</span>
        <button class="btn-sync" :disabled="saving" @click="save">{{ saving ? "保存中" : "保存设置" }}</button>
      </div>
    </div>
  </div>
</template>
