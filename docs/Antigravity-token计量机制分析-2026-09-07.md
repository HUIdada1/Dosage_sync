# Antigravity Token 统计机制分析

> 调研日期：2026-09-07
> 依据：官方文档 `antigravity.google/docs`（Plans / Models / CLI Headless / CLI Statusline / CLI Credits / Model Quotas）+ Gemini API `antigravity-agent` 文档 + 本机 `state.vscdb` 实测结论
> 版本：Antigravity 2.0 v2.12.2 / CLI v1.1.25 / SDK v0.1.16

---

## 〇、一句话结论

**Antigravity 存在两套互不相通的计量体系**：订阅用户看到的「配额百分比」不是 token，开发者能拿到的 token 数只出现在 CLI / API 的机器可读输出里，两者之间没有官方换算系数。因此「输入/输出 token 分别如何计算」这个问题，在订阅侧**没有官方答案**，只有在 CLI/API 侧才有明确字段口径。

---

## 一、两套并行的计量链路

| 维度 | A. 订阅配额层（Quota） | B. Token 层 |
|---|---|---|
| 面向 | IDE / CLI 订阅用户（Free / Pro / Ultra / Enterprise） | 自动化脚本、CI、API 调用方 |
| 计量单位 | **剩余比例（remaining_fraction 0~1）**，无绝对数值 | token 数 |
| 暴露位置 | `/usage` TUI 面板、模型选择器下拉、settings 页、statusline `quota` 对象 | `--output-format json` / `stream-json` 的 `usage`、statusline `context_window` 对象、`interaction.usage` |
| 刷新周期 | 5 小时窗 + 周窗（双窗口叠加） | 每次 API 调用实时回传 |
| 与成本关系 | 超出后用 AI credits，按 Gemini Enterprise 消费定价 | API 侧按 token 计费 |

官方对配额层的定性说明（Plans 页原文）：

> "Under the hood, the rate limits are correlated with **the amount of work done by the agent**, which can differ from prompt to prompt."

即：配额消耗与"agent 完成的工作量"相关，**不是** prompt 计数，也**没有承诺**是 token 计数。原文中 Plans / Models / Credits 三个页面**均未出现 token 作为配额计量单位**。

---

## 二、Token 层的明确口径（可验证）

### 2.1 CLI Headless：`--output-format json`

```
"usage": { "input_tokens": 10415, "output_tokens": 657,
           "thinking_tokens": 616, "cache_read_tokens": 8113,
           "total_tokens": 11072 }
```

用文档给出的三组示例做算术验证，四条口径全部成立：

| 口径 | 验证 | 结论 |
|---|---|---|
| `total = input + output` | 10415+657=11072 ✓ / 10522+354=10876 ✓ | **total 不含任何额外项** |
| `thinking ⊆ output` | 616 ≤ 657 / 329 ≤ 354 | **思考 token 计入输出** |
| `cache_read ⊆ input` | 8113 ≤ 10415 / 8112 ≤ 10522 | **缓存命中计入输入（不额外累加）** |
| stream-json 汇总 | step(10302,582) + checkpoint(116,7) = result(10418,589) ✓ | **result.usage = 各 step 累加，含 checkpoint 步骤** |

**含义**：这里报的 input 是"本次请求实际送进模型的全部内容"（含缓存命中部分），output 是"模型产生的全部内容"（含思考）。是**总口径**，不是"净新增"。

### 2.2 CLI Statusline JSON：字段最全

```json
"context_window": {
  "total_input_tokens": 88244,      // 本会话累计输入
  "total_output_tokens": 61074,     // 本会话累计输出
  "context_window_size": 1048576,   // 1M 窗口
  "used_percentage": 14.24,
  "remaining_percentage": 85.76,
  "current_usage": {                // 最近一次 API 调用
    "input_tokens": 63382,
    "output_tokens": 346,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 20857
  }
},
"quota": { "gemini-weekly": { "remaining_fraction": 0.9378,
                              "reset_time": "2026-07-06T07:50:32Z",
                              "reset_in_seconds": 560580 } }
```

