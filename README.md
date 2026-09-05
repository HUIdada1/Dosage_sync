# 用量同步（Dosage Sync）

一个 Windows 托盘常驻工具：自动读取本机 ZCode、Codex、DeepSeek Harness、Antigravity 与 Antigravity IDE 的模型用量，按「电脑」为单元同步到自建 WebDAV，并在多台电脑之间汇总展示。

- **五数据源已接入**：支持 ZCode、Codex、DeepSeek Harness（DSH）、Antigravity、Antigravity IDE，各源可独立启用、探测、同步和筛选。
- **存储后端可扩展**：当前优先支持自建飞牛 fnOS 的 WebDAV，后续可增加 Nextcloud / 坚果云 / 群晖 / 自定义。
- **聚合灵活**：累计 token 可按软件源、设备、模型和供应商隔离查询，支持多模型多类型。
- **可视化**：曲线趋势图 + GitHub 风格蓝色热力点阵图（15 档）+ 时间/设备/模型多维筛选，深色/浅色主题（默认浅色）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 35（Node.js 主进程，Win10/11） |
| 前端 | Vue 3 + TypeScript + Vite + Pinia + ECharts |
| 后端 | Node.js（`node:sqlite` / 原生 fetch） |
| 本地库 | SQLite（Node 22 内置 `node:sqlite`，与各源数据库分离） |
| 打包 | electron-builder：NSIS 安装包 + portable 便携版单 exe |

## 目录结构

```
.
├── logo.png                # 图标源文件（窗口/托盘/exe 图标）
├── preview.html            # UI 设计原型（浏览器直接打开预览，零依赖）
├── index.html              # 前端入口
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/                    # Vue3 前端
│   ├── main.ts / App.vue
│   ├── styles/             # 设计系统（主题变量）
│   ├── types/              # 统一类型（与 Node 后端模型对齐）
│   ├── api/                # IPC 封装 + 浏览器 mock（可脱离后端预览）
│   ├── stores/             # Pinia 状态
│   ├── composables/        # 格式化工具
│   ├── components/         # 侧栏/顶栏/进度/图表/热力图/抽屉等
│   └── views/              # 总览/明细/日志/设置 四页
├── electron/               # Electron 主进程（Node.js 后端）
│   ├── main.cjs            # 窗口/托盘/单实例/调度入口
│   ├── preload.cjs         # contextBridge 安全桥接
│   └── backend/
│       ├── config.cjs      # 配置与数据目录
│       ├── db.cjs          # 本地汇总库（node:sqlite）
│       ├── adapter.cjs     # 数据源适配器注册表
│       ├── adapter-zcode.cjs # ZCode 适配器（读 ~/.zcode）
│       ├── adapter-codex.cjs # Codex 适配器（读 ~/.codex）
│       ├── adapter-dsh.cjs # DeepSeek Harness 适配器（读 ~/.dsh）
│       ├── adapter-antigravity-common.cjs # Antigravity 系公共工厂（state.vscdb 配额池快照差值）
│       ├── adapter-antigravity.cjs # Antigravity 适配器（读 %APPDATA%/Antigravity）
│       ├── adapter-antigravity-ide.cjs # Antigravity IDE 适配器（读 %APPDATA%/Antigravity IDE）
│       ├── webdav.cjs      # WebDAV 客户端（原生 fetch）
│       ├── sync.cjs        # 四阶段同步引擎
│       ├── scheduler.cjs   # 定时调度
│       └── ipc.cjs         # ipcMain handler 注册
├── build/                  # electron-builder 资源（icon.ico / icon.png / tray.png）
└── docs/
    ├── 方案.md             # 设计方案
    └── 操作.md             # 操作手册（构建 / 使用 / 飞牛配置）
```

## 数据源

| 数据源 | 默认目录 | 用量来源 | 默认状态 |
|---|---|---|---|
| ZCode | `~/.zcode` | `cli/db/db.sqlite` 的 `model_usage` | 启用 |
| Codex | `~/.codex` | `sessions/**/rollout-*.jsonl` 的单次 `last_token_usage` | 停用 |
| DeepSeek Harness | `~/.dsh` | `tokenledger.sqlite` 的 `session_rollups` | 停用 |
| Antigravity（旧版） | `%APPDATA%/Antigravity` | `User/globalStorage/state.vscdb` 的配额状态缓存 | 停用 |
| Antigravity IDE（新版） | `%APPDATA%/Antigravity IDE` | `User/globalStorage/state.vscdb` 的配额状态缓存 | 停用 |

Codex、DSH 与两个 Antigravity 源需要在设置页手动启用。五种来源共用本机设备 ID，记录依靠 `source` 隔离；切换顶部数据源后，总览、设备、趋势、热力图与明细会同步切换统计范围，各源统计互不影响。

> **Antigravity 系统计口径说明**：Antigravity 新旧两代本地都没有 token 用量明细（官方配额按「请求额度」而非 token 计量），本地唯一用量信号是 `%APPDATA%/<应用>/User/globalStorage/state.vscdb` 中缓存的**模型配额剩余比例（0~1）与重置时间**。因此采用「配额池快照差值法」：每次同步只读解析该文件，按剩余比例的下降量入账；配额池（剩余比例与重置时间完全相同的模型组，如 Gemini 全系共享一池）合并为一条记录，池名取模型名公共前缀；池首次出现或周期重置时记当前累计 `(1-剩余)×100`；剩余回升（补额度/换账号）不计。**数值单位是配额百分比点（消耗 3.13% 记 3.13）而非 token**；无需 Antigravity 正在运行，读的是其最近一次联网时缓存的状态；配额比例仅在 Antigravity 联网时刷新，建议用完软件后同步。解析失败（旧版格式变动）时优雅跳过并写日志，不影响其他源。

## 快速开始

```bash
npm install

# 仅预览前端 UI（脱离 Node 后端，浏览器打开 http://localhost:1420）
npm run dev:web

# 开发调试（Vite + Electron 热更新窗口）
npm run dev

# 打包（NSIS 安装包 + portable 便携版 exe，产物在 release/）
npm run electron:build
```

> 图标已生成在 `build/`（icon.ico / icon.png / tray.png），无需额外步骤。

## 仓库

`https://github.com/HUIdada1/Dosage_sync`
