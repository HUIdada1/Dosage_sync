# WorkBuddy 数据源接入方案（token 消耗统计 + 计费统计）

> 日期：2026-09-07 ｜ 状态：方案（未实施）
> 结论先行：**可行**，以「文件扫描型适配器」接入（与 Codex 同模式），对现有统计/计费链路**零结构性改动**。

---

## 一、现有 ZCode 统计逻辑分析

### 1.1 代码位置

| 职责 | 文件 | 说明 |
|---|---|---|
| 适配器 | `electron/backend/adapter-zcode.cjs` | 读 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（只读）；设备标识取 `~/.zcode/v2/telemetry-state.json` 的 `deviceMid` |
| 适配器注册表 | `electron/backend/adapter.cjs` | `sources = [zcode, codex, dsh]`，新增源在此注册 |
| 同步引擎 | `electron/backend/sync.cjs` | 四阶段：抽取 → 上传 → 拉取 → 合并；按源维护增量锚点 `checkpoint`（`db.getAnchor/setAnchor`），非首次同步回扫最近 24h；单源抽取失败仅跳过该源 |
| 本地汇总库 | `electron/backend/db.cjs` | `usage_record` 明细表（幂等 `INSERT OR REPLACE`）、聚合查询、计费 |
| 计费价格源 | `electron/backend/billing.cjs` | LiteLLM/OpenRouter 导入 + 远程价格源拉取 + 价格表 WebDAV LWW 同步 |
| 类型定义 | `src/types/index.ts` | `UsageRecord` / `SourceConfig` / `SourceInfo`，前端与后端口径对齐 |
| 配置默认值 | `electron/backend/config.cjs` | `sources: [{ source: "zcode", enabled: true, ... }]` |

### 1.2 统计维度

一条 `UsageRecord` 的维度字段（ZCode `model_usage` 行 → 归一化）：

- **软件源** `source`（记录按源完全隔离，顶部切换后总览/设备/趋势/热力图/明细联动）
- **设备** `deviceId/deviceName`
- **供应商** `providerId`：ZCode 的 provider_id 多为裸 UUID → `providerName()` 先查 `PROVIDER_MAP`，再按模型名前缀推断（`providerByModel`），兜底 `未知供应商:前8位`
- **模型** `modelId`：`normalizeModel()` 归并别名（去路径/冒号/下划线、去日期快照后缀）
- **会话** `sessionId`、**智能体** `agent`、**模式** `mode`、**任务类型** `taskType`、**状态** `status`、**时长** `durationMs`
- **时间** `startedAt`（一切聚合与计费的时间锚点）、`completedAt`

### 1.3 计算方式

- **增量抽取**：`SELECT ... WHERE started_at > since`，锚点单调不回退；回扫窗口 24h 覆盖源端回填。
- **总量口径**：`input_tokens + output_tokens`（"完整"口径额外 `+ reasoning_tokens`，`db.cjs extraExpr()`）。
- **缓存命中率**：`cache_read / input`——**input 含缓存命中**（源数据原生口径，README 已实测三源一致），故恒 ≤ 100%。
- **幂等写入**：记录 id = `${deviceId}:zcode:${源id}`，`INSERT OR REPLACE` 天然去重。
- **聚合**：`getSummary`（KPI）/ `getTrend`（按日+按模型）/ `getHeatmap`（15 档热力）/ `getAggregate`（模型/设备/供应商/源 四维榜）/ `getRecords`（明细分页）。
- **计费**：`model_price` 时段版本化价格表（来源优先级 manual > remote > builtin）；视图 `v_record_cost` 按「记录发生时刻生效的最优价」动态计费：
  `费用 = 净输入×输入价 + 缓存命中×读价 + 缓存写入×写价 + (输出+推理)×输出价`，其中 **净输入 = input − cache_read**（适配 input 含缓存的口径）；币种换算在 JS 层（`toDisplay`，CNY/USD 汇率可改即时生效）。
- **多机同步**：日分片 `usage-tracker/data/<deviceId>/<YYYY-MM-DD>.jsonl.gz`，内容 hash 记账增量传输；`source` 字段随记录同步上云，跨设备合并后仍按源隔离。

### 1.4 接入新源所需的最小改动面（现状推论）

现有架构下所有聚合/计费 SQL 均带 `source` 参数或以 `source` 分组（`QUOTA_SOURCES_SQL` 已演示"某些源排除计费"的做法），因此**新增一个源不需要动任何聚合 SQL**，只需：适配器文件 + 注册表 + 配置默认项 + 前端类型/mock。

---

## 二、WorkBuddy 本地数据勘察（本机 `~/.workbuddy` 实测）

### 2.1 逐次 token 明细（可用 ✅）

权威数据源：**`~/.workbuddy/projects/<编码后cwd>/<sessionId>.jsonl`** 会话转录（JSONL）。

每条 assistant 消息条目携带：

