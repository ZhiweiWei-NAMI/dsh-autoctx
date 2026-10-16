# dsh-auto-context

dsh 的 Auto 决策插件。填写自己的 API Key 后直连 `jev-1.13-free` 获取结构化决策，插件通过 dsh 原生会话、工具和子代理接口落实决策。主代理和子代理使用配置的执行模型。插件不包含智能体执行运行时。未配置 `apiKey` 时按原生模式运行，不调用任何网络服务。

需要 dsh `0.1.5-rc.1` 或 `0.2.x`（已在 `0.2.0-rc.2` 上实测）。

## 从 0.5.x 升级

0.6.0 起插件改名为 `dsh-auto-context`：把 profile 覆盖里的 `dsh-auto` 条目改名为 `dsh-auto-context`，然后卸载旧包（`dsh plugin --profile auto remove dsh-auto`）再安装新包。存储域名保持 `dsh_auto`，已有策略数据继续可用。

## 设置页与输入框统计（0.6.0 新增）

插件自带浏览器端页面：**Plugins → dsh-auto-context → Configure** 可以编辑模式、Jev API Key、Jev 模型、决策预算、子代理与上下文相关字段；路由、策略与权重仍由 YAML 维护。会话输入框右下角会出现一个统计小徽章（仅在本会话被 Auto 处理过时显示）：圆环表示上下文压力，数字为 `决策/预算 · 运行中的子代理`，悬停展开详情卡片（模式、决策进度、子代理、上下文占用、压缩次数与节省 tokens、最近路由）。

## 安装

插件直连 Jev，不依赖其他网关：配置了 `apiKey` 就走直连，未配置时按原生模式运行。

```bash
# 新建 profile，然后从 GitHub 或 npm 安装
dsh --profile auto --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile auto add github:ZhiweiWei-NAMI/dsh-auto-context#v0.6.0
# 或 npm 包 dsh-auto-context
dsh plugin --profile auto add dsh-auto-context
```

在 profile 自己的 `cordis.patch.yml` 里给 `dsh-auto-context` 填最小配置。`apiKey` 到 <https://opencode.ai> 的 workspace API Keys 页面获取：

```yaml
- id: dsh-auto-context
  config:
    apiKey: <你的 opencode workspace key>
    routes:
      - id: general
        label: 通用实现
        model: deepseek-v4.1-flash
        description: 实现与修改代码
        efforts: [high]
      - id: review
        label: 独立检查
        model: deepseek-v4.1-flash
        description: 复核实现与测试证据
        efforts: [high]
```

`routes` 是允许使用的角色、模型和 effort，执行模型连接仍由 `settings.yaml` 决定。省略 `routes` 时自动使用当前会话的原生模型作为唯一默认路由。省略 `strategy` 时使用 `automatic` 模式和默认权重 `{quality: 0.8, latency: 0.5, usage: 0.5, cache: 0.8}`；`mode: single` / `native` 分别固定单代理和原生压缩。`apiKey` 声明为 secret，不会写入日志或记录文件。

未设置 `apiKey` 时不访问任何网络服务：会话按原生模式运行（等同 `strategy.mode: native`），并记录一条 `reason: 'no-api-key'` 的 `policy_snapshot`，不会抛错。

### 从 0.4.x 升级

profile 覆盖里的 `magpie-auto` 需改名为 `dsh-auto-context`；`endpoint` 字段已删除，应一并移除。

## 启用

服务器已安装到本机 `$DSH_HOME/profiles/auto`，直接选择：

```bash
# 启用 Auto，执行当前目录的任务
dsh --profile auto "你的编程任务"

# 同一模型连接，关闭 Auto，使用原生 dsh
dsh --profile auto --patch "$DSH_HOME/profiles/auto/node_modules/dsh-auto-context/off.patch.yml" "你的编程任务"
```

原有 `web`、`headless` 等 profile 保持原配置。`auto` 使用本机 dsh 的会话、工具和存储，不另设运行时或 `DSH_HOME`。以上开关在启动时选择，长任务中不要切换。

其他机器安装到一个新 profile（首次初始化执行一次）：

```bash
dsh --profile auto --from-default-profile headless --dump-config >/dev/null
dsh plugin --profile auto add github:ZhiweiWei-NAMI/dsh-auto-context#v0.6.0
```

v0.5.0 声明了原生 `dsh.bundle`，安装后自动挂载插件并停用 `compaction-basic`，无需手写 `insert`。卸载时先移除 profile 中自定义的 `dsh-auto-context` 覆盖条目，再运行 `dsh plugin --profile auto remove dsh-auto-context`，会移除该层并恢复原生压缩。旧版手工添加的插件和压缩开关应先从用户 patch 中移除，避免重复挂载。

执行模型连接仍需配置。服务器 `auto/cordis.patch.yml` 将 `settings` 指向同目录的 `settings.yaml`，其中选择 `deepseek-official` 适配器、`dsh-workbuddy/deepseek-v4.1-flash` 模型和 `http://127.0.0.1:3435/v1` 网关。该 profile 的 `.credentials.yaml` 仅存本机网关所需的非秘密占位值，不含上游账号或 Console 密钥。

需要覆盖插件限制时，在 **profile 自己的** `$DSH_HOME/profiles/auto/cordis.patch.yml` 增加：

```yaml
- id: dsh-auto-context
  config:
    maxChildren: 2
    maxConcurrent: 2
    maxChildRequests: 16
    maxChildTurnRequests: 8
    maxDecisions: 12
    pressureTokens: 64000
    retainTokens: 8000
```

