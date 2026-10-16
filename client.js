window.__ModuleLoader__.load({
	id: "dsh-autoctx",
	factory: (require) => {
		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");
		const en = {
			summary: "Auto routing, subagents and context compaction decided by Jev.",
			title: "Auto context",
			mode: "Mode",
			modeHint: "auto asks Jev for every decision; single keeps one agent; native keeps native compaction.",
			apiKey: "Jev API key",
			apiKeyHint: "Leave blank to keep the configured key.",
			jevModel: "Jev model",
			jevModelHint: "The model that answers the decisions.",
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
			yamlNote: "Routes, strategy and weights stay in the profile's cordis.patch.yml.",
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
			statsLastRoute: "Last route"
		};
		const zh = {
			summary: "自动路由、子代理与上下文压缩均由 Jev 决策。",
			title: "Auto 上下文",
			mode: "模式",
			modeHint: "auto 每次决策都询问 Jev；single 只用单代理；native 保持原生压缩。",
			apiKey: "Jev API Key",
			apiKeyHint: "留空表示保持当前密钥。",
			jevModel: "Jev 模型",
			jevModelHint: "回答决策的模型。",
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
			yamlNote: "路由、策略与权重仍在 profile 的 cordis.patch.yml 里维护。",
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
			statsLastRoute: "最近路由"
		};
		const NS = "plugins.dshAutoctx";
		const CONFIG_KEY = "dsh-autoctx#dsh-autoctx";
		const inject = ["slots", "locale"];
		const NUMERIC_FIELDS = ["maxDecisions", "maxChildren", "maxConcurrent", "pressureTokens", "retainTokens"];
		const specs = Object.fromEntries([
			ui.settingsTextField("mode"), ui.settingsTextField("jevModel"),
			...NUMERIC_FIELDS.map((name) => ui.settingsNumberField(name))
		].map((spec) => [spec.field, spec]));
		function AutoConfigCard({ t, view, form }) {
			if (view === "summary") return t("summary");
			return jsx(AutoConfigForm, { t, form });
		}
		function AutoConfigForm({ t, form }) {
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [keySet, setKeySet] = react.useState(false);
			react.useEffect(() => {
				fetch(new URL("./api/dsh-autoctx/stats", document.baseURI)).then((response) => response.ok ? response.json() : null)
					.then((body) => setKeySet(!!body?.apiKeyConfigured)).catch(() => {});
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
					overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t("invalid"),
					onEdit: (text) => stage(name, text),
					onReset: () => stage(name, spec.format(baseline?.base?.[name]), true)
				};
				if (name === "mode") return jsxs("div", { className: "dac-mode", children: [
					jsxs("div", { className: "dac-modeHead", children: [
						jsx("span", { className: "dac-label", children: props.label }),
						props.overridden ? jsx("button", { type: "button", className: "dac-link", disabled, onClick: props.onReset, children: props.resetLabel }) : null
					] }),
					jsx("div", { className: "dac-seg", role: "radiogroup", "aria-label": props.label, children: ["auto", "single", "native"].map((value) => jsx("button", {
						type: "button", role: "radio", "aria-checked": props.text === value, disabled,
						className: "dac-segItem", onClick: () => props.onEdit(value), children: value
					}, value)) }),
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
					section("sectionJev"),
					jsx(ui.SettingsSecretField, {
						id: "dac-apiKey", label: t("apiKey"), hint: t("apiKeyHint"), disabled,
						text: draft?.fields.apiKey?.text ?? "", configured: keySet,
						stateLabel: t(keySet ? "keySet" : "keyUnset"),
						onEdit: (text) => stage("apiKey", text)
					}),
					field("jevModel"), field("maxDecisions"),
					section("sectionSubagents"), field("maxChildren"), field("maxConcurrent"),
					section("sectionContext"), field("pressureTokens"), field("retainTokens"),
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
		const CSS = `.dac-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:20px;cursor:default;user-select:none;position:relative}
.dac-chip:hover,.dac-chip:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);outline:none}
.dac-chipNums{font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:3px}
.dac-ring{flex:none}
.dac-card{position:absolute;bottom:calc(100% + 8px);right:0;z-index:20;box-sizing:border-box;width:264px;padding:12px 14px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
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
.dac-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dac-link{font:inherit;font-size:12px;color:var(--dsw-alias-state-business-primary);background:none;border:0;padding:0;cursor:pointer}
.dac-seg{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3)}
.dac-segItem{font:inherit;font-size:12.5px;line-height:20px;min-width:72px;padding:3px 12px;border:0;border-radius:calc(var(--dsw-radius-md) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dac-segItem:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dac-segItem[aria-checked=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px var(--dsw-alias-border-l3);font-weight:500}
.dac-segItem:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dac-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`;
		function StatsChip({ sessionId, t }) {
			const [stats, setStats] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			react.useEffect(() => {
				if (!sessionId) return;
				const url = new URL("./api/dsh-autoctx/stats?session=" + encodeURIComponent(sessionId), document.baseURI);
				let alive = true;
				setStats(null);
				const pull = () => {
					if (document.visibilityState !== "visible") return;
					fetch(url).then((response) => response.ok ? response.json() : null)
						.then((body) => { if (alive) setStats(body?.stats ?? null); })
						.catch(() => {});
				};
				pull();
				const timer = setInterval(pull, 3000);
				return () => { alive = false; clearInterval(timer); };
			}, [sessionId]);
			if (!stats) return null;
			const decisions = stats.maxDecisions > 0 ? Math.min(1, stats.decisions / stats.maxDecisions) : 0;
			const context = stats.pressureTokens > 0 && stats.contextTokens !== null
				? Math.min(1, stats.contextTokens / stats.pressureTokens) : 0;
			const bar = (ratio) => jsx("span", { className: "dac-bar", children: jsx("span", {
				className: "dac-barFill", "data-warn": ratio >= 0.8,
				style: { width: Math.round(ratio * 100) + "%" }
			}) }, "bar");
			return jsxs("div", {
				className: "dac-chip", tabIndex: 0,
				onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false),
				onFocus: () => setOpen(true), onBlur: () => setOpen(false),
				onClick: () => setOpen(true),
				onKeyDown: (event) => { if (event.key === "Escape") setOpen(false); },
				children: [
					spark,
					ring(stats.contextTokens ?? 0, stats.pressureTokens),
					jsxs("span", { className: "dac-chipNums", children: [
						stats.decisions + "/" + stats.maxDecisions,
						stats.activeChildren > 0 ? jsxs(react.Fragment, { children: [" · ", bolt, stats.activeChildren] }) : null
					] }),
					open ? jsxs("div", { className: "dac-card", children: [
						jsx("p", { className: "dac-cardTitle", children: t("title") }),
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
								stats.tokensSaved > 0 ? " · " + t("statsSaved", { n: "~" + compact(stats.tokensSaved) }) : null
							] }),
							stats.lastDecision ? jsxs(react.Fragment, { children: [
								jsx("span", { className: "dac-key", children: t("statsLastRoute") }),
								jsx("span", { children: stats.lastDecision })
							] }) : null
						] })
					] }) : null
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
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: CONFIG_KEY,
				locale: NS
			}, AutoConfigCard)), "dsh-autoctx: row config page");
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
