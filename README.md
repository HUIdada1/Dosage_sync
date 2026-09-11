# 用量同步（Dosage Sync）

一个 Windows 托盘常驻工具：自动读取本机 ZCode、Codex、DeepSeek Harness、WorkBuddy、WorkBuddy AI、Reasonix、CodeBuddy、Qoder、Qoder CN 与 Antigravity、Antigravity IDE 的模型用量，按「电脑」为单元同步到自建 WebDAV，并在多台电脑之间汇总展示。

- **多数据源已接入**：支持 ZCode、Codex、DeepSeek Harness（DSH）、WorkBuddy、WorkBuddy AI、Reasonix、CodeBuddy、Qoder、Qoder CN，各源可独立启用、探测、同步和筛选；Antigravity 系两源（Antigravity / Antigravity IDE）的适配器代码保留但暂时隐藏，恢复方法见 `electron/backend/adapter.cjs`。
- **存储后端可扩展**：当前优先支持自建飞牛 fnOS 的 WebDAV，后续可增加 Nextcloud / 坚果云 / 群晖 / 自定义。
- **本机存储（2026-09 新增）**：没有 WebDAV 也有数据安全网——设置页「数据存储」可切换「WebDAV 存储 / 本机存储」；本机存储把整库快照（汇总库 + 设置）打包为标准 zip 备份压缩包（默认存到数据缓存目录，可自定义，固定名覆盖式）。未配置 WebDAV 时顶栏「立即备份」与定时同步都会自动重新生成压缩包；支持「从压缩包恢复」整包还原数据与设置（恢复前自动留安全副本，失败自动回滚），详见 [本机存储备份方案](docs/本机存储备份方案-2026-09-10.md)。
- **聚合灵活**：累计 token 可按软件源、设备、模型和供应商隔离查询，支持多模型多类型。
- **可视化**：曲线趋势图 + GitHub 风格蓝色热力点阵图（15 档）+ 时间/设备/模型多维筛选，深色/浅色主题（默认浅色）。
- **计费（2026-09 新增）**：按「模型单价 × token 分解」动态核算费用——价格带时段版本（改价自动生成新版本，历史费用按记录发生时刻的价格重算），支持手动维护、从用量一键生成草稿、LiteLLM/OpenRouter 价格源导入预览；价格表经 WebDAV 多设备共享（LWW）。内置 20 个常用模型的默认价格，开启计费即见全部历史费用。支持三层价格来源优先级：**手动规则 > 远程自动拉取（默认 Wei-Shaw 价格源，网址可自定义，哈希短路由省流量）> 内置种子**，「计费规则」页可一键拉取/改址/调间隔。侧栏「费用」页展示费用 KPI/趋势/三维度费用榜，「计费规则」页管理价格（默认关闭，在计费规则页开启）。
- **隐私提示**：同步到 WebDAV 的分片为明文 gzip JSONL（含设备名、模型、会话 ID 等用量数据），请确保自建服务器可信；传输建议使用 https。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 35（Node.js 主进程，Win10/11） |
| 前端 | Vue 3 + TypeScript + Vite + Pinia + ECharts |
| 后端 | Node.js（`node:sqlite` / 原生 fetch） |
| 本地库 | SQLite（Node 22 内置 `node:sqlite`，与各源数据库分离） |
| 打包 | electron-builder：NSIS 安装包 + portable 便携版单 exe（便携版不支持开机自启——注册的会是临时解压副本；数据默认统一在用户主目录 `~/.Dosage_sync/`，可在设置页自定义） |
| 更新 | 安装版支持应用内自动更新（设置页 → 软件更新，`electron-updater` + GitHub Releases）；便携版仅检测提示，需到 GitHub Releases 手动下载替换 |

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
│       ├── adapter-workbuddy-common.cjs # WorkBuddy 系公共工厂（projects/**/*.jsonl 会话转录逐次 message.usage）
│       ├── adapter-workbuddy.cjs # WorkBuddy 适配器（读 ~/.workbuddy）
│       ├── adapter-workbuddy-ai.cjs # WorkBuddy AI 适配器（读 ~/.workbuddy-ai，结构与 WorkBuddy 同构，无 device-id）
│       ├── adapter-reasonix.cjs # Reasonix 适配器（读 stats/YYYY-MM-DD.jsonl 每日账本）
│       ├── adapter-codebuddy.cjs # CodeBuddy 适配器（读 CodeBuddyExtension 会话 history JSON）
│       ├── adapter-qoder-common.cjs # Qoder 系公共工厂（projects/**/*.jsonl 会话转录，官方模型 credits 额度点）
│       ├── adapter-qoder.cjs # Qoder 适配器（读 ~/.qoder）
│       ├── adapter-qoder-cn.cjs # Qoder CN 适配器（读 ~/.qoder-cn）
│       ├── adapter-antigravity-common.cjs # Antigravity 系公共工厂（state.vscdb 配额池快照差值）
│       ├── adapter-antigravity.cjs # Antigravity 适配器（读 %APPDATA%/Antigravity）
│       ├── adapter-antigravity-ide.cjs # Antigravity IDE 适配器（读 %APPDATA%/Antigravity IDE）
│       ├── webdav.cjs      # WebDAV 客户端（原生 fetch）
│       ├── zip.cjs         # 轻量 zip 读写（纯 zlib，本机存储备份压缩包用）
│       ├── sync.cjs        # 四阶段同步引擎 + 本机备份打包/整包还原
│       ├── billing.cjs     # 价格源导入（LiteLLM/OpenRouter）+ 价格表 WebDAV 同步
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
| WorkBuddy | `~/.workbuddy` | `projects/**/*.jsonl` 会话转录的逐次 `message.usage` | 启用 |
| WorkBuddy AI | `~/.workbuddy-ai` | 同 WorkBuddy（目录同构；`projects` 下项目目录名带会话时间戳；无 `device-id`，走设备 ID 回退链；`rawUsage.credit` 额度点不入库） | 启用 |
| Reasonix | `%APPDATA%/reasonix`（Windows）／`~/.reasonix` | `stats/YYYY-MM-DD.jsonl` 每日账本的逐次请求聚合 | 启用 |
| CodeBuddy | `%LOCALAPPDATA%/CodeBuddyExtension` | 会话 `history/**/index.json` 的逐请求 `requests[].usage` | 停用 |
| Qoder | `~/.qoder` | `projects/**/*.jsonl` 会话转录的逐请求 `message.usage`（官方模型为 credits 额度点） | 停用 |
| Qoder CN | `~/.qoder-cn` | 同 Qoder（目录同构） | 停用 |
| Antigravity（旧版） | `%APPDATA%/Antigravity` | `User/globalStorage/state.vscdb` 的配额状态缓存 | 停用 |
| Antigravity IDE（新版） | `%APPDATA%/Antigravity IDE` | `User/globalStorage/state.vscdb` 的配额状态缓存 | 停用 |

