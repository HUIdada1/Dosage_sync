# Antigravity / Antigravity IDE 用量解析修正方案（已实施）

> 状态：已实施并验证通过（2026-09-05）
> 本文档汇总：问题诊断 → 本地数据调查结论 → 已拍板决策 → 最终设计 → 验证结果 → 已知限制

## 一、问题诊断

### 1. "立即同步"没有上传 Antigravity 数据的原因

应用日志（sync_log）显示每次同步都是：

```
未检测到正在运行的 Antigravity 语言服务，跳过配额快照
Antigravity / Antigravity IDE 获取完成：0 条记录
```

旧实现依赖 **language_server 进程正在运行**（从进程命令行提取端口/CSRF token 调 `GetUserStatus` RPC），软件没开就永远 0 条，自然无数据可上传；且 RPC 响应的解析字段（`promptCredits.used` 等）是猜测结构，与真实响应不符。上传/拉取/合并引擎本身正常（zcode 等源的分片均上传成功）。

### 2. 本地真正的用量数据在哪里

**不在** `~/.gemini/*/conversations`（会话 .pb/.db 只有操作步骤，已全面扫描无 token 字段），**不在**应用日志目录，而在：

```
%APPDATA%/Antigravity IDE/User/globalStorage/state.vscdb   （新版）
%APPDATA%/Antigravity/User/globalStorage/state.vscdb       （旧版，结构相同）
```

SQLite `ItemTable` 的键 `antigravityUnifiedStateSync.userStatus`，编码链为：

```
base64 → protobuf map entry{f1="userStatusSentinelKey", f2=内层 base64 文本} → base64 解码 → GetUserStatusResponse protobuf
```

响应结构（用本机真实数据解出）：

| 字段 | 内容 |
|---|---|
| f3 / f7 | 用户名 / 邮箱 |
| f33（深层 repeated） | 模型条目列表：f1 显示名、f15{f1: float 剩余配额比例 0~1, f2{f1: 重置时间 unix 秒}}、f16 速度档等 |
| f36 | 套餐信息（如 "Google AI Pro" / g1-pro-tier） |

**"使用量"的正确口径：已用 = 1 − 剩余比例**；两次快照间剩余比例的下降量即消耗，重置时间变化即进入新周期。

## 二、调查中发现的关键事实（决定方案形态）

1. **没有 token 数**：会话库、日志、state.vscdb 全部翻过，本地不存在任何 token 明细。且 Google AI Pro 的 Antigravity 配额本身按"请求额度"周期重置计量，官方层面无 token 账单 → 单位只能用**配额百分比点**。
2. **配额按池共享**：实测 Gemini 3.6/3.5/3.1 全部条目剩余比例与重置时间完全相同（同一池）。若按模型逐条记差值会把一份消耗重复计数 N 次 → **必须以池为记账原子单位**。
3. **快照有时效性**：state.vscdb 只在 Antigravity 运行联网时刷新（本机曾出现 8/12 的旧快照）→ 读文件方案无需软件运行，但比例新鲜度取决于最近一次使用；建议用完软件后同步。
4. **旧版可解析**：旧版 Antigravity 的 userStatus 同样存在，用"模式识别"（可读名 + [0,1] 浮点 + 1e9 量级时间戳的子消息）而非固定字段号匹配后，新旧两版都能解出模型条目。
5. **多账号**：userStatus 携带账号邮箱，但用户只看总额 → 不分账号存快照；切换账号导致的剩余跳变由"回升不计、新周期记累计"规则自然消化。

## 三、已拍板的决策

| 决策点 | 结论 |
|---|---|
| 单位口径 | 配额百分比点，保留两位小数（消耗 3.13% 记 3.13），存入 `inputTokens` 字段 |
| 池聚合 | 同池（remaining/resetAt 完全相同）合并为一条记录，池名取模型名公共前缀（Gemini / Claude / GPT-OSS 120B / Claude+GPT-OSS） |
| 首次同步 | 与 ZCode 语义对齐：直接记当前累计 `(1-剩余)×100`，不搞静默基线 |
| 时间戳 | 记录时间 = 本次同步时间（差值发生在两次快照之间的未知时刻，同步时间是可得的最佳时间） |
| 多账号 | 不分账号，只看总额；设备标识用 `~/.gemini/<子目录>/antigravity_state.pbtxt` 的 `installation_uuid` |
| 旧版解析 | 同一套模式识别解析；失败时优雅降级（空记录 + 日志） |
| modelCredits | 忽略（当前恒为 0 的备用积分字段） |