Jev 决策在插件内直接调用，不再经过外部网关。执行模型连接使用 `settings.yaml` 中已有的 dsh 连接和 dsh-workbuddy 服务。

本机 Auto 的模型连接和默认执行模型位于 `$DSH_HOME/profiles/auto/settings.yaml`；插件限制位于同目录 `cordis.patch.yml`。不要写进 home 级 patch，以免影响其他 profile。`recordFile` 可指定一个已存在、可写目录中的 JSONL 文件，记录模型用量和原生子代理生命周期。

## 行为

执行模型通过原生 `subagent` 或 `subagent_fork` 提出具体子任务；Jev 分别判断未完成价值、依赖、配置匹配和会话延续性。插件据此让主代理继续、创建原生 continuable 子代理，或通过 `sendMessage` 延续已有子代理。默认后台执行，主代理可以同时工作；显式前台请求才等待。Jev 是评分/选择模型，不生成自由文本任务计划。

决策证据排除尚未执行的工具调用，并明确当前提案尚未分配。Jev 拒绝后，主代理应继续工作；取得新的工具结果或用户/子代理消息前，改写提案不会重复调用 Jev。

策略完全来自本地配置（`routes` + `strategy`），新会话创建时固定，已有会话不随全局编辑漂移。策略存入 dsh 原生 storage domain：`$DSH_HOME/storages/dsh_auto/`；模型历史仍由原生 session 管理，不向事件日志写入 SDK 不认识的事件类型。

`routes` 是允许使用的角色、模型和 effort。插件用 dsh 的连接准备接口检查候选配置；主代理默认模型仍由 `settings.yaml` 设置。当前服务器只实测 `deepseek-v4.1-flash` + `high`，不能据此声称跨模型路由提高了质量。策略权重是用户偏好，不是模型成功概率。

执行请求保留系统提示、工具定义和历史顺序，新内容追加。仅在压力达到阈值时，对旧区域的完整逻辑块分别问重要性与归属；不确定的证据保留。超大的块完整分片，任一片段保留则保留整块。选择后仍需达到最低预计缩减比例，才通过 dsh 原生压缩事务替换；否则提高下一次触发阈值。原始任务要求、近期工具配对和完整原始日志保留。归属评分参与保留判断和审计，不自动广播原始历史给全部子代理。

压力使用最近 API 实际输入加新增内容估算，避免原生累计估算量过高导致重复决策。没有 usage 时明确使用原生估算；估算不记作消耗。质量偏好提高保守保留和委派的置信门槛，缓存偏好提高替换所需缩减比例与再次决策间隔；时间/用量偏好提高委派收益门槛，角色初始偏好影响合格配置的排名。这些是可检查的启发式规则，尚非经过性能标定的最优策略。

任务共享子代理数量、并发和请求预算；达到子代理预算后主代理仍可继续。每次原生激活单列计数，不把同一子代理两次继续计成两个代理。决策预算不足时明确记录并使用原生压缩；Jev HTTP 错误直接保留并报告，不重试或伪造保留答案，不切换付费模型。Jev 与执行模型分别调用、分别计量。

## 关闭

使用上面的 `off.patch.yml`，同时卸载本次进程中的 Auto 插件并恢复 `compaction-basic`；关闭后不调用 Jev，也不施加插件的子代理预算。普通 `headless` / `web` profile 原本就未启用本插件。

只关闭 Jev、保留任务子代理上限时，可以把 `mode` 改为 `native`，同时把 `compaction-basic.disabled` 改为 `false`。

`mode: single` 禁止原生子代理调用，供单代理对照实验使用。单代理模式同样需要启用原生 `compaction-basic`。

也可以直接设定插件的 `mode` 来固定单代理或原生调度：`mode: native` 采用原生压缩，任务中不调用 Jev。它与 `strategy.mode` 的 `single` / `native` 是不同层级的入口。

## 验证

v0.3.1 已从 GitHub 安装到本机原生 `auto` profile，完成真实代码修改、子代理执行、结果回收和独立判题。配置开关、关闭后的代码产物也通过验证，已有默认配置保持不变。[安装验证记录](validation/local-install-20261013.json) 包含实际用量、首次/后续请求和未成功的开发探针。这是功能验证，不是性能 benchmark。

| 指标 | 本机安装后的子代理流程 |
| --- | --- |
| M1 正确性 | 插件短回归 9/9；最终代码测试 3/3，测试文件未改动 |
| M2 耗时 | 49.676 秒 |
| M3 用量 | DeepSeek 输入 138,403 / 输出 4,628；Jev 输入 2,375 / 输出 66 |
| M4 缓存 | DeepSeek 命中 24,448 / 未命中 113,955；写入及 Jev 缓存字段未提供 |
| M5 决策开销 | Jev 1 次、0.640 秒；DeepSeek 共 16 次 |
| M6 抖动 | 此次未做重复性能测量，不能估计 |
| M7 协作 | 1 个原生子代理完成并回收；主代理 10 次、子代理 6 次执行模型调用 |

修复前的补测发生 12 次拒绝且没有创建子代理；修复后同一职责流程由 Jev 选择创建并成功回收，拒绝记录没有删除。另一次安装失败后误用旧版本的探针被中断，也单列保留。没有据此宣称整体性能提高；账单字段未提供，不计算费用。

此前 v0.3.0 已验证同一原生子代理的两次激活及 Jev 上下文替换。旧 v0.2.2 的十二题 SWE-bench Verified 官方解决率为 Auto 6/12、单代理与原生可选协作各 8/12。未证明 Auto 普遍优于原生 dsh；共享 WorkBuddy 仍轮换账号，缓存抖动尚未全部解决。