验证：`(88244+61074) / 1048576 = 14.24%` = `used_percentage` ✓

由此确认：

- **窗口占用 =（累计输入 + 累计输出）/ 窗口大小**，缓存命中不单独扣减（因为它已在 input 内）；
- `total_*`（会话累计）与 `current_usage`（单次调用）**是两个不同量级**，不可混用（示例中 61074 vs 346）；
- 配额桶有 **bucket id**（示例为 `gemini-weekly`），带 `remaining_fraction` / `reset_time` / `reset_in_seconds`；
- 独有字段 `cache_creation_input_tokens`（**缓存写入**），这在 headless usage 里是没有的 —— 两个出口的列并不对齐。

### 2.3 Interactions API（Antigravity agent）

- 读取方式：`interaction.usage.total_tokens`；
- 预算控制：`agent_config.max_total_tokens`，官方定义其限制范围 = **input + output + thinking**，且 **cached tokens 不计入**；
- 官方明说这是 **best-effort**："actual usage may slightly exceed it depending on when the agent checks the budget between steps"；
- 触顶后任务以 `status: "incomplete"` 返回 —— 产出不完整，但已消耗的 token 照样发生；
- 官方给出的量级参考：

| 任务类型 | 输入 token | 输出 token |
|---|---|---|
| 研究/信息综合 | 100k–500k | 10k–40k |
| 文档/内容生成 | 100k–500k | 15k–50k |
| 流程/系统设计 | 100k–400k | 10k–30k |
| 数据处理/分析 | 300k–3M | 30k–150k |

  > "50–70% of input tokens are typically cached. Complex agentic workflows with many tool calls can accumulate 3–5 million tokens in a single interaction."
  > 自动上下文压缩（context compaction）触发点 **~135k tokens**。

---

## 三、输入 / 输出 token 分别由什么构成（推断部分已标注）

官方**没有**公布逐项构成清单，以下内容中可确认部分已标注来源，其余为合理推断：

**输入 token（每次调用的 input_tokens）**
- 系统提示 + Rules + Skills 定义 + MCP 工具声明（推断，未见于文档）
- 对话历史、工具返回结果、读入的文件内容 / 工件（推断）
- 图片（多模态，API 侧当前仅支持文本与图像）
- **缓存命中部分（cache_read）包含在内**，按缓存价计费，但仍全额占用上下文窗口（已验证）
- 上下文压缩会重写历史 → 压缩后 input 骤降，**不代表消耗减少，只是记账对象变了**

**输出 token（output_tokens）**
- 可见回复 + **思考 token（thinking_tokens）** + 工具调用参数（推断）
- 想算"真正给用户的文本量"，需 `output_tokens − thinking_tokens`

**明确不计量**
- Tab 补全：Plans 页写明 "Unlimited Tab completions"
- 环境计算（沙箱 CPU/内存/执行）：preview 期不计费，也不出现在 token 里

---

## 四、限制条件与无法被准确统计的场景（重点）