Codex、DSH、CodeBuddy、Qoder 两源与两个 Antigravity 源需要在设置页手动启用。九种来源共用本机设备 ID，记录依靠 `source` 隔离；切换顶部数据源后，总览、设备、趋势、热力图与明细会同步切换统计范围，各源统计互不影响。WorkBuddy 与 WorkBuddy AI 是同一厂商的两个产品，目录与记录 id 前缀各自独立（`:workbuddy:` / `:workbuddy-ai:`），互不合并。Trae / Trae CN / TRAE SOLO CN 的本地会话库为整库加密（SQLCipher），本期不支持接入，分析结论与二期 API 路线见 [CodeBuddy数据源接入方案](docs/CodeBuddy数据源接入方案-2026-09-10.md)。

> **Token 口径说明（已实测确认）**：各 token 源的「输入」均包含缓存命中——ZCode 为源数据原生口径，DSH 由适配器归一化补入，Codex 已用本机 rollout 原始数据实测确认（OpenAI 语义中 `cached_input_tokens` 是 `input_tokens` 的子集），WorkBuddy 与 WorkBuddy AI 会话转录实测同口径。因此缓存命中率 = 缓存命中 / 输入在跨源对比时口径一致，命中率恒 ≤ 100%。WorkBuddy / WorkBuddy AI 的推理与缓存写入 token 从其原始回包（`providerData.rawUsage`）补入，源数据缺失时记 0；转录中的对话内容不会被读取或上传。WorkBuddy AI 的 `rawUsage.credit` 额度点**不写入 `credits` 列**——该列在汇总 SQL 中被直接计入 token 总量（为 Qoder「仅有 credits、token 全 0」设计），WorkBuddy AI 的 token 与 credit 并存，写入会造成同一笔调用双重计量。

> **Reasonix 口径说明**：Reasonix 的每日账本把输入拆成**互斥**的 `cache_miss` / `cache_hit` 两桶，与上述「输入含缓存」口径不同。适配器做一次无损映射后入库——`inputTokens = cache_miss + cache_hit`（即 `prompt`）、`cacheReadTokens = cache_hit`、`outputTokens = completion − reasoning`、`cacheCreationTokens = 0`（账本不持久化缓存写入）。映射后计费公式的「净输入 = 输入 − 缓存命中」恰等于 `cache_miss`、「输出 + 推理」恰等于 `completion`，**`v_record_cost` 无需任何改动**。账本中 `turn: true` 的轮次行不是真实 provider 调用，已跳过以避免重复计数；缓存写入缺失会让费用轻微低估（写入价通常高于输入价的部分未计）。目录可用 `REASONIX_STATE_HOME` / `REASONIX_HOME` 覆盖。