```
type: "message" | "reasoning" | ...
timestamp: 1786958836190            ← epoch ms，可直接做 startedAt
sessionId: "<uuid>"
cwd: "..."\nmessage: { usage: {
    input_tokens: 34077,            ← 含缓存命中（OpenAI 语义，与 ZCode/Codex 口径一致）
    output_tokens: 587,
    total_tokens: 34664,
    cache_read_input_tokens: 12288  ← 可选，存在时才有
}}
providerData: {
    model: "glm-5.2",               ← 真实模型名
    requestModelId: "auto",         ← 用户请求模式（Auto 路由）
    messageId: "6a884f1f...",       ← 去重主键
    traceId / conversationRequestId, rawUsage: {prompt_tokens, completion_tokens, ...}
}
```

实测本机 14 个转录文件、38 条 usage 记录，模型覆盖 glm-5.2 / glm-5.3 / glm-5.3-flash / deepseek-v4-pro / deepseek-v4-flash / hy3。

### 2.2 其他数据点

| 位置 | 内容 | 结论 |
|---|---|---|
| `~/.workbuddy/workbuddy.db` → `sessions` 表 | session id / title / model / created_at / cwd | 辅助元数据，可丰富记录（非必需） |
| 同库 `session_usage` 表 | `used/size`（上下文窗口快照）+ `credit_json`（订阅点数消耗，如 `{"hashid":1.45}`） | **不是**逐次累计 token，不能做明细；`credit_json` 可作二期"点数计费"参考 |
| `~/.workbuddy/device-id` | UUID（实测 `67ba6df5-...`） | **设备标识**，直接用 |
| `~/.workbuddy/traces/` | 单次请求 trace 文件 | 与转录重复，不采用（转录更稳定、按会话聚合） |

### 2.3 口径与风险点

1. **input 含 cache_read**：与现有 `v_record_cost` 的「净输入 = input − cache_read」假设完全一致，**无需改计费公式**。
2. **缺独立 `cache_creation` / `reasoning` 字段**：记 0，费用轻微低估（推理 token 若实际单独计价）。缓解：探测 `rawUsage` 内是否有 reasoning 字段，有则补入。
3. **去重键**：同一请求可能同时产生 `message` 与 `reasoning` 两条带 usage 的条目 → 用 `providerData.messageId`（缺省时 `sessionId + 行内消息 id`）作为源记录 id 去重，实施时需实测确认二者是否共享同一 usage（避免重复计费）。
4. **Auto 路由**：`requestModelId=auto` 时以 `providerData.model`（真实路由结果）为准，这正是计费所需。
5. **隐私**：转录含完整对话内容，适配器**只读 usage/model/messageId 字段**，不落盘、不上传任何内容文本。
6. **无时间索引**：文件型源（同 Codex），增量策略 = 扫描 + mtime 粗筛 + `timestamp > since` 精筛。

---

## 三、可行性结论与影响评估

| 影响面 | 评估 |
|---|---|
| 聚合查询（db.cjs） | **零改动**。所有查询按 `source` 参数过滤，新源自动纳入总览/趋势/热力/四维榜/明细 |
| 计费（v_record_cost / model_price） | **零改动**。workbuddy 模型名经 `normalizeModel` 后与现有价格表直接命中（glm/deepseek 系已有内置价）；未命中的模型（如 hy3）自动进入 `listUnpricedModels` 提醒与「从用量生成草稿」流程 |
| 同步引擎（sync.cjs） | **零改动**。抽取循环按注册表驱动；日分片上传/合并按 `source` 字段自然隔离 |
| 设备标识（ensureLocalDeviceId） | 无需改：本机 device_id 已存在；WorkBuddy 的 `device-id` 仅用于校验一致性 |
| 前端 | 仅扩展类型/mock 与设置页文案；数据源清单由 `list_sources` 下发，UI 自动出现新源 |
| 风险 | 低。单源失败自动跳过（sync.cjs 已有 try/catch）；记录量级为每会话数十~数千条，首扫开销可接受 |

---

## 四、统计指标定义（WorkBuddy → UsageRecord 映射）

| UsageRecord 字段 | 取值 | 说明 |
|---|---|---|
| `id` | `${deviceId}:workbuddy:${messageId}` | 幂等去重键；messageId 缺失时用 `sha1(sessionId+行号)` |
| `source` | `"workbuddy"` | |
| `deviceId` / `deviceName` | 工具本机 device_id / 用户设备名 | 与其他源共用同一设备单元 |
| `providerId` | 复用 `providerByModel(providerData.model)` | glm→智谱 GLM、deepseek→DeepSeek…，兜底 `"WorkBuddy"` |
| `modelId` | `normalizeModel(providerData.model)` | 与价格表口径一致 |
| `sessionId` | 条目 `sessionId` | |
| `mode` | 会话性质：`interactive` / `automation`（可由 workbuddy.db sessions.source_mode 或 cwd 推断，一期可留空） | |
| `inputTokens` | `usage.input_tokens` | 含缓存命中 |
| `outputTokens` | `usage.output_tokens` | |
| `reasoningTokens` | `rawUsage.reasoning_tokens ?? 0` | 有则取 |
| `cacheReadTokens` | `usage.cache_read_input_tokens ?? 0` | |
| `cacheCreationTokens` | `0` | 源无此字段 |
| `startedAt` | 条目 `timestamp`（epoch ms） | |
| `status` | 条目 `status ?? "success"` | |
| `durationMs` / `completedAt` | 不设 | 源无 |