| # | 场景 | 为什么不准 |
|---|---|---|
| 1 | **配额 % → token 反推** | 两链路无官方换算系数；配额与"工作量"相关而非 token |
| 2 | **百分比的分母** | 分母不公开，且官方声明 "Usage limits ... subject to modification"，同一百分比在不同日期可能代表不同绝对量 |
| 3 | **本地无 token 明细** | IDE 侧 `state.vscdb` 只有 remaining fraction + reset time；本机已全面扫描 `~/.gemini/*/conversations`（.pb/.db）与日志目录，**无任何 token 字段** |
| 4 | **整周期盲区** | `state.vscdb` 仅在 Antigravity 联网运行时刷新；两次采样之间若整个周期走完并重置，该周期消耗无法观测 |
| 5 | **配额池共享** | Gemini 全系共享一池、Claude + GPT-OSS 共享另一池（Models 文档与本机实测一致）。按模型逐条记差值会把一份消耗重复计数 N 次 |
| 6 | **双窗口叠加** | 5 小时窗 + 周窗同时存在，只看一个会漏判；Pro 是"每 5 小时刷新，直到周上限" |
| 7 | **子代理 / /boost / teamwork** | 子代理"不继承父会话上下文，从干净状态启动"；其 token 是否汇入父会话 `total_*` 文档未说明。多智能体管道的 token 放大效应无法从面板还原 |
| 8 | **缓存写入缺失** | headless usage 只给 `cache_read_tokens`，无 cache_creation；statusline 才有。跨出口对账时列不齐 |
| 9 | **思考 token 不可见于订阅侧** | `/boost` 等深度推理显著放大 output，但配额面板不区分，配额消耗未必同比例放大 |
| 10 | **中断 / 截断 / 重试** | 取消的任务、限流重试、`status: "incomplete"` 的截断任务，官方未说明如何计入 |
| 11 | **输出无法硬性封顶（API 侧）** | 不支持 `max_output_tokens`（会 400），只能用 best-effort 的 `max_total_tokens` |
| 12 | **第三方模型跨池对比** | Claude / GPT-OSS 在 Enterprise 不可用且与 Gemini 分池，池间 token 数值不具可比性 |
| 13 | **AI credits 与 token 脱钩** | 订阅超额走 credits 按消费定价扣，与 token 数不是线性关系 |

---

## 五、用户查看用量时的关键注意点（Checklist）

1. **先分清看的是哪一层**：`/usage` 面板是配额百分比，headless/API 的 usage 才是 token —— 别拿百分比当 token 记账。
2. **取 token 用 result 事件**，不要拿中间 `step_update` 单个 usage 当全量（result = 各 step 累加，含 checkpoint）。
3. **input 含缓存、output 含思考**，跨工具对比口径必须先对齐（本项目其余源已统一为"缓存命中包含在输入内"，与此一致）。
4. **区分"会话累计"与"单次调用"**（statusline 的 `total_*` vs `current_usage`）。
5. **两个窗口都看**：5 小时窗 + 周窗；周上限才是 Pro 用户的真正天花板。
6. **盯住 `used_percentage`**，接近压缩触发点（API 侧 ~135k）时历史会被重写，后续 input 基准会变。
7. **用 `max_total_tokens` 设预算**，但要知道它 best-effort、不含缓存、且触顶会得到 `incomplete` 的不完整结果。
8. **深度任务按非线性放大预估**：参考官方区间（研究类 100k–500k 输入，数据处理类可达 3M；复杂流程单交互 3–5M）。
9. **采样要勤**：配额/上下文数据都是"当下快照"，用完即采样，避免整周期盲区。
10. **订阅用户真正该盯的是 AI credits 余额**（statusline 右侧 / `/credits`），token 只是 API 侧的付费依据。

---

## 六、对本项目（用量同步）的直接影响

1. **现状合理但需标注单位**：Antigravity 两源本地确实拿不到 token，"配额百分比点存 `inputTokens`"是唯一可行解，但**量纲与 ZCode / Codex / DSH / WorkBuddy 的 token 完全不同**，跨源求和与费用计算应把这两个源排除或单独标注单位。
2. **池级记账是必须的**：以「remaining + resetAt 完全相同」为池边界，否则重复计数。
3. **若将来要接真实 token**，唯一官方出口是 CLI 的 statusline payload / headless json，但它们是**会话内实时值**，无法回溯历史明细，只能靠常驻采样累积 —— 成本较高，需权衡。
4. **UI 建议**：该源数值后缀显示"配额点"而非 token，并在 tooltip 中注明"官方不提供 token 明细，数值为配额池剩余比例差值"。

---

## 附：可复现的验证命令

```bash
# token 层（需已登录）
agy -p "你的问题" --output-format json | jq '.usage'
agy -p "你的问题" --output-format stream-json | jq 'select(.event=="result") | .result.usage'

# 配额层
# CLI 内输入 /usage 或 /quota；状态栏右侧看 AI Credits 余额
```

上下文窗口与配额的实时 JSON（供 statusline 脚本消费）：
`~/.gemini/antigravity-cli/settings.json` 中配置 `statusLine.command`，脚本 stdin 会收到含 `context_window` 与 `quota` 的 payload。