> **CodeBuddy 口径说明**：读取 `%LOCALAPPDATA%/CodeBuddyExtension/Data/<用户>/CodeBuddyIDE/<安装>/history/<项目>/<会话>/index.json` 中每请求的 `usage`（输入含缓存写入，与其余源同口径；实测 total = 输入 + 输出）。模型名不在 usage 里，由同会话 `messages/*.json` 的 `extra.requestId → extra.modelId` 关联（`extra` 为 JSON 字符串需二次解析），关联不到记 `unknown`。推理 / 缓存命中 / 缓存写入细分仅存在于 IDE 滚动日志（按日期滚动易丢失），本地无持久化明细，三项记 0——该源的缓存命中率无意义；credits 余额本地不存在（配置缓存为 DPAPI 密文），不做余额展示。国内版 CodeBuddy CN 产生数据后按同构目录自动识别。目录可用 `CODEBUDDY_DATA_HOME` 覆盖。

> **Qoder 口径说明**：读取 `~/.qoder{,-cn}/projects/<项目>/<会话>.jsonl` 会话转录中 assistant 消息的 `message.usage`（`input_tokens` 含缓存命中，与其余源同口径）。**官方模型（qmodel 系列）本地不落盘 token 明细（服务端按订阅额度计量），每请求仅有 `credits` 额度点**——该类记录 token 为 0、`credits` 写入 `usage_record.credits` 独立字段（schema v4 新增）并计入总量聚合：总览/热力图/趋势/设备的数值 = token + 额度点，费用恒为 0、缓存命中率不适用；**自定义 BYOK 模型**（`qoder-custom-<uuid>/<真名>`）有完整五桶 token，模型名按 `/` 拆分后走全项目统一规范化（`deepseek-v4-pro-0813` → `deepseek-v4-pro`）并按模型名推断供应商、正常计费。幂等键为转录行 `uuid`，仅最终消息带 usage（thinking 中间消息无 usage），天然去重。两源目录同构，`installation_id` 为设备标识；备用日志 `logs/sessions/**/segments/*.jsonl` 同样带 token 但无 credits，为转录子集，不采集。目录可用 `QODER_DATA_HOME` / `QODERCN_DATA_HOME` 覆盖。

同步采用**分片级增量传输**：每个日分片以内容哈希记账，内容未变化时自动跳过上传/下载，同步耗时不随历史数据量线性增长。退役设备可在侧边栏悬停设备项点「×」删除（同时清理 WebDAV 上的该设备数据与本地记录，本机不可删）。

未配置 WebDAV 时走**本机存储**：顶栏「立即备份」与定时同步自动抽取本机数据并把整库快照（SQLite 汇总库 + 设置）打包为 `dosage-sync-backup.zip`（默认在数据缓存目录，可自定义备份目录，覆盖式只留最新一份）；「从压缩包恢复」整包还原数据与设置，与同步/备份全程互斥（恢复期间同步、切目录、清缓存等操作一律拒绝），详见 [本机存储备份方案](docs/本机存储备份方案-2026-09-10.md)。已配置 WebDAV 时行为不变，设置页「本机存储」面板仍可随时手动强制生成一次本机备份。

> **Antigravity 系统计口径说明**：Antigravity 新旧两代本地都没有 token 用量明细（官方配额按「请求额度」而非 token 计量），本地唯一用量信号是 `%APPDATA%/<应用>/User/globalStorage/state.vscdb` 中缓存的**模型配额剩余比例（0~1）与重置时间**。因此采用「配额池快照差值法」：每次同步只读解析该文件，按剩余比例的下降量入账；配额池（剩余比例与重置时间完全相同的模型组，如 Gemini 全系共享一池）合并为一条记录，池名取模型名公共前缀；池首次出现或周期重置时记当前累计 `(1-剩余)×100`；剩余回升（补额度/换账号）不计。**数值单位是配额百分比点（消耗 3.13% 记 3.13）而非 token**；无需 Antigravity 正在运行，读的是其最近一次联网时缓存的状态；配额比例仅在 Antigravity 联网时刷新，建议用完软件后同步。解析失败（旧版格式变动）时优雅跳过并写日志，不影响其他源。
>
> **当前状态（2026-09-05 起）**：这两个源已暂时从界面与同步流程隐藏（适配器代码与解析方案保留），恢复方法见 `electron/backend/adapter.cjs` 中【暂时隐藏 Antigravity 系】注释。

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

## 发版流程（自动更新）

代码提交后执行 `./scripts/dual-push.sh`（同时推送 Codeup 与 GitHub，脚本不入库），
再到 GitHub 仓库的 **Actions → Release → Run workflow** 手动触发发布流水线：
构建 → 版本校验 → 自动创建 Release（安装包 / 便携版 / latest.yml / blockmap）。
发布后安装版客户端会在启动后及每 6 小时自动检测到新版（可在设置页关闭自动检测），
便携版用户到 [Releases](https://github.com/HUIdada1/Dosage_sync/releases) 手动下载。
发版不可撤回，发布前务必先升级 `package.json` 的版本号并通过本地 `npm run build`。

> 图标已生成在 `build/`（icon.ico / icon.png / tray.png），无需额外步骤。

## 仓库

`https://github.com/HUIdada1/Dosage_sync`