**计费指标**：完全复用现有体系——`总费用/今日/本月/较上月同期`、四维费用榜、每日费用趋势、未配置价格模型提醒；币种 CNY（USD 价目走汇率换算）。
**二期可选**：订阅点数消耗（`session_usage.credit_json`）作为 WorkBuddy 专属"订阅视角"指标，与 token 计费并存展示。

---

## 五、数据流转

```
~/.workbuddy/projects/**/*.jsonl（只读 usage/model/messageId 字段）
   │  adapter-workbuddy.extract：mtime 粗筛 → timestamp > since 精筛 → messageId 去重
   ▼
UsageRecord[]（id = deviceId:workbuddy:messageId）
   │  sync.cjs 抽取阶段（checkpoint 锚点 + 24h 回扫，单源失败跳过）
   ▼
本地 SQLite usage_record（幂等 INSERT OR REPLACE）
   ├─► v_record_cost 计费视图 ─► KPI/趋势/四维费用榜/明细费用列
   ├─► 聚合查询 ─► 总览/设备/趋势/热力图（source=workbuddy 自动隔离）
   └─► WebDAV 日分片上传/拉取/合并（无需改动，多机自动汇总）
```

---

## 六、实施步骤

### Step 1：适配器 `electron/backend/adapter-workbuddy.cjs`（核心，约 150 行）
- `detect()`：`~/.workbuddy` 存在且含 `projects/` 或 `workbuddy.db`
- `validate(dir)`：`projects/` 目录存在
- `getDeviceId(dir)`：读 `device-id` 文件（Trim 后非空）
- `extract(dir, deviceId, deviceName, since)`：
  1. 递归枚举 `projects/**/*.jsonl`，按文件 mtime ≥ since - 24h 粗筛（同 Codex `findRollouts` 模式）
  2. 逐行 JSON 解析，取含 `message.usage` 的条目
  3. 字段映射（见第四节）、`messageId` 去重（同一文件内 Map）
  4. 复用 `adapter-zcode.cjs` 导出的 `normalizeModel` / `providerByModel`
  5. 损坏行 try/catch 跳过；单文件解析失败不影响整体
- 抽取完成后跑一次自校验：对最近 3 天记录求和，与抽样手算核对

### Step 2：注册与配置
- `adapter.cjs`：`sources = [zcode, codex, dsh, workbuddy]`
- `config.cjs`：默认 `sources` 追加 `{ source: "workbuddy", enabled: true, dataDir: null }`（默认启用，detect 不到自然跳过）
- 注意 `config.cjs` 的 `merged.sources = defaultConfig().sources.map(...)` 逻辑保证老配置升级后自动带上新源

### Step 3：前端对齐
- `src/types/index.ts`：`UsageRecord.source` 注释与 mock 数据加 `"workbuddy"`
- `src/api/mock.ts`：加一组 workbuddy 模拟记录（浏览器预览模式）
- 设置页/README 数据源表补一行：WorkBuddy ｜ `~/.workbuddy` ｜ `projects/**/*.jsonl` 的逐次 usage ｜ 启用

### Step 4：计费验证
- 首次同步后检查：glm/deepseek 系模型应命中内置价直接出费用；hy3 等未命中模型出现在「计费规则 → 从用量生成草稿」列表
- 核对一条记录：`费用 = (input−cache_read)×输入价 + cache_read×读价 + output×输出价`，与明细页 `costDisplay` 一致

### Step 5：边界测试
- 去重：同 messageId 的 message/reasoning 双条目只入一条（实测确认口径）
- 增量：二次同步仅补新消息；锚点回扫 24h 内改动的文件不重复入账（INSERT OR REPLACE 兜底）
- 跨日：按 `timestamp` 归属日分片，长会话跨天正确切分
- 幂等：重复同步结果一致；删除转录文件后不影响已入库数据
- 多机：第二台设备开启 workbuddy 源后 WebDAV 合并，两机 model/device 榜正确

### Step 6：文档
- README 数据源表、「Token 口径说明」补充 WorkBuddy 行（input 含缓存命中，同口径实测）
- `docs/操作.md` 补充探测/启用说明

### 验收标准
1. 设置页出现 WorkBuddy 源，可独立启用/停用；总览顶部切换后各视图口径正确。
2. 计费开启后 WorkBuddy 记录参与全部费用 KPI 与榜单，价格命中/未配置提示正确。
3. 连续两次同步，第二次新增记录数 = 两次间新产生消息数（无重复）。
4. CSV/JSON 导出含 workbuddy 记录且费用列正确。
