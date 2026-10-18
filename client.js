window.__ModuleLoader__.load({
	id: "dsh-autoctx",
	factory: (require) => {
		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");
		const en = {
			routes: "Task routes (JSON)",
			routesHint: 'JSON array of {id, label, model, provider, description, efforts?}. All named text fields are required; efforts is a list of strings.',
			strategy: "Strategy (JSON)",
			strategyHint: 'Object with optional mode (automatic/single/native), weights (quality, latency, usage, cache in [0,1]), and routeWeights (object). Omitted members inherit schema defaults.',
			preferredProviders: "Preferred providers",
			preferredProvidersHint: "Comma-separated provider names preferred when suitability is comparable.",
			allowedProviders: "Additional allowed providers",
			allowedProvidersHint: "Comma-separated names. Together with preferred providers, restricts executor-side routes whenever one fits. Empty lists impose no provider preference.",
			effortSwitchFreeTokens: "Free effort-switch tokens",
			effortSwitchFreeTokensHint: "Estimated uncached reread tokens allowed before asking Jev about an effort switch (minimum 0).",
			maxEffortDecisions: "Effort decision budget",
			maxEffortDecisionsHint: "Separate Jev effort decisions per root task (minimum 0).",
			effortPhaseRequests: "Effort phase requests",
			effortPhaseRequestsHint: "High-effort requests after a phase trigger (minimum 1); a new trigger renews the window.",
			cacheTtlSeconds: "Assumed cache lifetime (seconds)",
			cacheTtlSecondsHint: "Conservative reuse estimate (minimum 0), not a verified provider TTL.",
			maxChildRequests: "Child request cap",
			maxChildRequestsHint: "Total model requests per child (integer, minimum 1).",
			maxChildTurnRequests: "Child turn request cap",
			maxChildTurnRequestsHint: "Model requests per child turn (integer, minimum 2).",
			nativeThresholdRatio: "Native compaction threshold",
			nativeThresholdRatioHint: "Native context threshold ratio, from 0.01 to 1.",
			recordFile: "Record file",
			recordFileHint: "Optional server-side record path. Leave blank to inherit the profile value; Reset removes the override.",
			invalidRoutes: "Enter a JSON array matching the route fields above. Unknown fields are refused.",
			invalidStrategy: "Enter a JSON object matching the strategy fields above. Unknown fields are refused.",
			sectionAdvanced: "Routes and strategy",
			priorsTitle: "Model capability priors",
			priorsHint: "Deployment-wide text overrides, shared by all workspaces. Clearing restores the catalog text. These are priors, not measurements.",
			catalogPrior: "Catalog prior",
			userPrior: "Your override",
			noPrior: "No prior text recorded.",
			noModels: "No catalog models or configured routes match this filter.",
			edit: "Edit", clear: "Clear override", cancel: "Cancel", reason: "Reason (optional)",
			priorValue: "Capability prior text", weightValue: "User weight [0,1]", userWeight: "User weight",
			invalidWeight: "Enter a number from 0 to 1, or use Clear override.",
			invalidPrior: "Enter nonempty prior text, or use Clear override.",
			loadFailed: "Could not load this data.", loading: "Loading…", refresh: "Refresh view",
			historyTitle: "Change history", noHistory: "No retained changes match these filters.", revertVersion: "Revert v{version}",
			historyHint: "All retained workspace ledger changes and deployment-wide prior edits. Older records may lack reasons or evidence ids.",
			search: "Filter model, key, reason or evidence id", all: "All", previous: "Previous", next: "Next",
			historyPage: "{start}–{end} of {total}", source: "Source", time: "Time", beforeAfter: "Before → after", changeReason: "Reason / Jev basis", evidenceIds: "Evidence source ids",
			candidatesTitle: "Candidate models", notComputed: "Not computed yet — configured routes and catalog only; availability has not been checked.",
			computedAt: "Computed at", memoized: "Memoized", yes: "yes", no: "no", unavailableModels: "Unavailable",
			configuredRoutes: "Configured routes", catalogModels: "Catalog models", noCandidates: "No candidates recorded.",
			candidateHint: "Latest retained pool per role for the root session. Refresh view reads records; it does not recompute the pool.",
			injectedTitle: "Injected by AutoCTX", noInjections: "No retained injection records in this turn.",
			injectionHint: "Source metadata for this native conversation turn. Records are bounded in memory and are lost on restart.",
			messageKind: "Kind", chars: "{n} characters", from: "From",

			summary: "Auto routing, subagents and context compaction decided by Jev.",
			pageIntro: "Jev decides who works on a task (reviewer, advisor, workers), when to think and when to compact context; it learns from finished tasks in this workspace. The composer card shows each session's choices, costs and pending weight changes.",
			title: "Auto context",
			mode: "Mode",
			modeHint: "auto asks Jev for decisions; single keeps one agent; native keeps native compaction; plan dispatches explicit subtasks with native compaction.",
			planRouting: "Plan routing",
			planRoutingHint: "jev chooses task suitability, then context; fixed keeps the parent's model and effort without Jev. Plan mode disables review, advice, effort adaptation and economy guidance.",
			planMaxChildren: "Plan children per task",
			planMaxChildrenHint: "Total delegated subtasks across plans and replans (default 3).",
			planMaxJevCalls: "Plan Jev budget",
			planMaxJevCallsHint: "Separate routing, context and mediation calls per root task (default 6). Exhaustion uses fixed routing.",
			planChildRequests: "Plan child request cap",
			planChildRequestsHint: "Model requests per child, including compaction and reused turns (default 16).",
			apiKey: "Jev API key",
			apiKeyHint: "Leave blank to keep the configured key.",
			jevModel: "Jev model",
			jevModelHint: "Type the model name: jev-1.13 (billed to the key's workspace) or jev-1.13-free (free tier, rate limited).",
			maxDecisions: "Decision budget",
			maxDecisionsHint: "Jev decision calls per root task.",
			maxChildren: "Children per task",
			maxChildrenHint: "How many children one task may start.",
			maxConcurrent: "Concurrent children",
			maxConcurrentHint: "How many children may run at once.",
			pressureTokens: "Context pressure",
			pressureTokensHint: "Context size that starts compaction decisions.",
			retainTokens: "Retained tokens",
			retainTokensHint: "Recent tokens always kept during compaction.",
			economyGuidance: "Execution economy note",
			economyGuidanceHint: "Append one note before the root task's first request asking for batched, narrow tool use.",
			reviewBeforeFinish: "Review before finish",
			reviewBeforeFinishHint: "Optional independent review, off by default. Requires an API key; disabled in single and plan modes.",
			reviewMaxRequests: "Review request cap",
			reviewMaxRequestsHint: "Model requests allowed for one review child.",
			reviewerModel: "Reviewer model",
			reviewerModelHint: "same reviews with the executor's model (fork); auto lets Jev pick among the candidate models from priors, measurements and this workspace's experience; or a catalog id such as glm-5.3-flash.",
			advisorModel: "Advisor model",
			advisorModelHint: "off disables advice; auto lets Jev pick among the candidate models; or a catalog id. One short consultation per trigger.",
			allowPaidModels: "Allow paid models",
			allowPaidModelsHint: "Let roles use models whose dsh provider is a paid route.",
			advisorMaxConsults: "Advisor consultations",
			advisorMaxConsultsHint: "Consultations allowed per root task.",
			advisorStallSteps: "Advisor stall steps",
			advisorStallStepsHint: "Root requests without new evidence before the advisor is consulted (min 3).",
			keepRatio: "Keep ratio",
			keepRatioHint: "Share of a compacted region's tokens kept by budgeted selection (0.1–0.8).",
			yamlNote: "Settings use the host profile; workspace weights and deployment-wide prior overrides have separate persistent stores.",
			unavailable: "This plugin is not available for configuration.",
			readOnly: "This deployment stores settings read-only.",
			overridden: "Overridden",
			reset: "Reset",
			invalid: "Enter a number; leave blank to inherit the default.",
			keySet: "Configured",
			keyUnset: "Not configured",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			learning: "Learning",
			learningHint: "Default for workspaces without a ledger yet (frozen unless changed): auto (beta) applies Jev's weight proposals and logs them; manual collects them into one card for approval; frozen only records evidence. Switch an existing workspace in the composer card.",
			adaptiveEffort: "Thinking effort",
			adaptiveEffortHint: "Effort used when Jev decides a turn needs thinking (low, high or xhigh); it stays for the turn and changes only at a context checkpoint. off never raises it.",
			contextSelection: "Context compaction",
			contextSelectionHint: "jev keeps the most relevant evidence verbatim and weighs replacing now against the cache cost; summary lets the executor summarize the region.",
			jevEndpoint: "Jev endpoint",
			jevEndpointHint: "Decision API URL; change only for a compatible gateway.",
			modelRoutes: "Candidate models",
			modelRoutesHint: "Models Jev may pick for reviewer, advisor and workers, as model=provider separated by commas (e.g. deepseek-v4.1-flash=workbuddy, glm-5.3-flash=workbuddy). The executor's own model is always a candidate.",
			ceilingRatio: "Pressure ceiling",
			ceilingRatioHint: "Multiple of the context pressure at which the session must shrink, even if Jev would defer.",
			sectionJev: "Jev",
			sectionSubagents: "Subagents",
			sectionContext: "Context",
			statsMode: "Mode",
			statsDecisions: "Decisions",
			statsSubagents: "Subagents",
			statsRunning: "running",
			statsDone: "done",
			statsContext: "Context",
			statsCompactions: "Compactions",
			statsSaved: "saved {n} tokens",
			statsReviews: "Reviews",
			statsJevUnavailable: "Jev unavailable",
			statsJevUnavailableHint: "HTTP {status}; this task uses local fallbacks",
			statsReviewsLgtm: "LGTM",
			statsLastRoute: "Last route",
			pendingDot: "Weight changes are waiting for approval",
			statsCost: "Cost",
			costExecutor: "executor",
			costChildren: "children",
			costJev: "Jev",
			costCompaction: "compaction",
			costUnpriced: "+{n} unpriced",
			statsCache: "Cache",
			cacheReported: "Provider-reported cache hit",
			cacheExecutor: "executor",
			cacheCalls: "{n} calls",
			statsPrefix: "Prefix reuse",
			prefixValue: "{seeded}/{forks} forks seeded with parent history",
			prefixHint: "Session prefix reuse, not a cache hit: a reused prefix may still miss in the provider cache.",
			statsDeferrals: "{n} deferred for cost",
			statsPlan: "Turn plan",
			planNoTag: "untagged",
			thinkingOn: "thinking {effort}",
			thinkingOff: "thinking off",
			planProb: "Jev p {p}",
			thinking_off: "thinking off",
			thinking_decision_points: "thinking at decision points",
			thinking_always: "thinking always",
			planVia: "via {via}",
			viaJev: "Jev",
			viaKept: "kept",
			viaNone: "none",
			viaCheckpoint: "checkpoint",
			viaChoice: "model choice",
			viaFallback: "fallback",
			viaConfig: "config",
			schedTitle: "Scheduling & learning",
			learnMode: "Learning mode",
			learnAuto: "auto",
			learnManual: "manual",
			learnFrozen: "frozen",
			learnAutoHint: "Apply Jev's weight suggestions automatically and record every change.",
			learnManualHint: "Collect suggestions into one card for you to confirm.",
			learnFrozenHint: "Record evidence only; weights are not adjusted.",
			choiceConfidence: "Jev confidence (uncalibrated)",
			colModel: "Model",
			colProbability: "Jev choice probability",
			colWeight: "Workspace weight",
			colTag: "Tag",
			colRole: "Role",
			srcUser: "user",
			srcLearned: "learned",
			srcNone: "no evidence",
			filtered: "Filtered",
			weightsTitle: "Workspace weights",
			noWeights: "No weights recorded yet.",
			lastAuto: "Auto-adjusted {n} items",
			pauseAuto: "Pause auto",
			revertLast: "Restore previous version",
			reverted: "Restored",
			pendingTitle: "Weight changes to confirm (v{v})",
			pendingUpdated: "Updated",
			basis: "basis",
			target: "target",
			uncertainty: "uncertainty {x} (Jev, uncalibrated)",
			evidence: "{n} evidence",
			approve: "Approve this version",
			keepCurrent: "Keep current",
			feedbackNote: "Native thumbs up/down on answers (optional categories: result, instructions, cost, …) are used as learning evidence.",
			actionFailed: "The server did not accept this action."
		};
		const zh = {
			routes: "任务路由（JSON）",
			routesHint: "JSON 数组，每项含 id、label、model、provider、description 文本，efforts 可选（字符串数组）。",
			strategy: "策略（JSON）",
			strategyHint: "对象，可含 mode（automatic/single/native）、weights（quality、latency、usage、cache，各为 [0,1]）、routeWeights（对象）。省略的成员使用 schema 默认值。",
			preferredProviders: "优先 provider",
			preferredProvidersHint: "逗号分隔；适配程度相近时优先使用这些 provider。",
			allowedProviders: "额外允许的 provider",
			allowedProvidersHint: "逗号分隔；与优先列表共同约束执行侧路由，有适配项时排除其他 provider。两列表均为空时不施加偏好。",
			effortSwitchFreeTokens: "免决策切换 tokens",
			effortSwitchFreeTokensHint: "预估未缓存重读不超过此 tokens 数时，无需询问 Jev 即可切换强度（最小 0）。",
			maxEffortDecisions: "强度决策预算",
			maxEffortDecisionsHint: "每根任务独立的 Jev 强度决策次数（最小 0）。",
			effortPhaseRequests: "强度阶段请求数",
			effortPhaseRequestsHint: "阶段触发后允许的高强度请求数（最小 1）；新触发会刷新窗口。",
			cacheTtlSeconds: "假定缓存寿命（秒）",
			cacheTtlSecondsHint: "保守复用估算（最小 0），并非已验证的 provider TTL。",
			maxChildRequests: "子代理总请求上限",
			maxChildRequestsHint: "每个子代理的模型请求总数（整数，最小 1）。",
			maxChildTurnRequests: "子代理单轮请求上限",
			maxChildTurnRequestsHint: "子代理每回合的模型请求数（整数，最小 2）。",
			nativeThresholdRatio: "原生压缩阈值",
			nativeThresholdRatioHint: "原生上下文阈值比例，范围 0.01 到 1。",
			recordFile: "记录文件",
			recordFileHint: "可选的服务端记录路径。留空继承 profile 配置；恢复默认会移除覆盖值。",
			invalidRoutes: "请输入符合上述字段的路由 JSON 数组；不接受未知字段。",
			invalidStrategy: "请输入符合上述字段的策略 JSON 对象；不接受未知字段。",
			sectionAdvanced: "路由与策略",
			priorsTitle: "模型能力先验",
			priorsHint: "文本覆盖按部署保存，所有工作区共享。清除后恢复目录先验；先验不代表实测结果。",
			catalogPrior: "目录先验", userPrior: "用户覆盖", noPrior: "暂无先验文本。", noModels: "暂无匹配筛选条件的目录模型或配置路由。",
			edit: "编辑", clear: "清除覆盖", cancel: "取消", reason: "原因（可选）",
			priorValue: "能力先验文本", weightValue: "用户权重 [0,1]", userWeight: "用户权重",
			invalidWeight: "请输入 0 到 1 的数字，或使用清除覆盖。", invalidPrior: "请输入非空先验文本，或使用清除覆盖。",
			loadFailed: "无法读取数据。", loading: "读取中…", refresh: "刷新视图",
			historyTitle: "变更历史", noHistory: "保留的变更中暂无匹配记录。", revertVersion: "撤回 v{version}",
			historyHint: "包含全部保留的工作区账本变更和部署级先验编辑。旧记录可能没有原因或证据 id。",
			search: "筛选模型、key、原因或证据 id", all: "全部", previous: "上一页", next: "下一页",
			historyPage: "{start}–{end} / {total}", source: "来源", time: "时间", beforeAfter: "修改前 → 修改后", changeReason: "原因 / Jev 依据", evidenceIds: "证据来源 id",
			candidatesTitle: "候选模型", notComputed: "尚未计算：仅列出配置路由与目录，尚未检查可用性。",
			computedAt: "计算时间", memoized: "使用 memo", yes: "是", no: "否", unavailableModels: "不可用",
			configuredRoutes: "配置路由", catalogModels: "目录模型", noCandidates: "暂无候选记录。",
			candidateHint: "显示根会话每个角色最近保留的候选池。刷新视图只读取记录，不会重新计算候选池。",
			injectedTitle: "由 AutoCTX 注入", noInjections: "本回合暂无保留的注入记录。",
			injectionHint: "当前原生会话回合的来源元数据。记录有内存上限，重启后丢失。",
			messageKind: "类型", chars: "{n} 字符", from: "来自",

			summary: "自动路由、子代理与上下文压缩均由 Jev 决策。",
			pageIntro: "由 Jev 决定任务由谁参与（复核、顾问、子任务）、何时思考、何时压缩上下文，并从本工作区已完成的任务中学习。输入框统计卡片会显示每个会话的选择、成本与待确认的权重调整。",
			title: "Auto 上下文",
			mode: "模式",
			modeHint: "auto 由 Jev 决策；single 只用单代理；native 保持原生压缩；plan 显式分派子任务并保持原生压缩。",
			planRouting: "计划路由",
			planRoutingHint: "jev 先选适合任务的模型，再选上下文；fixed 沿用父代理模型与强度，不调用 Jev。plan 模式关闭复核、顾问、强度自适应及经济提示。",
			planMaxChildren: "计划子任务总数",
			planMaxChildrenHint: "同一根任务各次计划累计可委派的子任务数，默认 3。",
			planMaxJevCalls: "计划 Jev 预算",
			planMaxJevCallsHint: "路由、上下文及中介使用独立调用预算，默认 6；耗尽后使用 fixed 规则。",
			planChildRequests: "计划子代理请求上限",
			planChildRequestsHint: "每个子代理的模型请求数，包含压缩与复用后的轮次，默认 16。",
			apiKey: "Jev API Key",
			apiKeyHint: "留空表示保持当前密钥。",
			jevModel: "Jev 模型",
			jevModelHint: "填写模型名称：jev-1.13（按 key 所在 workspace 计费）或 jev-1.13-free（免费额度，有限流）。",
			maxDecisions: "决策预算",
			maxDecisionsHint: "每个根任务可用的 Jev 决策调用次数。",
			maxChildren: "每任务子代理数",
			maxChildrenHint: "一个任务最多可以启动的子代理数量。",
			maxConcurrent: "并发子代理",
			maxConcurrentHint: "同时运行的子代理数量上限。",
			pressureTokens: "上下文压力",
			pressureTokensHint: "上下文达到该规模时开始压缩决策。",
			retainTokens: "保留 tokens",
			retainTokensHint: "压缩时始终保留的近期 tokens。",
			economyGuidance: "执行经济提示",
			economyGuidanceHint: "在根任务首次请求前追加一条提示，要求批量、精准地使用工具。",
			reviewBeforeFinish: "完成前复核",
			reviewBeforeFinishHint: "可选的独立复核，默认关闭。需配置 API key；single 与 plan 模式禁用。",
			reviewMaxRequests: "复核请求上限",
			reviewMaxRequestsHint: "单个复核子代理可用的模型请求次数。",
			reviewerModel: "复核模型",
			reviewerModelHint: "same 用执行模型（fork）复核；auto 由 Jev 结合先验、实测与本工作区经验在候选模型中选择；也可填模型目录里的 id（如 glm-5.3-flash）。",
			advisorModel: "顾问模型",
			advisorModelHint: "off 关闭顾问；auto 由 Jev 在候选模型中选择；也可填模型目录里的 id。每次触发只咨询一次。",
			allowPaidModels: "允许付费模型",
			allowPaidModelsHint: "允许角色使用 dsh provider 属于付费线路的模型。",
			advisorMaxConsults: "顾问咨询次数",
			advisorMaxConsultsHint: "每个根任务允许的顾问咨询次数。",
			advisorStallSteps: "顾问停滞步数",
			advisorStallStepsHint: "根任务连续多少请求没有新证据后咨询顾问（最少 3）。",
			keepRatio: "保留比例",
			keepRatioHint: "预算选择保留被压缩区域 tokens 的比例（0.1–0.8）。",
			yamlNote: "设置使用宿主 profile；工作区权重与部署级先验覆盖分别持久保存。",
			unavailable: "该插件当前无法配置。",
			readOnly: "本部署的设置为只读。",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalid: "请填数字；留空表示使用默认值。",
			keySet: "已配置",
			keyUnset: "未配置",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			learning: "学习模式",
			learningHint: "尚无台账的工作区的默认值（默认 frozen）：auto（beta）自动应用 Jev 的权重建议并记录变更；manual 把建议汇总成一张待确认卡片；frozen 只记录证据、不调整。已有工作区请在输入框统计卡片中切换。",
			adaptiveEffort: "思考强度",
			adaptiveEffortHint: "Jev 判断本轮需要思考时使用的强度（low、high 或 xhigh）；整轮保持，只在上下文检查点改变。off 表示从不开启。",
			contextSelection: "上下文压缩",
			contextSelectionHint: "jev：原样保留最相关的证据，并权衡现在替换与缓存损失；summary：由执行模型总结该区域。",
			jevEndpoint: "Jev 接口地址",
			jevEndpointHint: "决策 API 地址；仅在使用兼容网关时修改。",
			modelRoutes: "候选模型",
			modelRoutesHint: "Jev 可为复核、顾问和子任务选择的模型，格式为 模型=provider，用逗号分隔（如 deepseek-v4.1-flash=workbuddy, glm-5.3-flash=workbuddy）。执行模型本身始终是候选。",
			ceilingRatio: "压力上限",
			ceilingRatioHint: "上下文压力的倍数；达到后即使 Jev 想推迟也必须压缩。",
			sectionJev: "Jev",
			sectionSubagents: "子代理",
			sectionContext: "上下文",
			statsMode: "模式",
			statsDecisions: "决策",
			statsSubagents: "子代理",
			statsRunning: "运行中",
			statsDone: "已完成",
			statsContext: "上下文",
			statsCompactions: "压缩次数",
			statsSaved: "已节省 {n} tokens",
			statsReviews: "复核",
			statsJevUnavailable: "Jev 不可用",
			statsJevUnavailableHint: "HTTP {status}；本任务改用本地回退",
			statsReviewsLgtm: "通过",
			statsLastRoute: "最近路由",
			pendingDot: "有待确认的权重调整",
			statsCost: "成本",
			costExecutor: "执行",
			costChildren: "子代理",
			costJev: "Jev",
			costCompaction: "压缩",
			costUnpriced: "+{n} 未计价",
			statsCache: "缓存",
			cacheReported: "接口报告缓存命中",
			cacheExecutor: "执行器",
			cacheCalls: "{n} 次调用",
			statsPrefix: "会话前缀复用",
			prefixValue: "{seeded}/{forks} 个 fork 带父会话历史启动",
			prefixHint: "这是会话前缀复用，不是缓存命中：复用的前缀在接口缓存中仍可能未命中。",
			statsDeferrals: "因成本推迟 {n} 次",
			statsPlan: "本轮计划",
			planNoTag: "无标签",
			thinkingOn: "思考 {effort}",
			thinkingOff: "思考关闭",
			planProb: "Jev 概率 {p}",
			thinking_off: "不思考",
			thinking_decision_points: "关键节点思考",
			thinking_always: "全程思考",
			planVia: "来源 {via}",
			viaJev: "Jev",
			viaKept: "沿用",
			viaNone: "无",
			viaCheckpoint: "检查点",
			viaChoice: "模型选择",
			viaFallback: "回退",
			viaConfig: "配置",
			schedTitle: "调度与学习",
			learnMode: "学习模式",
			learnAuto: "自动",
			learnManual: "手动",
			learnFrozen: "冻结",
			learnAutoHint: "自动应用 Jev 的权重建议并记录变更。",
			learnManualHint: "建议汇总成一张待确认卡片。",
			learnFrozenHint: "只记录证据，不调整。",
			choiceConfidence: "Jev 置信度（未校准）",
			colModel: "模型",
			colProbability: "Jev 选择概率",
			colWeight: "工作区权重",
			colTag: "标签",
			colRole: "角色",
			srcUser: "用户",
			srcLearned: "学习",
			srcNone: "无证据",
			filtered: "已过滤",
			weightsTitle: "工作区权重",
			noWeights: "暂无权重记录。",
			lastAuto: "已自动调整 {n} 项",
			pauseAuto: "暂停自动",
			revertLast: "恢复上一版本",
			reverted: "已恢复",
			pendingTitle: "待确认的权重调整 (v{v})",
			pendingUpdated: "已更新",
			basis: "依据",
			target: "目标",
			uncertainty: "不确定度 {x}（Jev 未校准）",
			evidence: "{n} 条证据",
			approve: "批准此版本",
			keepCurrent: "保持当前",
			feedbackNote: "对回答的原生点赞/点踩（可选分类：结果、指令、成本等）会作为学习证据。",
			actionFailed: "服务端未接受此操作。"
		};
		const NS = "plugins.dshAutoctx";
		const CONFIG_KEY = "dsh-autoctx#dsh-autoctx";
		const inject = ["slots", "locale", "configForms"];
		const NUMERIC_FIELDS = ["maxDecisions", "maxChildren", "maxConcurrent", "pressureTokens", "ceilingRatio", "retainTokens", "keepRatio", "reviewMaxRequests", "advisorMaxConsults", "advisorStallSteps", "planMaxChildren", "planMaxJevCalls", "planChildRequests", "effortSwitchFreeTokens", "maxEffortDecisions", "effortPhaseRequests", "cacheTtlSeconds", "maxChildRequests", "maxChildTurnRequests", "nativeThresholdRatio"];
		// Enumerated fields render as segmented controls.
		const SEGMENTED = { mode: ["auto", "single", "native", "plan"], planRouting: ["jev", "fixed"], learning: ["auto", "manual", "frozen"], contextSelection: ["jev", "summary"] };
		// modelRoutes is a model -> provider map, edited as "model=provider, model=provider".
		const routesField = {
			field: "modelRoutes",
			format: (value) => value && typeof value === "object" ? Object.entries(value).map(([model, provider]) => model + "=" + provider).join(", ") : "",
			parse: (text) => {
				const parts = text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
				if (!parts.length) return { kind: "clear" };
				const routes = Object.create(null);
				for (const part of parts) {
					const [model, provider, extra] = part.split("=").map((x) => x.trim());
					if (!model || !provider || extra !== undefined) return undefined;
					routes[model] = provider;
				}
				return { kind: "set", value: routes };
			}
		};
		const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
		const only = (object, names) => Object.keys(object).every((key) => names.includes(key));
		const structured = (field, validate) => ({
			field, format: (value) => value === undefined ? "" : JSON.stringify(value, null, 2),
			parse: (input) => {
				if (!input.trim()) return { kind: "clear" };
				try { const value = JSON.parse(input); return validate(value) ? { kind: "set", value } : undefined; }
				catch { return undefined; }
			}
		});
		const routeJSON = structured("routes", (value) => Array.isArray(value) && value.every((route) =>
			isObject(route) && only(route, ["id", "label", "model", "provider", "description", "efforts"]) &&
			["id", "label", "model", "provider", "description"].every((key) => typeof route[key] === "string") &&
			(route.efforts === undefined || Array.isArray(route.efforts) && route.efforts.every((effort) => typeof effort === "string"))));
		const strategyJSON = structured("strategy", (value) => isObject(value) && only(value, ["mode", "weights", "routeWeights"]) &&
			(value.mode === undefined || ["automatic", "single", "native"].includes(value.mode)) &&
			(value.weights === undefined || isObject(value.weights) && only(value.weights, ["quality", "latency", "usage", "cache"]) &&
				Object.values(value.weights).every((weight) => typeof weight === "number" && weight >= 0 && weight <= 1)) &&
			(value.routeWeights === undefined || isObject(value.routeWeights)));
		const listField = (field) => ({ field,
			format: (value) => Array.isArray(value) ? value.join(", ") : "",
			parse: (input) => ({ kind: "set", value: input.split(/[,\n]/).map((part) => part.trim()).filter(Boolean) })
		});
		const NUMBER_RULES = {
			maxDecisions: [1, Infinity, true], maxChildren: [0, Infinity, true], maxConcurrent: [1, Infinity, true],
			pressureTokens: [1024], ceilingRatio: [1], retainTokens: [1024], keepRatio: [0.1, 0.8],
			reviewMaxRequests: [1, Infinity, true], advisorMaxConsults: [0, Infinity, true], advisorStallSteps: [3, Infinity, true],
			planMaxChildren: [0, Infinity, true], planMaxJevCalls: [0, Infinity, true], planChildRequests: [1, Infinity, true],
			effortSwitchFreeTokens: [0], maxEffortDecisions: [0], effortPhaseRequests: [1], cacheTtlSeconds: [0],
			maxChildRequests: [1, Infinity, true], maxChildTurnRequests: [2, Infinity, true], nativeThresholdRatio: [0.01, 1]
		};
		const numberField = (name) => {
			const spec = ui.settingsNumberField(name), [min, max = Infinity, integer] = NUMBER_RULES[name];
			return { ...spec, parse: (input) => {
				const write = spec.parse(input);
				return write && (write.kind === "clear" || Number.isFinite(write.value) && write.value >= min && write.value <= max &&
					(!integer || Number.isInteger(write.value))) ? write : undefined;
			} };
		};
		const BOOLEAN_FIELDS = ["economyGuidance", "reviewBeforeFinish", "allowPaidModels"];
		const booleanField = (field) => ({
			field,
			format: (value) => value === true ? "true" : value === false ? "false" : "",
			parse: (text) => {
				const trimmed = text.trim();
				if (trimmed === "") return { kind: "clear" };
				if (trimmed === "true") return { kind: "set", value: true };
				if (trimmed === "false") return { kind: "set", value: false };
				return undefined;
			}
		});
		const specs = Object.fromEntries([
			...Object.keys(SEGMENTED).map((name) => ui.settingsTextField(name)),
			ui.settingsTextField("jevModel"), ui.settingsTextField("jevEndpoint"), ui.settingsTextField("adaptiveEffort"),
			ui.settingsTextField("reviewerModel"), ui.settingsTextField("advisorModel"), ui.settingsTextField("recordFile"), routesField,
			routeJSON, strategyJSON, listField("preferredProviders"), listField("allowedProviders"),
			...NUMERIC_FIELDS.map(numberField),
			...BOOLEAN_FIELDS.map(booleanField)
		].map((spec) => [spec.field, spec]));
		// Its own entry in the settings navigation: the same form, bound to the plugin's config entry.
		function AutoSettingsSection({ t, form }) {
			const snapshot = react.useSyncExternalStore((listener) => form.subscribe(listener), () => form.getSnapshot());
			const [revision, setRevision] = react.useState(0);
			return jsxs("div", { className: "dac-page", children: [
				jsx("h2", { className: "dac-pageTitle", children: "DSH AutoCTX" }),
				jsx("p", { className: "dac-pageIntro", children: t("pageIntro") }),
				jsx(AutoConfigForm, { t, form: { state: snapshot, mutate: (ops, revision) => form.mutate(ops, revision) } }),
				jsx(PriorsPanel, { t, onChange: () => setRevision((value) => value + 1) }), jsx(HistoryPanel, { t, kind: "prior", revision })
			] });
		}
		function AutoConfigCard({ t, view, form }) {
			if (view === "summary") return t("summary");
			return jsx(AutoConfigForm, { t, form });
		}
		function AutoConfigForm({ t, form }) {
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [keySet, setKeySet] = react.useState(null);
			react.useEffect(() => {
				fetch(new URL("./api/dsh-autoctx/stats", document.baseURI)).then((response) => response.ok ? response.json() : null)
					.then((body) => setKeySet(typeof body?.apiKeyConfigured === "boolean" ? body.apiKeyConfigured : null)).catch(() => setKeySet(null));
			}, [saving]);
			const snapshot = form?.state;
			const baseline = draft?.baseline ?? snapshot;
			const available = snapshot?.status === "ready";
			const writable = available && snapshot.writable;
			const disabled = !writable || saving;
			const stage = (name, text, clear = false) => {
				setDraft((current) => ({ baseline: current?.baseline ?? snapshot,
					fields: { ...current?.fields, [name]: { text, clear } } }));
				setFailed(false);
			};
			const operations = [];
			let invalid = false;
			for (const [name, edit] of Object.entries(draft?.fields ?? {})) {
				if (name === "apiKey") {
					if (edit.text.trim()) operations.push({ op: "set", path: [name], value: edit.text });
					continue;
				}
				const write = edit.clear ? { kind: "clear" } : specs[name].parse(edit.text);
				if (!write) invalid = true;
				else operations.push(write.kind === "clear" ? { op: "unset", path: [name] }
					: { op: "set", path: [name], value: write.value });
			}
			const discard = () => { setDraft(null); setFailed(false); };
			const save = async () => {
				if (disabled || invalid || !operations.length) return;
				setSaving(true);
				setFailed(false);
				try {
					if (await form.mutate(operations, baseline.revision)) discard();
					else setFailed(true);
				} catch { setFailed(true); }
				finally { setSaving(false); }
			};
			const field = (name) => {
				const spec = specs[name], edit = draft?.fields[name];
				const write = edit ? edit.clear ? { kind: "clear" } : spec.parse(edit.text) : undefined;
				const props = {
					id: "dac-" + name, label: t(name), hint: t(name + "Hint"), disabled,
					text: edit?.text ?? spec.format(baseline?.value?.[name]),
					overridden: edit ? write?.kind === "set" : Object.hasOwn(baseline?.user ?? {}, name),
					invalid: !!edit && !write,
					overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t(name === "routes" ? "invalidRoutes" : name === "strategy" ? "invalidStrategy" : "invalid"),
					onEdit: (text) => stage(name, text),
					onReset: () => stage(name, spec.format(baseline?.base?.[name]), true)
				};
				if (name === "routes" || name === "strategy") return jsxs("div", { className: "dac-block", children: [
					jsx("label", { className: "dac-label", htmlFor: props.id, children: props.label }),
					jsx("div", { className: "dac-hint", id: props.id + "-hint", children: props.hint }),
					jsx("textarea", { id: props.id, className: "dac-input dac-json", value: props.text, disabled,
						"aria-invalid": props.invalid, "aria-describedby": props.id + "-hint " + props.id + "-error",
						onChange: (event) => props.onEdit(event.target.value), rows: 8, spellCheck: false }),
					jsx("div", { id: props.id + "-error", role: props.invalid ? "alert" : undefined,
						className: "dac-error", children: props.invalid ? props.invalidLabel : null }),
					props.overridden ? jsx("button", { type: "button", className: "dac-link", disabled,
						onClick: props.onReset, children: props.resetLabel }) : null
				] }, name);
				if (SEGMENTED[name]) return jsxs("div", { className: "dac-mode", children: [
					jsxs("div", { className: "dac-modeHead", children: [
						jsx("span", { className: "dac-label", children: props.label }),
						props.overridden ? jsx("button", { type: "button", className: "dac-link", disabled, onClick: props.onReset, children: props.resetLabel }) : null
					] }),
					jsx("div", { className: "dac-seg", role: "radiogroup", "aria-label": props.label, children: SEGMENTED[name].map((value) => jsx("button", {
						type: "button", role: "radio", "aria-checked": props.text === value, disabled,
						className: "dac-segItem", onClick: () => props.onEdit(value), children: value
					}, value)) }),
					jsx("div", { className: "dac-hint", children: props.hint })
				] }, name);
				if (BOOLEAN_FIELDS.includes(name)) return jsxs("div", { className: "dac-toggle", children: [
					jsxs("div", { className: "dac-toggleRow", children: [
						jsx("span", { className: "dac-label", children: props.label }),
						jsx(ui.Switch, {
							checked: props.text === "true", label: props.label, disabled,
							onChange: (next) => props.onEdit(next ? "true" : "false")
						})
					] }),
					props.overridden ? jsx("button", { type: "button", className: "dac-link", disabled, onClick: props.onReset, children: props.resetLabel }) : null,
					jsx("div", { className: "dac-hint", children: props.hint })
				] }, name);
				return jsx(ui.SettingsValueField, { ...props, numeric: NUMERIC_FIELDS.includes(name) }, name);
			};
			const section = (key) => jsx("h3", { className: "dac-sectionTitle", children: t(key) }, key);
			return jsx(ui.SettingsForm, {
				labels: Object.fromEntries(["unavailable", "readOnly", "saveFailed", "save", "saving"].map((key) => [key, t(key)])),
				state: { available, writable, dirty: writable && (invalid || operations.length > 0), invalid, saving, failed },
				onSave: save, onDiscard: discard,
				children: jsxs("div", { className: "dac-form", children: [
					field("mode"),
					field("planRouting"), field("planMaxChildren"), field("planMaxJevCalls"), field("planChildRequests"),
					section("sectionJev"),
					jsx(ui.SettingsSecretField, {
						id: "dac-apiKey", label: t("apiKey"), hint: t("apiKeyHint"), disabled,
						text: draft?.fields.apiKey?.text ?? "", configured: keySet,
						stateLabel: keySet === null ? "–" : t(keySet ? "keySet" : "keyUnset"),
						onEdit: (text) => stage("apiKey", text)
					}),
					field("jevModel"), field("learning"), field("adaptiveEffort"), field("maxDecisions"), field("jevEndpoint"),
					field("effortSwitchFreeTokens"), field("maxEffortDecisions"), field("effortPhaseRequests"), field("cacheTtlSeconds"),
					section("sectionSubagents"), field("reviewerModel"), field("advisorModel"),
					field("allowPaidModels"), field("maxChildren"), field("maxConcurrent"), field("maxChildRequests"), field("maxChildTurnRequests"),
					field("reviewBeforeFinish"), field("reviewMaxRequests"),
					field("advisorMaxConsults"), field("advisorStallSteps"),
					section("sectionContext"), field("contextSelection"), field("pressureTokens"), field("ceilingRatio"),
					field("retainTokens"), field("keepRatio"), field("nativeThresholdRatio"), field("economyGuidance"),
					section("sectionAdvanced"), field("routes"), field("modelRoutes"), field("preferredProviders"), field("allowedProviders"),
					field("strategy"), field("recordFile"),
					jsx("div", { className: "dac-hint", children: t("yamlNote") })
				] })
			});
		}
		const compact = (n) => n === null || n === undefined ? "–" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
		const ring = (done, total) => {
			const ratio = total > 0 ? Math.min(1, done / total) : 0;
			const warn = ratio >= 0.8;
			return jsxs("svg", { className: "dac-ring", viewBox: "0 0 16 16", width: 14, height: 14, children: [
				jsx("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "var(--dsw-alias-border-l3)", strokeWidth: 2 }, "bg"),
				jsx("circle", {
					cx: 8, cy: 8, r: 6, fill: "none",
					stroke: warn ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-business-primary)",
					strokeWidth: 2, strokeLinecap: "round",
					strokeDasharray: `${ratio * 37.7} 37.7`, transform: "rotate(-90 8 8)"
				}, "fg")
			] });
		};
		const spark = jsx("svg", { viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": true, children: jsx("path", {
			d: "M8 1l1.8 4.4L14 6.2l-3.1 2.9.8 4.5L8 11.4l-3.7 2.2.8-4.5L2 6.2l4.2-.8L8 1z",
			fill: "currentColor"
		}) });
		const bolt = jsx("svg", { viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": true, children: jsx("path", {
			d: "M9 1L3 9h4l-1 6 6-8H8l1-6z",
			fill: "currentColor"
		}) });
		const CSS = `.dac-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:20px;cursor:pointer;user-select:none;position:relative}
.dac-chip:hover,.dac-chip:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);outline:none}
.dac-chipNums{font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:3px}
.dac-ring{flex:none}
.dac-pop{position:absolute;bottom:100%;right:0;z-index:20;padding-bottom:8px;cursor:auto;user-select:text}
.dac-card{box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow-y:auto;padding:12px 14px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dac-cardTitle{margin:0 0 8px;font-size:13px;font-weight:500;line-height:20px}
.dac-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:baseline}
.dac-key{color:var(--dsw-alias-label-secondary)}
.dac-bar{display:block;position:relative;height:3px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-border-l3);margin-top:3px;overflow:hidden}
.dac-barFill{position:absolute;inset:0;right:auto;background:var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-xs)}
.dac-barFill[data-warn=true]{background:var(--dsw-alias-state-warn-primary)}
.dac-sectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;margin:14px 0 0;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dac-form{display:flex;flex-direction:column;gap:6px;max-width:560px}
.dac-mode{display:flex;flex-direction:column;gap:6px;padding:4px 0 8px}
.dac-modeHead{display:flex;align-items:baseline;justify-content:space-between}
.dac-toggle{display:flex;flex-direction:column;gap:6px;padding:4px 0 8px}
.dac-toggleRow{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dac-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dac-link{font:inherit;font-size:12px;color:var(--dsw-alias-state-business-primary);background:none;border:0;padding:0;cursor:pointer}
.dac-seg{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3)}
.dac-segItem{font:inherit;font-size:12.5px;line-height:20px;min-width:72px;padding:3px 12px;border:0;border-radius:calc(var(--dsw-radius-md) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dac-segItem:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dac-segItem[aria-checked=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px var(--dsw-alias-border-l3);font-weight:500}
.dac-segItem:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dac-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dac-page{box-sizing:border-box;height:100%;overflow:auto;padding:28px clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary)}
.dac-page>*{max-width:720px}
.dac-pageTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dac-pageIntro{margin:4px 0 20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dac-dot{position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1)}
.dac-dotInline{position:static;display:inline-block;box-shadow:none}
.dac-val{min-width:0;overflow-wrap:anywhere}
.dac-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dac-expand{font:inherit;display:flex;align-items:center;gap:6px;width:100%;margin-top:10px;padding:8px 0 0;border:0;border-top:.5px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);font-weight:500;text-align:left;cursor:pointer}
.dac-expand:hover{color:var(--dsw-alias-label-primary)}
.dac-sched{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.dac-block{display:flex;flex-direction:column;gap:4px}
.dac-blockHead{font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dac-pending{padding:8px 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-3)}
.dac-item{padding:4px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dac-tbl{display:grid;gap:2px 10px;font-variant-numeric:tabular-nums}
.dac-tbl>span{min-width:0;overflow-wrap:anywhere}
.dac-th{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dac-strong{font-weight:500}
.dac-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.dac-btn{font:inherit;font-size:12px;line-height:18px;padding:2px 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}
.dac-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.dac-btn:disabled{opacity:.5;cursor:default}
.dac-badge{padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-state-warn-primary);color:#fff;font-size:11px;line-height:16px;font-weight:500}
.dac-segSm .dac-segItem{min-width:0;padding:2px 10px;font-size:12px}
.dac-input{box-sizing:border-box;width:100%;min-width:0;font:inherit;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dac-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dac-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dac-json{font-family:monospace;resize:vertical;tab-size:2}
.dac-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dac-editor{display:flex;flex-direction:column;gap:6px;padding:4px 0}
.dac-prose{white-space:pre-wrap;overflow-wrap:anywhere}
.dac-injections{font-size:12px;line-height:18px;margin:8px 0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.dac-injections>summary,.dac-item>summary{cursor:pointer;font-weight:500}
.dac-sessionDetails{position:relative;font-size:12px}
.dac-sessionDetails>.dac-card{position:absolute;bottom:100%;right:0;z-index:20}
.dac-card:has(.dac-editor){width:560px}
.dac-tbl:has(.dac-editor){overflow-x:auto}`;
		const usd = (n) => typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(Math.abs(n) >= 1 ? 2 : 4) : "–";
		const pct = (p) => p == null ? "–" : Math.round(p * 100) + "%";
		const fixed2 = (n) => n == null ? "–" : Number(n).toFixed(2);
		const text = (v) => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
		const cap = (s) => s[0].toUpperCase() + s.slice(1);
		const VIAS = ["jev", "kept", "none", "checkpoint", "choice", "fallback", "config"];
		const LEARN_MODES = ["auto", "manual", "frozen"];
		const SOURCES = { user: "srcUser", learned: "srcLearned", none: "srcNone" };
		const viaLabel = (t, via) => VIAS.includes(via) ? t("via" + cap(via)) : text(via) || "–";
		const keyParts = (key) => { const [tag, model, role] = String(key).split("|"); return [tag || "–", model || "–", role || "–"]; };
		const weightLabel = (t, weight, source, n) => [fixed2(weight), SOURCES[source] ? t(SOURCES[source]) : text(source),
			source !== "none" && n > 0 ? "n=" + n : null].filter(Boolean).join(" · ");
		const row = (label, value) => jsxs(react.Fragment, { children: [
			jsx("span", { className: "dac-key", children: label }),
			jsxs("div", { className: "dac-val", children: value })
		] });
		const table = (columns, head, rows) => jsx("div", { className: "dac-tbl", style: { gridTemplateColumns: columns }, children: [
			...head.map((label, i) => jsx("span", { className: "dac-th", children: label }, "h" + i)),
			...rows.flatMap((cells, r) => cells.map((cell, i) => jsx("span", {
				className: cell?.className, title: cell?.title, children: typeof cell === "object" && cell ? cell.text : cell
			}, r + ":" + i)))
		] });
		const apiURL = (path) => new URL("./api/dsh-autoctx/" + path, document.baseURI);
		async function api(path, payload) {
			const response = await fetch(apiURL(path), payload === undefined ? { cache: "no-store" } : {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
			});
			if (!response.ok) throw new Error("AutoCTX request failed");
			return response.json();
		}
		// Several native turn tails can mount together. Share their in-flight metadata read;
		// only the open turn polls, and no completed response is cached beyond its readers.
		const injectionRequests = new Map();
		function readInjections(path) {
			if (!injectionRequests.has(path)) {
				const pending = api(path).finally(() => injectionRequests.delete(path));
				injectionRequests.set(path, pending);
			}
			return injectionRequests.get(path);
		}
		function useResource(path, revision, interval) {
			const [state, setState] = react.useState({ path, loading: true });
			const [refresh, setRefresh] = react.useState(0);
			react.useEffect(() => {
				let alive = true, inFlight = false;
				const controller = new AbortController();
				setState((current) => ({ path, data: current.path === path ? current.data : undefined, loading: true }));
				const pull = async () => {
					if (inFlight) return;
					inFlight = true;
					try {
						let data;
						if (path.startsWith("injections?")) data = await readInjections(path);
						else {
							const response = await fetch(apiURL(path), { cache: "no-store", signal: controller.signal });
							if (!response.ok) throw new Error("AutoCTX request failed");
							data = await response.json();
						}
						if (alive) setState({ path, data });
					} catch (error) {
						if (alive && error.name !== "AbortError") setState((current) => ({ ...current, loading: false, failed: true }));
					} finally { inFlight = false; }
				};
				pull();
				const timer = interval ? setInterval(() => { if (document.visibilityState === "visible") pull(); }, interval) : null;
				return () => { alive = false; controller.abort(); clearInterval(timer); };
			}, [path, revision, interval, refresh]);
			return { ...(state.path === path ? state : { loading: true }), reload: () => setRefresh((value) => value + 1) };
		}
		const timeText = (value) => {
			if (value === undefined || value === null) return "–";
			const date = new Date(value);
			return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString();
		};
		const valueText = (value) => value === null || value === undefined ? "–" : text(value);
		const actionButton = (label, onClick, disabled) => jsx("button", { type: "button", className: "dac-btn", onClick, disabled, children: label });
		function ResourceStatus({ t, resource }) {
			return jsxs(react.Fragment, { children: [
				resource.loading ? jsx("div", { className: "dac-hint", role: "status", children: t("loading") }) : null,
				resource.failed ? jsx("div", { className: "dac-error", role: "alert", children: t("loadFailed") }) : null
			] });
		}
		function OverrideEditor({ t, value, weight, busy: parentBusy, onSave }) {
			const [editing, setEditing] = react.useState(false), [draft, setDraft] = react.useState(""), [reason, setReason] = react.useState("");
			const [busy, setBusy] = react.useState(false), [failed, setFailed] = react.useState(false);
			const numeric = Number(draft), valid = weight ? draft.trim() !== "" && Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 : !!draft.trim();
			const disabled = busy || parentBusy;
			const submit = async (clear) => {
				setBusy(true); setFailed(false);
				try {
					const accepted = await onSave(clear ? null : weight ? numeric : draft, reason.trim() || undefined);
					if (accepted === false) setFailed(true);
					else { setEditing(false); setReason(""); }
				} catch { setFailed(true); }
				finally { setBusy(false); }
			};
			if (!editing) return actionButton(t("edit"), () => { setDraft(value === undefined ? "" : String(value)); setReason(""); setFailed(false); setEditing(true); }, disabled);
			return jsxs("div", { className: "dac-editor", children: [
				jsx(weight ? "input" : "textarea", { className: "dac-input", "aria-label": t(weight ? "weightValue" : "priorValue"),
					value: draft, disabled, type: weight ? "number" : undefined, min: weight ? 0 : undefined, max: weight ? 1 : undefined,
					step: weight ? "any" : undefined, rows: weight ? undefined : 5,
					"aria-invalid": !valid, onChange: (event) => setDraft(event.target.value) }),
				!valid ? jsx("div", { className: "dac-hint", children: t(weight ? "invalidWeight" : "invalidPrior") }) : null,
				jsx("input", { className: "dac-input", value: reason, disabled, "aria-label": t("reason"), placeholder: t("reason"), onChange: (event) => setReason(event.target.value) }),
				jsxs("div", { className: "dac-actions", children: [
					actionButton(t(busy ? "saving" : "save"), () => submit(false), disabled || !valid),
					actionButton(t("clear"), () => submit(true), disabled || value === undefined),
					actionButton(t("cancel"), () => setEditing(false), disabled)
				] }),
				failed ? jsx("div", { className: "dac-error", role: "alert", children: t("actionFailed") }) : null
			] });
		}
		function PriorsPanel({ t, onChange }) {
			const resource = useResource("priors"), [query, setQuery] = react.useState("");
			const models = resource.data?.models.filter((model) => model.id.toLowerCase().includes(query.toLowerCase()));
			return jsxs("section", { className: "dac-sched", children: [
				jsx("h3", { className: "dac-sectionTitle", children: t("priorsTitle") }),
				jsx("div", { className: "dac-hint", children: t("priorsHint") }),
				jsx("input", { className: "dac-input", value: query, "aria-label": t("search"), placeholder: t("search"), onChange: (event) => setQuery(event.target.value) }),
				actionButton(t("refresh"), resource.reload, resource.loading), jsx(ResourceStatus, { t, resource }),
				models?.length === 0 ? jsx("div", { className: "dac-hint", children: t("noModels") }) : null,
				...(models ?? []).map((model) => jsxs("details", { className: "dac-item", children: [
					jsx("summary", { children: model.id }),
					model.routes.length ? jsx("div", { className: "dac-hint", children: model.routes.map((route) => [route.id, route.provider].filter(Boolean).join(" / ")).join(", ") }) : null,
					jsx("div", { className: "dac-label", children: t("catalogPrior") }),
					jsx("div", { className: "dac-prose", children: model.catalog ?? t("noPrior") }),
					jsx("div", { className: "dac-label", children: t("userPrior") }),
					jsx("div", { className: "dac-prose", children: model.override ?? "–" }),
					jsx(OverrideEditor, { t, value: model.override, onSave: async (value, reason) => {
						await api("priors", { model: model.id, value, reason }); resource.reload(); onChange?.();
					} })
				] }, model.id))
			] });
		}
		function HistoryPanel({ t, sessionId, kind, revision, post, busy }) {
			const [offset, setOffset] = react.useState(0), [query, setQuery] = react.useState(""), [via, setVia] = react.useState("");
			react.useEffect(() => setOffset(0), [sessionId, kind, revision]);
			const params = new URLSearchParams({ offset: String(offset), limit: "25" });
			if (sessionId) params.set("session", sessionId);
			if (kind) params.set("kind", kind);
			if (query) params.set("q", query);
			if (via) params.set("via", via);
			const resource = useResource("history?" + params.toString(), revision), data = resource.data;
			return jsxs("section", { className: "dac-block", children: [
				jsx("h3", { className: "dac-sectionTitle", children: t("historyTitle") }),
				jsx("div", { className: "dac-hint", children: t("historyHint") }),
				jsx("input", { className: "dac-input", value: query, placeholder: t("search"), "aria-label": t("search"),
					onChange: (event) => { setQuery(event.target.value); setOffset(0); } }),
				jsx("select", { className: "dac-input", value: via, "aria-label": t("source"), onChange: (event) => { setVia(event.target.value); setOffset(0); },
					children: ["", "auto", "approved", "rejected", "revert", "user", "prior"].map((value) => jsx("option", { value, children: value || t("all") }, value)) }),
				actionButton(t("refresh"), resource.reload, resource.loading), jsx(ResourceStatus, { t, resource }),
				data?.entries.length === 0 ? jsx("div", { className: "dac-hint", children: t("noHistory") }) : null,
				...(data?.entries ?? []).map((entry) => jsxs("article", { className: "dac-item", children: [
					jsx("div", { className: "dac-strong", children: entry.model ?? entry.key }),
					jsx("div", { className: "dac-sub", children: timeText(entry.at) + " · " + valueText(entry.via) + " / " + valueText(entry.source) }),
					jsx("div", { className: "dac-prose", "aria-label": t("beforeAfter"), children: valueText(entry.before) + " → " + valueText(entry.after) }),
					jsx("div", { className: "dac-prose dac-sub", children: t("changeReason") + ": " + valueText(entry.reason) }),
					jsx("div", { className: "dac-sub", children: Array.isArray(entry.evidence) ? t("evidence", { n: String(entry.evidence.length) }) : t("evidenceIds") + ": –" }),
					Array.isArray(entry.evidence) && entry.evidence.length ? jsx("div", { className: "dac-prose dac-sub", children: entry.evidence.join("\n") }) : null,
					post && entry.kind === "ledger" && ["auto", "approved"].includes(entry.via) ? actionButton(t("revertVersion", { version: String(entry.version) }), () => post({ action: "revert", version: entry.version }), busy) : null
				] }, entry.id)),
				data ? jsxs("div", { className: "dac-actions", children: [
					actionButton(t("previous"), () => setOffset(Math.max(0, offset - data.limit)), resource.loading || offset === 0),
					jsx("span", { className: "dac-hint", children: t("historyPage", { start: String(data.entries.length ? offset + 1 : 0), end: String(data.entries.length ? offset + data.entries.length : 0), total: String(data.total) }) }),
					actionButton(t("next"), () => setOffset(data.nextOffset), resource.loading || data.nextOffset === null)
				] }) : null
			] });
		}
		function CandidatePanel({ t, sessionId }) {
			const [offset, setOffset] = react.useState(0);
			react.useEffect(() => setOffset(0), [sessionId]);
			const resource = useResource("candidates?session=" + encodeURIComponent(sessionId) + "&offset=" + offset + "&limit=25", undefined, 3000), data = resource.data;
			const candidates = (entries) => entries?.length ? table("minmax(0,1fr) minmax(0,1fr) auto", [t("colModel"), "provider / id", "efforts"],
				entries.map((entry) => [entry.model ?? entry.id, [entry.provider, entry.id].filter(Boolean).join(" / ") || "–", entry.efforts?.join(", ") || "–"]))
				: jsx("div", { className: "dac-hint", children: t("noCandidates") });
			return jsxs("section", { className: "dac-block", children: [
				jsx("h3", { className: "dac-sectionTitle", children: t("candidatesTitle") }),
				jsx("div", { className: "dac-hint", children: t("candidateHint") }),
				actionButton(t("refresh"), resource.reload, resource.loading), jsx(ResourceStatus, { t, resource }),
				data?.computed === false ? jsxs(react.Fragment, { children: [
					jsx("p", { className: "dac-hint", children: t("notComputed") }),
					jsx("div", { className: "dac-label", children: t("configuredRoutes") }),
					candidates([...data.configured.routes, ...data.configured.modelRoutes]),
					jsx("div", { className: "dac-label", children: t("catalogModels") }),
					...data.configured.catalog.map((entry) => jsx("div", { className: "dac-sub", children: entry.id + (entry.providers?.length ? " · " + entry.providers.join(", ") : "") }, entry.id))
				] }) : null,
				...(data?.pools ?? []).map((pool) => jsxs("div", { className: "dac-item", children: [
					jsx("div", { className: "dac-strong", children: pool.role }),
					jsx("div", { className: "dac-sub", children: t("computedAt") + ": " + timeText(pool.at) + " · " + t("memoized") + ": " + (pool.memoized === true ? t("yes") : pool.memoized === false ? t("no") : "–") }),
					candidates(pool.candidates),
					jsx("div", { className: "dac-prose", children: t("basis") + ": " + valueText(pool.basis) }),
					...(pool.unavailable ?? []).map((entry, index) => jsx("div", { className: "dac-prose dac-sub", children: t("unavailableModels") + ": " + entry.id + " · " + valueText(entry.reason) }, "u" + index)),
					...(pool.filtered ?? []).map((entry, index) => jsx("div", { className: "dac-prose dac-sub", children: t("filtered") + ": " + entry.model + " · " + valueText(entry.reason) }, "f" + index))
				] }, pool.role)),
				data && data.total > 25 ? jsx(PageControls, { t, data, setOffset, loading: resource.loading }) : null
			] });
		}
		function PageControls({ t, data, setOffset, loading }) {
			return jsxs("div", { className: "dac-actions", children: [
				actionButton(t("previous"), () => setOffset(Math.max(0, data.offset - data.limit)), loading || data.offset === 0),
				jsx("span", { className: "dac-hint", children: t("historyPage", { start: String(data.total ? data.offset + 1 : 0), end: String(Math.min(data.offset + data.limit, data.total)), total: String(data.total) }) }),
				actionButton(t("next"), () => setOffset(data.nextOffset), loading || data.nextOffset === null)
			] });
		}
		// No generic per-message decoration slot exists on this host. The additive turn-tail slot
		// also renders in one-shot and embedded child Chat, where the ordinary composer is hidden.
		function InjectionPanel({ t, sessionId, turn }) {
			const [offset, setOffset] = react.useState(0);
			const start = turn.start?.time, end = turn.end?.time;
			react.useEffect(() => setOffset(0), [sessionId, turn.turn, start, end]);
			const params = new URLSearchParams({ session: sessionId, offset: String(offset), limit: "25" });
			// Filter on the server before paging so an older turn never looks empty due to another turn.
			if (turn.turn !== 1 && start !== undefined) params.set("start", String(start));
			if (end !== undefined) params.set("end", String(end));
			const resource = useResource("injections?" + params.toString(), undefined, turn.status === "open" ? 3000 : undefined);
			const entries = resource.data?.injections;
			return jsxs("details", { className: "dac-injections", children: [
				jsx("summary", { children: t("injectedTitle") }),
				jsx("div", { className: "dac-hint", children: t("injectionHint") }),
				actionButton(t("refresh"), resource.reload, resource.loading), jsx(ResourceStatus, { t, resource }),
				entries?.length === 0 ? jsx("div", { className: "dac-hint", children: t("noInjections") }) : null,
				...(entries ?? []).map((entry, index) => jsxs("div", { className: "dac-item", children: [
					jsx("span", { className: "dac-badge", children: entry.sourceLabel }),
					jsx("div", { className: "dac-sub", children: valueText(entry.messageKind) + " · " + t("chars", { n: compact(entry.chars) }) + " · " + timeText(entry.at) }),
					jsx("div", { className: "dac-sub", children: t("from") + ": " + valueText(entry.from) })
				] }, entry.contentSha256 + ":" + index)),
				resource.data && resource.data.total > 25 ? jsx(PageControls, { t, data: resource.data, setOffset, loading: resource.loading }) : null
			] });
		}
		function SchedulePanel({ t, sessionId, stats, ledger, busy, failed, updated, post, revision }) {
			const mode = ledger?.mode ?? stats.learning?.mode;
			const lastAuto = ledger?.lastAuto;
			const reverted = ledger?.lastAutoReverted === true;
			const changed = (lastAuto?.changes ?? []).filter((change) => "to" in change);
			const pending = ledger?.pending;
			const weights = ledger?.weights ?? [];
			const button = (label, onClick, primary) => jsx("button", {
				type: "button", className: "dac-btn", "data-primary": !!primary, disabled: busy, onClick, children: label
			}, label);
			return jsxs("div", { className: "dac-sched", children: [
				mode ? jsxs("div", { className: "dac-block", children: [
					jsx("div", { className: "dac-blockHead", children: t("learnMode") }),
					jsx("div", { className: "dac-seg dac-segSm", role: "radiogroup", "aria-label": t("learnMode"), children: LEARN_MODES.map((value) => jsx("button", {
						type: "button", role: "radio", "aria-checked": mode === value, disabled: busy || !ledger, className: "dac-segItem",
						onClick: () => { if (mode !== value) post({ action: "mode", mode: value }); }, children: t("learn" + cap(value))
					}, value)) }),
					LEARN_MODES.includes(mode) ? jsx("div", { className: "dac-hint", children: t("learn" + cap(mode) + "Hint") }) : null,
					stats.learning?.reason ? jsx("div", { className: "dac-hint", children: text(stats.learning.reason) }) : null
				] }) : null,
				pending ? jsxs("div", { className: "dac-block dac-pending", children: [
					jsxs("div", { className: "dac-blockHead", children: [
						t("pendingTitle", { v: String(pending.version) }),
						updated ? jsx("span", { className: "dac-badge", children: t("pendingUpdated") }) : null
					] }),
					...Object.entries(pending.items ?? {}).map(([key, item]) => jsxs("div", {
						className: "dac-item", title: item.target != null ? t("target") + " " + fixed2(item.target) : undefined, children: [
							jsx("div", { className: "dac-strong", children: keyParts(key).join(" · ") }),
							jsx("div", { children: fixed2(item.current) + " → " + fixed2(item.proposed) }),
							jsx("div", { className: "dac-hint", children: [
								item.basis != null ? t("basis") + ": " + text(item.basis) : null,
								item.uncertainty != null ? t("uncertainty", { x: fixed2(item.uncertainty) }) : null,
								Array.isArray(item.evidence) ? t("evidence", { n: String(item.evidence.length) }) : null
							].filter(Boolean).join(" · ") })
						]
					}, key)),
					jsxs("div", { className: "dac-actions", children: [
						button(t("approve"), () => post({ action: "approve", version: pending.version }), true),
						button(t("keepCurrent"), () => post({ action: "reject", version: pending.version }))
					] })
				] }) : null,
				...Object.entries(stats.choices ?? {}).map(([role, choice]) => jsxs("div", { className: "dac-block", children: [
					jsxs("div", { className: "dac-blockHead", children: [role + " ·", jsx("span", { children: choice.model ?? "–" })] }),
					jsx("div", { className: "dac-sub", children: [
						t("planVia", { via: viaLabel(t, choice.via) }), choice.tag,
						choice.confidence != null ? t("choiceConfidence") + " " + pct(choice.confidence) : null
					].filter(Boolean).join(" · ") }),
					choice.candidates?.length ? table("minmax(0,1fr) auto auto", [t("colModel"), t("colProbability"), t("colWeight")],
						choice.candidates.map((candidate) => [
							{ text: candidate.model, title: candidate.summary, className: candidate.model === choice.model ? "dac-strong" : undefined },
							pct(candidate.probability),
							{ text: weightLabel(t, candidate.weight, candidate.source, candidate.n), title: candidate.summary }
						])) : null,
					choice.filtered?.length ? jsx("div", { className: "dac-hint", children: t("filtered") + ": "
						+ choice.filtered.map((entry) => entry.model + " (" + text(entry.reason) + ")").join(", ") }) : null
				] }, role)),
				ledger ? jsxs("div", { className: "dac-block", children: [
					jsx("div", { className: "dac-blockHead", children: t("weightsTitle") }),
					weights.length ? table("auto minmax(0,1fr) auto auto minmax(100px,1fr)", [t("colTag"), t("colModel"), t("colRole"), t("colWeight"), t("userWeight")],
						weights.map((entry) => [...keyParts(entry.key), weightLabel(t, entry.weight, entry.source, entry.n),
							{ text: jsx(OverrideEditor, { t, weight: true, value: entry.user, busy,
								onSave: (value, reason) => post({ action: "user", key: entry.key, value, reason }) }, entry.key) }]))
						: jsx("div", { className: "dac-hint", children: t("noWeights") })
				] }) : null,
				lastAuto ? jsxs("div", { className: "dac-block", children: [
					jsx("div", { className: "dac-blockHead", children: t("lastAuto", { n: String(changed.length) }) }),
					...changed.map((change) => jsx("div", { className: "dac-sub",
						children: keyParts(change.key).join(" · ") + ": " + fixed2(change.from) + " → " + fixed2(change.to) }, change.key)),
					jsxs("div", { className: "dac-actions", children: [
						mode === "auto" ? button(t("pauseAuto"), () => post({ action: "mode", mode: "manual" })) : null,
						reverted ? jsx("span", { className: "dac-hint", children: t("reverted") })
							: button(t("revertLast"), () => post({ action: "revert", version: lastAuto.version }))
					] })
				] }) : null,
				failed ? jsx("div", { className: "dac-hint", children: t("actionFailed") }) : null,
				jsx(CandidatePanel, { t, sessionId }), jsx(HistoryPanel, { t, sessionId, revision, post, busy }),
				jsx("div", { className: "dac-hint", children: t("feedbackNote") })
			] });
		}
		function StatsChip({ sessionId, t }) {
			const [stats, setStats] = react.useState(null);
			const [peek, setPeek] = react.useState(false);
			const [pinned, setPinned] = react.useState(false);
			const [sched, setSched] = react.useState(false);
			const [detailsOpen, setDetailsOpen] = react.useState(false);
			const [ledger, setLedger] = react.useState(null);
			const [statsFailed, setStatsFailed] = react.useState(false), [ledgerFailed, setLedgerFailed] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [updated, setUpdated] = react.useState(false);
			const pendingRef = react.useRef(null);
			const [revision, setRevision] = react.useState(0);
			const open = peek || pinned;
			react.useEffect(() => {
				if (!sessionId) return;
				const url = new URL("./api/dsh-autoctx/stats?session=" + encodeURIComponent(sessionId), document.baseURI);
				let alive = true;
				setStats(null);
				setLedger(null); setStatsFailed(false); setLedgerFailed(false);
				const pull = () => {
					if (document.visibilityState !== "visible") return;
					fetch(url).then((response) => { if (!response.ok) throw new Error("AutoCTX stats unavailable"); return response.json(); })
						.then((body) => { if (alive) { setStats(body.stats); setStatsFailed(false); } })
						.catch(() => { if (alive) setStatsFailed(true); });
				};
				pull();
				const timer = setInterval(pull, 3000);
				return () => { alive = false; clearInterval(timer); };
			}, [sessionId]);
			// A pending card whose version changes under the user is flagged "updated" so approval needs a fresh look.
			const receive = (body, stale) => {
				if (!body?.ledger) return;
				const version = body.ledger.pending?.version ?? null;
				if (version === null) setUpdated(false);
				else if (stale || (pendingRef.current !== null && version !== pendingRef.current)) setUpdated(true);
				pendingRef.current = version;
				setLedger(body.ledger);
			};
			react.useEffect(() => {
				if (!sessionId) return;
				const url = new URL("./api/dsh-autoctx/ledger?session=" + encodeURIComponent(sessionId), document.baseURI);
				let alive = true;
				pendingRef.current = null;
				if (!open) setUpdated(false);
				const pull = () => {
					if (document.visibilityState !== "visible") return;
					fetch(url).then((response) => { if (!response.ok) throw new Error("AutoCTX ledger unavailable"); return response.json(); })
						.then((body) => { if (alive) { receive(body); setLedgerFailed(false); } })
						.catch(() => { if (alive) setLedgerFailed(true); });
				};
				pull();
				const timer = open ? setInterval(pull, 3000) : null;
				return () => { alive = false; clearInterval(timer); };
			}, [sessionId, open]);
			react.useEffect(() => {
				if (!pinned) return;
				const onKey = (event) => { if (event.key === "Escape") { setPinned(false); setPeek(false); } };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [pinned]);
			const post = async (payload) => {
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(new URL("./api/dsh-autoctx/ledger", document.baseURI), {
						method: "POST", headers: { "content-type": "application/json" },
						body: JSON.stringify({ session: sessionId, ...payload })
					});
					const body = await response.json().catch(() => null);
					if (response.status === 409 && body?.ledger) receive(body, true);
					else if (response.ok && body?.ledger && !body.error) { receive(body); setRevision((value) => value + 1); return true; }
					else setFailed(true);
					return false;
				} catch { setFailed(true); return false; }
				finally { setBusy(false); }
			};
			if (!stats) return jsxs("details", { className: "dac-sessionDetails", onToggle: (event) => setDetailsOpen(event.currentTarget.open), children: [
				jsx("summary", { className: "dac-link", children: t("title") }),
				detailsOpen ? jsxs("div", { className: "dac-card", children: [
					jsx(ResourceStatus, { t, resource: { failed: statsFailed || ledgerFailed } }),
					jsx(SchedulePanel, { t, sessionId, stats: {}, ledger, busy, failed, updated, post, revision })
				] }) : null
			] });
			const decisions = stats.maxDecisions > 0 ? Math.min(1, stats.decisions / stats.maxDecisions) : 0;
			const context = stats.pressureTokens > 0 && stats.contextTokens !== null
				? Math.min(1, stats.contextTokens / stats.pressureTokens) : 0;
			const bar = (ratio) => jsx("span", { className: "dac-bar", children: jsx("span", {
				className: "dac-barFill", "data-warn": ratio >= 0.8,
				style: { width: Math.round(ratio * 100) + "%" }
			}) }, "bar");
			const hasPending = stats.learning && !open ? stats.learning.pending != null : !!ledger?.pending;
			const toggle = () => {
				if (pinned) { setPinned(false); setPeek(false); }
				else setPinned(true);
			};
			const cost = stats.cost;
			const cache = Object.entries(stats.cache ?? {});
			const plan = stats.plan;
			const showSched = !!sessionId;
			return jsxs("div", {
				className: "dac-chip", tabIndex: 0, "aria-expanded": open,
				onMouseEnter: () => setPeek(true), onMouseLeave: () => setPeek(false),
				onFocus: () => setPeek(true),
				onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPeek(false); },
				onClick: toggle,
				onKeyDown: (event) => {
					if (event.key === "Escape") { setPinned(false); setPeek(false); }
					else if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); toggle(); }
				},
				children: [
					spark,
					ring(stats.contextTokens ?? 0, stats.pressureTokens),
					jsxs("span", { className: "dac-chipNums", children: [
						stats.decisions + "/" + stats.maxDecisions,
						stats.activeChildren > 0 ? jsxs(react.Fragment, { children: [" · ", bolt, stats.activeChildren] }) : null
					] }),
					hasPending ? jsx("span", { className: "dac-dot", title: t("pendingDot"), "aria-label": t("pendingDot") }) : null,
					open ? jsx("div", { className: "dac-pop", onClick: (event) => { event.stopPropagation(); setPinned(true); }, children: jsxs("div", { className: "dac-card", children: [
						jsx("p", { className: "dac-cardTitle", children: t("title") }),
						jsx(ResourceStatus, { t, resource: { failed: statsFailed || ledgerFailed } }),
						jsxs("div", { className: "dac-grid", children: [
							jsx("span", { className: "dac-key", children: t("statsMode") }),
							jsx("span", { children: stats.mode }),
							jsx("span", { className: "dac-key", children: t("statsDecisions") }),
							jsxs("span", { children: [
								stats.decisions + " / " + stats.maxDecisions,
								bar(decisions)
							] }),
							jsx("span", { className: "dac-key", children: t("statsSubagents") }),
							jsxs("span", { children: [
								stats.activeChildren + " " + t("statsRunning") + " · " + stats.childrenDone + " " + t("statsDone") + " · " + stats.delegations
							] }),
							jsx("span", { className: "dac-key", children: t("statsContext") }),
							jsxs("span", { children: [
								"~" + compact(stats.contextTokens) + " / " + compact(stats.pressureTokens),
								bar(context)
							] }),
							jsx("span", { className: "dac-key", children: t("statsCompactions") }),
							jsxs("span", { children: [
								stats.compactions,
								stats.tokensSaved > 0 ? " · " + t("statsSaved", { n: "~" + compact(stats.tokensSaved) }) : null,
								stats.deferrals > 0 ? " · " + t("statsDeferrals", { n: String(stats.deferrals) }) : null
							] }),
							cost ? row(t("statsCost"), [
								usd([cost.executor, cost.children, cost.jev, cost.compaction].every((value) => typeof value === "number")
									? cost.executor + cost.children + cost.jev + cost.compaction : undefined),
								jsx("div", { className: "dac-sub", children: [
									...[["costExecutor", cost.executor], ["costChildren", cost.children], ["costJev", cost.jev], ["costCompaction", cost.compaction]]
										.map(([key, value]) => t(key) + " " + usd(value)),
									stats.unpriced > 0 ? t("costUnpriced", { n: String(stats.unpriced) }) : null
								].filter(Boolean).join(" · ") }, "sub")
							]) : null,
							cache.length ? row(t("statsCache"), [
								jsx("div", { className: "dac-sub", children: t("cacheReported") }, "head"),
								...cache.map(([key, entry]) => jsx("div", { children: (key === "executor" ? t("cacheExecutor") : key) + " "
									+ pct(entry.input > 0 ? entry.cacheRead / entry.input : null) + " · " + t("cacheCalls", { n: compact(entry.calls) }) }, key))
							]) : null,
							stats.forks > 0 ? row(t("statsPrefix"), [
								t("prefixValue", { seeded: compact(stats.historySeeded), forks: String(stats.forks) }),
								jsx("div", { className: "dac-hint", children: t("prefixHint") }, "hint")
							]) : null,
							plan ? row(t("statsPlan"), [[
								plan.tag ?? t("planNoTag"),
								plan.thinking ? t("thinking_" + plan.thinking) + (plan.thinking === "decision_points" && plan.raised ? " ×" + plan.raised : "")
									: plan.effort ? t("thinkingOn", { effort: String(plan.effort) }) : t("thinkingOff"),
								plan.probabilities && plan.thinking ? t("planProb", { p: pct(plan.probabilities[plan.thinking]) }) : null,
								t("planVia", { via: viaLabel(t, plan.via) })
							].filter(Boolean).join(" · ")]) : null,
							stats.jevUnavailable != null ? jsxs(react.Fragment, { children: [
								jsx("span", { className: "dac-key", children: t("statsJevUnavailable") }),
								jsx("span", { children: t("statsJevUnavailableHint", { status: String(stats.jevUnavailable) }) })
							] }) : null,
							stats.reviews > 0 ? jsxs(react.Fragment, { children: [
								jsx("span", { className: "dac-key", children: t("statsReviews") }),
								jsx("span", { children: stats.reviews + " · " + stats.reviewsLgtm + " " + t("statsReviewsLgtm") })
							] }) : null,
							stats.lastDecision ? jsxs(react.Fragment, { children: [
								jsx("span", { className: "dac-key", children: t("statsLastRoute") }),
								jsx("span", { children: stats.lastDecision })
							] }) : null
						] }),
						showSched ? jsxs("button", { type: "button", className: "dac-expand", "aria-expanded": sched, onClick: () => setSched(!sched), children: [
							(sched ? "▾ " : "▸ ") + t("schedTitle"),
							hasPending ? jsx("span", { className: "dac-dot dac-dotInline", title: t("pendingDot") }) : null
						] }) : null,
						showSched && sched ? jsx(SchedulePanel, { t, sessionId, stats, ledger, busy, failed, updated, post, revision }) : null
					] }) }) : null
				]
			});
		}
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-autoctx: dictionaries");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = CSS;
				document.head.append(style);
				return () => style.remove();
			}, "dsh-autoctx: styles");
			// The Host serves the plugin's config under its entry key; the bare entry id is accepted too.
			ctx.effect(() => ctx.configForms.whileServed([CONFIG_KEY, "dsh-autoctx"], (served) => {
				const form = ctx.configForms.get(served.has(CONFIG_KEY) ? CONFIG_KEY : "dsh-autoctx");
				return ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "dsh-autoctx",
					order: 60,
					label: () => "DSH AutoCTX",
					locale: NS
				}, (props) => jsx(AutoSettingsSection, { ...props, form })));
			}), "dsh-autoctx: settings section");
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: CONFIG_KEY,
				locale: NS
			}, AutoConfigCard)), "dsh-autoctx: row config page");
			ctx.effect(() => ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail", id: "dsh-autoctx-injections", order: 60, locale: NS
			}, InjectionPanel)), "dsh-autoctx: injected context sources");
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-autoctx-stats",
				order: 30,
				locale: NS
			}, StatsChip)), "dsh-autoctx: composer stats chip");
		}
		return { apply, inject };
	}
});