## 四、最终设计

### 代码变更

| 文件 | 变更 |
|---|---|
| `electron/backend/adapter-antigravity-common.cjs` | **重写**。删除进程枚举/RPC 全套；新增：极简 protobuf 解码器（varint/len/double/float）、`decodeUserStatus`（逐层下钻找 SentinelKey 键值对）、`findModelEntries`（模式识别模型条目，兼容字段号变动）、`groupPools`（按 remaining+resetAt 划池）、`computePoolConsumption`（池级差值记账）、`openReadOnly`（库被占用时复制临时副本回退） |
| `adapter-antigravity.cjs` / `adapter-antigravity-ide.cjs` | 参数瘦身为 `(id, name, homeSub, appDataName)`；detect/validate 改指向 `%APPDATA%/<应用>/User/globalStorage/state.vscdb` |
| `src/api/mock.ts` | 示例 dataDir 改为 `%APPDATA%` 路径 |
| `README.md` | 数据源表与统计口径说明同步更新 |
| `scripts/test-antigravity-parse.cjs` | 新增验证脚本（真实数据解析 + 记账全场景 + extract 全链路，meta 走内存 stub 不碰真实库） |

同步引擎 `sync.cjs`（抽取→上传→拉取→合并）**零改动**——修好抽取后数据自然按既有四阶段上传。

### 池级记账规则（`computePoolConsumption`）

- **跨期匹配**：本次池与上次快照池按「成员模型名有交集 且 resetAt 相同」匹配（不能用池名——池拆分/合并时标签会变）；
- 命中：消耗 = Σ max(0, 上次剩余 − 本次剩余)，一条记录；
- 未命中（新模型家族 / 周期重置 / 换账号）：记当前累计 `(1−剩余)×100`；
- 剩余回升自然得 0，不记；
- **拆分/合并自洽**：合并池拆开时只有真正下降的一方记差值；独立池巧合合并时按双方各自差值求和，不会按"首见累计"重复入账（场景 6/7 已验证）。

### 记录字段映射

```
source: antigravity / antigravity-ide    providerId: "Google"
modelId: 池名（如 "Gemini"）             inputTokens: 消耗百分比点（两位小数）
startedAt/completedAt: 本次同步时间       status: "success"
```

## 五、验证结果（2026-09-05，全部通过）

1. **真实数据解析**：新版解出 11 模型 → 2 池（Gemini 8 成员 96.87%；Claude+GPT-OSS 3 成员 100%）；旧版解出 8 模型 → 2 池（Gemini 5 成员 98.85%）；
2. **记账场景 10 项**：首次累计、同周期差值、周期重置、回升不计、无变化不计、拆分、巧合合并、三种池名生成 —— 全部 PASS；
3. **extract 全链路**（stub 元数据，不写真实库）：detect/validate 命中、installation_uuid 读取正常、首次同步产出 `Gemini 3.13 点` 一条、二次同步 0 条、模拟消耗后每池记 1 点。

## 六、已知限制（诚实声明）

1. **无 token 数**：该源数值单位是配额百分比点，与 zcode 等源的 token 数不同量纲，跨源求和时注意区分；
2. **整周期盲区**：两次同步之间若有整个配额周期悄悄走完并重置，该周期内未被快照观测到的消耗无处可寻（本地不存在该数据）；按周期结转口径，已观测部分的账不会丢；
3. **快照新鲜度**：比例数据依赖 Antigravity 最近一次联网刷新，建议用完软件后点同步；
4. **首次同步的累计值**归属在同步当天（其真实消耗分布在周期内的过去时段）。
