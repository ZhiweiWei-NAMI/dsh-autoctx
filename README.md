# dsh-autoctx

面向 dsh 的上下文与子代理决策插件，版本 **1.2.6**。Jev 负责评分和结构化选择，插件通过 dsh 原生会话、工具、子代理和压缩执行决策；编码仍由执行模型完成。

[English](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/README.en.md) · [源码](https://github.com/ZhiweiWei-NAMI/dsh-autoctx) · MIT

1.2.6 新增显式计划调度 `mode: plan`，路由学习独立存储；DSH `openai-codex` 路由的 GPT 系列可作为允许的备选模型，费用按目录价理论估算；`auto` 模式下新建的路由委派子代理继承父代理当前回合已闭合步骤并收到继承上下文说明；跟踪委派归属与父代理对结果的接收；先验覆盖也用于配置路由的能力文本。

**1.2.6 评测结论：** 在本次固定样本中，`deepseek-v4.1-flash` 配合 AutoCTX 通过官方评测 **18/24（75.0%）**，单代理为 **14/24（58.3%）**、原生子代理为 **13/24（54.2%）**，分别多解决 **4、5 个案例**。`gpt-6.1-sol` 三组解决相同的 18 个案例，AutoCTX 相对原生子代理的理论费用约低 37%，但仍比单代理贵。DeepSeek 的配对差异未达统计显著性，且存在基础设施重跑；这不是普遍更强或更省钱的证明，详见下方基准与限制。

## 环境与所需账号

单元测试通过的宿主为 **dsh `0.2.0-rc.2` 与 `0.2.1-rc.2`**，使用 Node 22；下方新 1.2.6 基准运行于 **dsh `0.2.1-rc.2`**，旧 1.2.5 基准运行于 `0.2.0-rc.2`；真实 smoke 运行已在 `0.2.1-rc.2` 验证。`@deepseek-ai/dsh-*` 包的 peer dependency 范围为 `^0.1.5-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1`。插件按每次触发的证据和各选项成本估算决定决策点的思考强度，细节见「工作方式」；保留对 dsh 0.2.1 子代理启动接口（`startActivation`）及 0.2.0 的兼容。npm 包名为 `dsh-autoctx`，入口为 `index.js`，Web 客户端为 `./client.js`。

你需要提供：

- **执行模型连接**：在 dsh profile 的设置/provider 中配置；插件不提供模型访问权限。
- **Jev API key**：在 [opencode.ai](https://opencode.ai) 获取 workspace key，填写 `apiKey`。该 key 发送至 `jevEndpoint`，默认地址为 `https://opencode.ai/inference/v1/systemone`。
- **可选的其他模型路由**：若 reviewer/advisor 使用其他模型，在 `modelRoutes` 中配置「模型 id → dsh provider 名称」；付费路由还需要 `allowPaidModels: true`。

未配置 `apiKey` 时，插件不发起 Jev 调用；`auto` 会话按原生模式运行，并记录 `reason: 'no-api-key'`，`plan` 模式使用固定路由。

## 安装与配置

1. 首次创建 profile。此命令会启动它；用 Ctrl+C 停止后继续安装。

   ```sh
   dsh --profile autoctx --from-default-profile web
   ```

   需要 headless profile 时，首次创建命令中的模板改为 `headless`。自定义 profile 启动时使用 `dsh --profile autoctx ...`。

2. 从 npm 安装，或选择 GitHub 发布标签来源。

   ```sh
   dsh plugin --profile autoctx add dsh-autoctx@1.2.6
   # 或使用发布标签
   dsh plugin --profile autoctx add github:ZhiweiWei-NAMI/dsh-autoctx#v1.2.6
   ```

   `dsh plugin --profile <name> <pnpm-args...>` 把参数传给 pnpm。Profile 位于 `$DSH_HOME/profiles/<name>`。包声明的 dsh bundle patch（`cordis.patch.yml`）会挂载插件并停用原生 `compaction-basic`，无需手工重复挂载。

3. 配置 dsh 自身的执行模型连接，并在 **profile 自己的** `$DSH_HOME/profiles/autoctx/cordis.patch.yml` 中加入以下最小配置，不要写到 home 级 patch。

   ```yaml
   - id: dsh-autoctx
     config:
       apiKey: <your opencode workspace key>
   ```

4. 启动 Web 应用。

   ```sh
   dsh --profile autoctx
   ```

仅一次启动停用插件并恢复原生压缩：

```sh
dsh --profile autoctx --patch "$DSH_HOME/profiles/autoctx/node_modules/dsh-autoctx/off.patch.yml"
```

升级到最新版，或固定到本版本：

```sh
dsh plugin --profile autoctx add dsh-autoctx@latest
# 或固定版本
dsh plugin --profile autoctx add dsh-autoctx@1.2.6
```

卸载前，先删除自己在 profile 的 `cordis.patch.yml` 中添加的 `- id: dsh-autoctx` 覆盖项，再执行：

```sh
dsh plugin --profile autoctx remove dsh-autoctx
```

移除 bundle 层会恢复原生压缩。

## 设置与默认值

Web 界面：左下角 **更多 → 设置 → DSH AutoCTX**。表单覆盖当前全部 Config 字段，含计划预算、provider 逗号列表、强度与缓存预算、子代理请求上限、原生阈值和记录路径。`routes` 与 `strategy` 使用 JSON 编辑器，拒绝格式或字段结构不符的输入。设置仍走宿主配置表单的版本与可写性检查；`apiKey` 保持 secret 控件，客户端只读取是否已配置。

设置页另列模型目录与配置路由，展示目录先验，并允许编辑或清除用户覆盖（可填原因）。先验描述模型能力，因此按部署共享，连同完整编辑历史保存在 `dsh_auto_priors` storage domain；清除覆盖后恢复目录先验。任务结果权重仍按工作区保存在账本中；输入框卡片的「调度与学习」权重表支持逐项编辑、保存、清除 [0,1] 的用户权重并填写原因，学习不会覆盖用户偏好。

**变更历史**完整保留全部账本变更（auto、approved、rejected、revert、user）和先验编辑，没有条数上限。历史逐条单独存储，工作区账本记录本身保持精简；旧版本账本中的历史会一次性导入且不重复，任何保留的已应用版本都可以回退。历史视图可按类型/来源筛选、搜索文本，并按真实总数翻页，展示时间、键或模型、前 → 后、来源、原因或 Jev 依据与证据 id（旧记录缺失字段显示「–」）。

输入框卡片还列出根会话每个角色最近保存的候选池，含计算时间、memoized 状态、不可用与过滤项以及后端原始 basis。尚无候选池时，配置路由与目录模型明确标为「尚未计算」；刷新视图只读取记录，不会触发重算。宿主没有逐消息装饰插槽，因此在 `conversation.chat.turnTail` 中按回合展示「由 AutoCTX 注入」面板，包含原生 one-shot 与侧栏子会话，列出每条注入消息的来源标签、类型、字符数与时间，不修改消息、不保存正文。

**未加载的会话**（已结束或中止的子会话、重启前的会话）在所有 AutoCTX 视图中都可用：会话的工作区与根会话通过原生 `sessionQuery` 服务解析；注入标签、候选池和每个根会话的统计卡片作为元数据保存在 `dsh_auto_ui` storage domain。未知会话返回错误，不会退回到其他工作区。1.2.6 之前版本插件运行的会话没有保存的注入与候选记录。

| 配置键 | 默认值与含义 |
| --- | --- |
| `mode` | `auto`；可选 `auto`、`single`、`native`、`plan` |
| `apiKey` | 未设置；`auto` 下未设置时使用原生模式，`plan` 使用固定路由 |
| `jevModel` | `jev-1.13`，计费；`jev-1.13-free` 可用但有限流 |
| `jevEndpoint` | `https://opencode.ai/inference/v1/systemone` |
| `modelRoutes` | `{}`；模型 id → dsh provider 名称 |
| `allowPaidModels` | `false`；是否允许付费路由 |
| `reviewerModel` | `same`；使用执行模型 fork 审查；`auto` 由 Jev 选择，也可指定模型 id |
| `reviewBeforeFinish` | `true`；修改文件的根回合结束前启动一个独立审查子代理 |
| `reviewMaxRequests` | `6`；审查请求上限 |
| `advisorModel` | `off`；可选 `off`、`auto` 或模型 id |
| `advisorMaxConsults` | `1`；顾问咨询上限 |
| `advisorStallSteps` | `6`；停滞步数阈值 |
| `adaptiveEffort` | `high`；Jev 思考策略要求时使用的 effort；`off` 保留默认 effort |
| `effortSwitchFreeTokens` | `4096`；决策点切换思考强度时，预计未缓存重读量不超过此值则不询问 Jev |
| `maxEffortDecisions` | `6`；每个根任务独立的 Jev 思考决策调用上限；不占用 `maxDecisions` |
| `effortPhaseRequests` | `4`；思考阶段内高强度请求上限；新触发会续期 |
| `cacheTtlSeconds` | `300`；运行时估算假设的缓存复用寿命；提供方 TTL 未验证 |
| `learning` | `frozen`；可选 `auto`、`manual`、`frozen` |
| `contextSelection` | `jev`；可选 `jev`、`summary` |
| `maxDecisions` | `12`；每个根任务的 Jev 路由/上下文决策调用上限 |
| `maxChildren` | `2`；子代理数量上限 |
| `maxConcurrent` | `2`；并发子代理数量上限 |
| `maxChildRequests` | `16`；子代理请求上限 |
| `maxChildTurnRequests` | `8`；子代理每回合请求上限 |
| `pressureTokens` | `64000` tokens；上下文压力阈值 |
| `ceilingRatio` | `1.5`；达到 `pressureTokens × ceilingRatio` 时必须缩减上下文 |
| `retainTokens` | `8000` tokens；保留 token 配置 |

## 工作方式

**决策。** 普通单代理持续累积一份上下文；原生子代理由执行模型自行选择 spawn/fork，原生压缩总结旧上下文。AutoCTX 在特定节点向 Jev 请求结构化决策。Jev 是评分/选择模型，不编写计划或代码。它判断拟议委派是否值得创建子代理及采用哪条路由；在回合开始给出任务标签与思考策略；在上下文压力下选择证据并判断现在还是稍后替换上下文，权衡重新读取未缓存内容的成本与后续请求缩小的收益；当角色设为 `auto` 时选择 reviewer/advisor 模型。

思考策略为 `off`、`decision_points` 或 `always`；决策点包括回合开始、测试失败、审查/顾问报告和停滞。自 1.2.5 起，每次触发提供失败测试输出摘录、diff hunk、审查/顾问报告文本或任务开头等证据，并按目录价给出各选项的估算成本：`skip` 留在当前缓存空间；`pulse` 仅一次高强度请求；`phase` 保持高强度，直到触发问题解决（测试通过、报告已处理、取得进展）或达到 `effortPhaseRequests` 次请求。预计未缓存重读量不超过 `effortSwitchFreeTokens` 的低成本切换，以及紧接上下文替换后的切换，不询问 Jev。思考决策使用独立的 `maxEffortDecisions`，不占用 `maxDecisions` 的 12 次路由/上下文决策。缓存复用按实际请求的精确前缀估算，不为缓存改写、重排或丢弃上下文；这些运行时估算均为理论值，非实际账单。

临时 Jev 网关/网络失败会重试一次，随后暂停 Jev 60 秒；认证、计费或 HTTP 429 会停止该任务的 Jev 调用，由本地回退接管：原生压缩、不委派。

**上下文选择。** `contextSelection: jev` 在上下文超过 `pressureTokens` 时，把旧区域拆成测试失败段、diff hunk、按函数/类划分的代码和段落等证据片段，而非整块输出。Jev 根据明确的待解决问题（例如仍失败的测试）以及必留内容，评估每片证据额外提供了什么。插件本地去重只保留一份；保留的报告会带入其引用的定义；增益低的片段各归档为一行。达到 `pressureTokens × ceilingRatio` 时必须缩减，必要时使用原生压缩。`summary` 则由执行模型总结。

**Reviewer。** 修改过文件的根回合结束前，一个审查子代理检查实际改动。简报先包含工作区 git diff 和每个改动 hunk 周围的代码，再附问题与证据账本。`DEFECTS` 报告返回执行模型处理，`LGTM` 结束回合。

**Advisor。** 默认关闭。在同一测试上反复修改并重跑仍失败，或出现停滞时，不带工具的顾问模型接收具体问题、原始失败摘录、diff、周边代码和此前尝试。

**学习。** 账本按工作区路径区分，存于 dsh storage 的 `dsh_auto`。每个根回合完成后，Jev 对每个使用过的（模型，角色），先判断其具体主张能否用它指明的后续修改/测试运行核验，再评价质量。整体任务成功或执行模型未采纳建议都不是证据；无法评估时，权重和样本数均不变。原生回答的赞/踩也是证据。

- `frozen`（默认）：仅记录证据，权重不变。
- `auto`（BETA，默认关闭）：自动应用有界更新。
- `manual`：将提案汇集到一张审批卡片。

自动学习有望随时间在保持质量的同时降低成本，但这只是预期，尚未展示。下方 **1.2.6 评测的学习模式为 `frozen`**：DeepSeek 解决更多案例体现的是 AutoCTX 决策机制在该样本中的表现，不是自动学习收益；较早的 1.2.5 评测中，auto 未超过 frozen。

## 额外调用与费用

Jev 调用、reviewer/advisor 子代理及其执行模型调用、回合结束时的学习调用，均由用户自己的 API 账号承担费用，不是免费服务。`models.json` 模型表中 `jev-1.13` 的目录价为 **每 100 万输入 tokens $0.042，输出 tokens $0**；`jev-1.13-free` 有限流。下方基准费用均为按目录价的理论估算，非实际账单（定义见基准一节）。新 1.2.6 评测中，DeepSeek A 每案例平均 12.1 次 Jev 请求，GPT A 为 5.9 次；Jev 不占用 256 次执行请求上限，单独最多 32 次。旧 1.2.5 在 72 个案例中调用 Jev 368 次，1.2.3 frozen 为 233 次；旧评测的 Jev 调用占用 64 次任务请求上限。

## 基准结果与限制

**理论费用依据。** 下文所有费用与缓存数据均为**按目录价的理论估算，非实际账单**。提供方报告的缓存命中受路由、账号和驱逐影响，因此各组按实际发送的 prompt 可复用的缓存，以相同假设和价格比较：请求复用同任务、同缓存空间（模型 + thinking/effort 配置［+ tools］）内与此前请求共享的最长前缀；任务内不设过期。未缓存输入按目录输入价（列有缓存写入价时用写入价），复用输入按缓存读取价，输出按输出价；Jev 输入 $0.042/百万 tokens，输出免费；包含执行模型、子代理及 Jev 的全部费用。此基准的任务内不设过期假设与运行时 `cacheTtlSeconds` 的寿命假设不同。

### 1.2.6：dsh 0.2.1-rc.2，执行请求上限 256（不含 Jev）

同一组 **12 个固定 SWE-bench Verified pytest 任务 × 2 个执行模型 × 2 次重复**，每执行模型、每组 24 个案例，共 **144 个评分案例**。官方 SWE-bench harness **v4.1.0** 判定 resolved；运行完成或 HTTP 200 均不等于通过。Harness 见 [bench/eval-021/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/eval-021/README.md)，报告脚本为 `bench/full_report.py`。

| 组别 | 配置 |
| --- | --- |
| B | 单代理，插件关闭；明确要求不委派 |
| C | 执行模型的原生 spawn/fork 子代理，插件关闭 |
| A | AutoCTX 1.2.6（发布版与评测构建 `f1d6c49` 仅相差两条 UI 提示文案和版本号），`mode: auto`、学习 frozen、结束前 reviewer 关闭、advisor 关闭 |

C 与 A 收到相同的一句委派指令：“Split the task into subtasks and delegate suitable subtasks to subagents with the subagent or subagent_fork tools, then integrate their results and verify the final change yourself.”

| 执行模型 | Harness | AutoCTX 额外模型 |
| --- | --- | --- |
| `deepseek-v4.1-flash` | 容器内运行，3 个案例并行 | `deepseek-v4-flash`、`glm-5.3-flash`、`deepseek-v4-pro`、`glm-5.3` |
| `gpt-6.1-sol` | DSH `openai-codex` 路由，宿主原生运行；shell 命令在任务容器内执行 | `gpt-6-sol`、`gpt-5.6-luna`、`gpt-6-luna`、`deepseek-v4.1-flash`、`glm-5.3-flash` |

Jev 为 `jev-1.13`。各组共同限制：**每案例 600 秒、256 次执行请求（不含 Jev；Jev 单独最多 32 次）、最多 2 个子代理 / 2 个并发子代理**。只有 DeepSeek C 的 3 个案例达到 256 次上限。所有组均用 `exact` 方法计算理论费用，采用上述目录价、精确前缀复用和相同假设，非实际账单。

经网络代理的传输错误、提供方 402 配额响应，以及 A 中插件自身重试后仍失败的 Jev 调用（`jev_unavailable`），均记为基础设施影响案例，归档保留后重新运行，最多 3 轮，另做一次最终清扫。最终 **144/144 有效**。重跑案例数（归档尝试数）：DeepSeek A 为 **11（16）**，GPT C 为 **3（8）**，GPT A 为 **5（9）**，其余为 0；DeepSeek A 早期曾按更严格的「任何 Jev 失败尝试都归档」规则处理。较长运行更容易遇到临时错误，因此另列去除任何一方曾重跑的配对后的敏感性结果。

下表费用均为理论估算。未完成计数指求解运行的超时或错误状态；resolved 则由 harness 对导出的补丁独立判定，两者可以重叠。

| 执行模型 | 组别 | Resolved /24 | 未完成（超时等） | 平均墙钟秒 | 平均 USD/案例 | 总 USD | USD/resolved | 平均执行请求 | 平均子代理数 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | B | 14 | 12 | 367 | 0.034 | 0.83 | 0.059 | 78 | 0 |
| deepseek-v4.1-flash | C | 13 | 13（10 次超时，3 次请求触顶后的代理错误） | 452 | 0.076 | 1.83 | 0.141 | 139 | 1.46 |
| deepseek-v4.1-flash | A | 18 | 9 | 416 | 0.095 | 2.27 | 0.126 | 107（另加 12.1 Jev） | 1.38 |
| gpt-6.1-sol | B | 18 | 1 | 460 | 0.163 | 3.91 | 0.217 | 25 | 0 |
| gpt-6.1-sol | C | 18 | 4 | 492 | 0.363 | 8.71 | 0.484 | 57 | 1.58 |
| gpt-6.1-sol | A | 18 | 3 | 490 | 0.229 | 5.50 | 0.306 | 77（另加 5.9 Jev） | 1.29 |

按同任务、同重复配对，差值为 **A 减对照组**；95% 区间为对 12 个任务均值做 percentile bootstrap，p 为不一致配对的精确 McNemar 检验。Resolved 差为比例差。

| 执行模型 / 对照 | 仅 A / 仅对照 / 均解决 / 均未解决 | Resolved 差 [95% CI] | McNemar p | 墙钟差秒 [95% CI] | USD/案例差 [95% CI] | A 更便宜 |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek A vs B | 5 / 1 / 13 / 5 | +0.17 [0.00, 0.33] | 0.22 | +48 [−45, +141] | +0.060 [+0.037, +0.086] | 3/24 |
| DeepSeek A vs C | 5 / 0 / 13 / 6 | +0.21 [0.08, 0.33] | 0.063 | −36 [−133, +51] | +0.019 [+0.001, +0.037] | 9/24 |
| GPT A vs B | 0 / 0 / 18 / 6 | 0（结果相同） | — | +30 [+1, +56] | +0.066 [+0.024, +0.126] | 3/24 |
| GPT A vs C | 0 / 0 / 18 / 6 | 0（结果相同） | — | −2 [−23, +18] | −0.134 [−0.175, −0.098] | 24/24 |

GPT A vs B 中，A 在 5/24 个配对中更快。去除任何一方曾重跑的配对后：

| 对照 | Resolved 差 [95% CI] | USD/案例差 [95% CI] | 配对说明 |
| --- | --- | --- | --- |
| DeepSeek A vs B | +0.11 [−0.11, 0.39] | +0.069 [+0.026, +0.121] | 13 对；仅 A / 仅 B 为 2/1 |
| DeepSeek A vs C | +0.22 [0.06, 0.44] | +0.032 [+0.005, +0.059] | 13 对；仅 A / 仅 C 为 3/0，p=0.25 |
| GPT A vs B | 0 | +0.037 [+0.014, +0.064] | 解决结果仍相同 |
| GPT A vs C | 0 | −0.135 [−0.182, −0.093] | A 在 16/16 对中更便宜 |

#### 1.2.6 结论

**DeepSeek：本次样本中解决更多案例，而非普遍降低费用。** 在 `deepseek-v4.1-flash` 上，AutoCTX 的官方 resolved 为 **18/24（75.0%）**，单代理 B 为 **14/24（58.3%）**，原生子代理 C 为 **13/24（54.2%）**：分别净增 **4、5 个案例**，解决率提高 **16.7、20.8 个百分点**。这里的“解决”是官方测试通过，不是运行正常结束；超时也可能留下可通过评测的补丁。24 个案例的配对差异未达统计显著性（p=0.22、0.063）；去除重跑配对后，对 B 的差异缩小（13 对，任务均值差 +0.11），对 C 的差异基本不变（+0.22，p=0.25）。每案例理论费用约为 B 的 2.8 倍、C 的 1.25 倍；每个 resolved 案例比 C 便宜约 10%，但约为 B 的 2.1 倍。DeepSeek 各组都有较多案例达到 600 秒超时。

**GPT：解决结果相同，相对原生子代理降低费用。** 在 `gpt-6.1-sol` 上，三组解决的是相同的 **18/24 个案例（75.0%）**，未观察到解决率提升。AutoCTX 比原生子代理 C 的理论费用约低 37%（24/24 配对均更便宜），墙钟时间相近；比单代理 B 约贵 40%，平均慢约 30 秒。

**适用范围：** 以上是 1.2.6 在 12 个固定 pytest 任务、2 个执行模型、2 次重复中的观察，包含前述基础设施重跑；费用为理论估算，GPT A 还有缺失 usage 的限制。不能推广到所有 DeepSeek/GPT 模型，也不能将下方旧 1.2.5 数据与新版直接相减来归因版本收益：两次评测的宿主、模型组合、请求预算和费用口径不同。

### 1.2.5：dsh 0.2.0-rc.2，请求上限 64（包含 Jev；较早评测）

仅报告本次运行，不代表普遍优势。每组使用相同的 **72 个评分案例 = 12 个固定 SWE-bench Verified pytest 任务（`bench/tasks.json`）× 3 个执行模型 × 每模型 2 次运行**。执行模型为 `deepseek-v4.1-flash`、`glm-5.3-flash`、`deepseek-v4-flash`。官方 SWE-bench harness **v4.1.0** 判定 resolved；运行完成或 HTTP 200 均不等于通过。

共同限制为：**每任务 600 秒、每任务 64 个模型请求（包含 Jev 调用）、案例并行数 3、最多 2 个子代理/2 个并发子代理**。AutoCTX 与 H 的每案例花费上限为 $0.10，B 与 C 使用 harness 默认的 $0.50；各组均无案例的理论费用（目录价）超过 $0.066，因此花费上限未起约束作用。

| 组别 | 配置 |
| --- | --- |
| B | 单代理；无子代理工具，原生压缩 |
| C | 原生 spawn/fork，仅执行模型；原生压缩，无 reviewer/advisor/额外模型 |
| H | 原生异构子代理；在执行模型及额外 3 个模型的每个（模型，effort）组合上提供一个原生子代理工具，由执行模型选择 |
| AutoCTX 1.2.5 frozen | 新版本；reviewer `auto`、advisor `auto`、相同的额外 3 个模型、`jev-1.13`；frozen 学习 |
| AutoCTX 1.2.3 frozen / auto | 上一版本，相同 harness；reviewer `auto`、advisor `auto`、相同的额外 3 个模型、`jev-1.13`；分别使用 frozen 和 auto 学习；auto 在同一次运行的案例间沿用账本 |

额外 3 个模型为 `glm-5.3-flash`（执行模型为它时改用 `deepseek-v4.1-flash`）、`deepseek-v4-pro`、`claude-haiku-5-5`。1.2.5 与 1.2.3/B/C/H 均运行于 dsh `0.2.0-rc.2`。B/C/H 不加载插件，均早于 1.2.3 运行。B/C 与 AutoCTX 使用同一 harness 入口；H 第 1 轮使用更早的 harness 快照（`run.py` 有差异），任务和上述共同限制相同。

两种测量方法：`exact` 使用 bench observer 记录的逐消息前缀哈希（AutoCTX 1.2.x）；B/C/H 运行时尚无前缀哈希，使用 `log` 重建（每个 session 按追加增长，输入量下降标记上下文改写）。在 12 个任务上用 `deepseek-v4.1-flash` 重跑 B/C、记录前缀哈希（24 个案例）验证：`log` 比 `exact` 的费用低 2.4%（B）和 3.1%（C）；在 AutoCTX 上约低 11%，因为上下文替换会改动较早的 prompt 内容却不一定缩短输入。因此下表基线理论费用可能低估约 3%，AutoCTX 溢价略被高估，而非低估。

下表费用与缓存率为理论估算，非实际账单。

| 指标（每组 72 个案例） | AutoCTX 1.2.5 frozen | AutoCTX 1.2.3 frozen | AutoCTX 1.2.3 auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Resolved / 72 | 53/72 | 52/72 | 49/72 | 39/72 | 44/72 | 42/72 |
| 1.2.5 frozen 对该组的配对胜/负（精确 McNemar p） | — | 6/5 (p=1.0) | — | 15/1 (p=0.001) | 12/3 (p=0.035) | 13/2 (p=0.007) |
| 理论总费用 USD（方法） | $1.738 (exact) | $1.810 (exact) | $1.603 (exact) | $0.908 (log) | $0.975 (log) | $1.027 (log) |
| 其中理论费用：执行模型 / 子代理 / Jev（USD） | 1.383 / 0.273 / 0.082 | 1.451 / 0.284 / 0.076 | 1.321 / 0.214 / 0.068 | 0.805 / 0.102 / 0 | 0.844 / 0.131 / 0 | 0.867 / 0.160 / 0 |
| 每个 resolved 案例的理论费用 | $0.0328 | $0.0348 | $0.0327 | $0.0233 | $0.0222 | $0.0244 |
| 执行模型理论缓存率 | 87.0% | 85.4% | 86.5% | 94.8% | 95.1% | 95.1% |
| 墙钟时间总和（秒） | 17580 | 18060 | 17670 | 17454 | 16520 | 17076 |
| Jev 调用成功/总数 | 367/368 | 233/233 | 260/260 | — | — | — |

若全部组统一用 `log` 方法，理论总费用为 AutoCTX 1.2.5 frozen $1.547，B 为 $0.908、C 为 $0.975、H 为 $1.027。

AutoCTX 在此样本中比 B、C、H 解决更多案例，也更贵；按理论费用，1.2.5 frozen 比 C 总费用约高 70–80%，每个 resolved 案例约高 48%。1.2.5 与 1.2.3 frozen 按相同运行通道配对、使用 `exact` 比较：53 对 52 个 resolved（6 胜 / 5 负，无质量差异）；理论总费用降低 4.0%（$1.738 对 $1.810），执行模型理论缓存率 87.0% 对 85.4%，Jev 理论费用增加 $0.006。

1.2.5 在 72 个案例中的思考决策：201 次低成本切换（不调用 Jev）、86 次 skip、51 次 phase、9 次 pulse、11 次紧接上下文替换、11 次在思考预算用尽后回退；19 个案例达到 64 请求上限（1.2.3 为 18 个）。该上限包含 Jev 调用，因此 AutoCTX 在执行请求更少时就会触顶：这 19 个案例中有 10 个未解决，其 640 次请求里 77 次（12%）为 Jev 调用。B/C/H 也分别有 17/20/16 个案例触顶，但全部为执行请求。这份历史评测保留该共同上限，未在原配置下仅改变 Jev 计数规则重跑；上方 1.2.6 已采用不含 Jev 的 256 次执行请求上限，但不是这一单变量对照。

| 执行模型（每组、每模型 24 个案例；resolved / 24） | AutoCTX 1.2.5 frozen | AutoCTX 1.2.3 frozen | AutoCTX 1.2.3 auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 18/24 | 17/24 | 16/24 | 11/24 | 15/24 | 14/24 |
| glm-5.3-flash | 17/24 | 18/24 | 18/24 | 17/24 | 18/24 | 18/24 |
| deepseek-v4-flash | 18/24 | 17/24 | 15/24 | 11/24 | 11/24 | 10/24 |

Auto 运行中，49 个已完成回合进入学习：35/49 个被判无法评估，权重不变；14/49 个应用了小幅更新。此处 auto 未超过 frozen。

测量范围仅为上述 12 个 pytest 任务和 3 个 flash 执行模型；重复运行之间，每次共 12 个任务的运行，resolved 数约波动 ±2 个。按理论费用，AutoCTX 在此处比基线更贵；auto learning 仍为 beta，默认关闭。宿主原生 fork 仍只继承已完成回合；在 `mode: auto` 下，AutoCTX 拦截并路由的新建委派子代理通过 closed-step seed 额外继承当前回合已闭合的步骤（不含正在委派的步骤），并收到继承上下文说明。审查等辅助子代理和 plan 子代理保留原有 seed 路径，审查简报仍携带当前回合证据。

## 复现

### 1.2.6

先按 [bench/eval-021/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/eval-021/README.md) 准备 dsh `0.2.1-rc.2`、容器与数据集、模型连接及宿主原生 `openai-codex` 认证；`DSH_BENCH_NODE` 指向对应 Node 安装，`DSH_BENCH_ROOT` 指向含 `evaluator/` 的基准目录。`$WITH_KEYS` 是自行提供的、为命令注入 `JEV_API_KEY` 的包装器。以下在仓库根目录运行，不启用 `--plan-routing` 或 `--plan-review`：

```sh
R=results/eval-1.2.6
$WITH_KEYS sh -c 'OPENCODE_API_KEY=$JEV_API_KEY exec python3 bench/eval-021/plan/run.py "$@"' sh \
  --model deepseek-v4.1-flash --arms A --tasks bench/eval-021/plan/tasks.json \
  --out "$R/deepseek-v4.1-flash/A" --plugin . --parallel 3 --repeat 2 --request-limit 256 \
  --extra-models deepseek-v4-flash,glm-5.3-flash,deepseek-v4-pro,glm-5.3 \
  --max-usd 0.50 --jev-model jev-1.13 --learning frozen
for arm in B C; do
  $WITH_KEYS python3 bench/eval-021/plan/run.py --model deepseek-v4.1-flash --arms "$arm" \
    --tasks bench/eval-021/plan/tasks.json --out "$R/deepseek-v4.1-flash/$arm" --plugin . \
    --parallel 3 --repeat 2 --request-limit 256 --max-usd 0.50
done
for arm in B C A; do
  for repeat in 1 2; do
    for lane in 1 2; do
      $WITH_KEYS python3 bench/eval-021/host/run_one.py --model gpt-6.1-sol --arm "$arm" \
        --tasks "bench/eval-021/plan/task-full-lane$lane.json" --out "$R/gpt-6.1-sol/$arm-r$repeat-lane$lane" \
        --plugin . --request-limit 256 --jev-model jev-1.13 \
        --extra-models gpt-6-sol,gpt-5.6-luna,gpt-6-luna,deepseek-v4.1-flash,glm-5.3-flash
    done
  done
done
```

每个输出目录分别用 `affected.py` 检查并归档受基础设施影响的案例；例如：

```sh
RUN="$R/gpt-6.1-sol/A-r1-lane1"
python3 bench/eval-021/affected.py "$RUN" \
  --archive "$R/_infra-archive/gpt-6.1-sol/A-r1-lane1" --tasks-out "$RUN/affected-tasks.json"
```

仅在输出的受影响任务数非零时重跑。DeepSeek 归档后续跑原命令；GPT 使用 `--tasks "$RUN/affected-tasks.json"`，并把 `--out` 改为同级新目录（如 `A-r1-lane1-retry1`），保留 arm、repeat、lane 标记。每轮重新检查，最多 3 轮，另做最终清扫。归档放在 `$R/_infra-archive/<执行模型>/...`，以便报告统计重跑；完成后对原始与重跑目录评分并生成报告：

```sh
for run in "$R/deepseek-v4.1-flash/"* "$R/gpt-6.1-sol/"*; do
  python3 bench/eval-021/plan/grade.py "$run" --parallel 3
done
python3 bench/full_report.py "$R" --json "$R/report.json" --md "$R/report.md"
```

`bench/full_report.py`（即 `bench/eval-021/../full_report.py`）递归收集结果，排除归档，输出按任务配对与去除重跑配对后的敏感性表；费用均为理论估算，非实际账单。

### 1.2.5

以下保留旧评测命令，使用 1.2.5 checkout。

在仓库目录中准备 [bench/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/README.md) 所列前置条件，包括 Docker 与 SWE-bench 镜像、模型网关和 `JEV_API_KEY`，然后运行：

```sh
python3 bench/run.py --model deepseek-v4.1-flash --arms A --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --reviewer auto --advisor auto --max-usd 0.10 \
  --jev-model jev-1.13 --learning frozen        # 或 --learning auto
python3 bench/run.py --model deepseek-v4.1-flash --arms B,C --tasks bench/tasks.json --out <dir> --plugin . --parallel 3
python3 bench/run.py --model deepseek-v4.1-flash --arms H --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --max-usd 0.10
python3 bench/grade.py <dir> --parallel 3
python3 bench/theoretical_cost.py "A=<dir>/*/A" "B=<dir>/*/B" "C=<dir>/*/C"
```

`<dir>` 替换为输出目录。A 是 AutoCTX；frozen 与 auto 使用各自目录。对全部 3 个执行模型分别运行，每个模型做 2 次运行，独立运行使用不同目录。`glm-5.3-flash` 对应的 `--extra-models` 改为 `deepseek-v4.1-flash,deepseek-v4-pro,claude-haiku-5-5`；`deepseek-v4-flash` 使用示例中的额外模型。重跑相同命令会续跑未完成案例。`--max-usd 0.10` 是 bench observer 的每案例 $0.10 花费上限。`bench/theoretical_cost.py` 按上文方法估算费用与缓存，输出均为理论估算，非实际账单。

## 从旧版本升级

按上面的升级步骤安装 1.2.6，并对照当前配置表检查 profile 覆盖项。不要沿用旧 README 中的默认模型或安装标签；当前默认是计费的 `jev-1.13`，发布标签为 `v1.2.6`。
