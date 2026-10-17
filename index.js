import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import z from "@deepseek-ai/schemastery";
import { z as schema } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { validateJsonSchemaValue, ToolArgsError } from "@deepseek-ai/dsh-tools";
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import {
  scoreContext,
  budgetedSelection,
  droppedUnitLine,
  selectionBatch,
  extendTask,
  createDecisionMemo,
  STATE_BYTES,
} from "./decisions.js";
import {
  delegationQuestions,
  selectDelegation,
  validateJevAnswers,
  delegationDecline,
  DELEGATION_GUIDANCE,
} from "./routing.js";
import { newStats, applyStatsRecord } from "./stats.js";
import {
  createGraph,
  observe,
  digest,
  progressKey,
  hasRead,
  merge,
  fromJSON,
} from "./graph.js";
import {
  modelInfo,
  availableModels,
  pickModel,
  knowledge,
} from "./models.js";

export const name = "dsh-autoctx";
export const inject = [
  "llm",
  "tokenMeter",
  "sessions",
  "subagents",
  "tools",
  "agents",
  "storageDomain",
];
export const Config = z.object({
  mode: z
    .union(["auto", "single", "native"])
    .default("auto")
    .volatile()
    .description(
      "auto routes decisions through Jev, single keeps one agent, native keeps native compaction",
    ),
  apiKey: z.string().role("secret").volatile().description("Jev API key; unset runs native mode"),
  jevModel: z
    .string()
    .default("jev-1.13-free")
    .volatile()
    .description("Jev model answering the decisions"),
  jevEndpoint: z.string().default("https://opencode.ai/inference/v1/systemone"),
  routes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        model: z.string(),
        provider: z.string(),
        description: z.string(),
        efforts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  modelRoutes: z
    .dict(z.string())
    .default({})
    .description("Model id to dsh provider name for the models available to roles"),
  allowPaidModels: z
    .boolean()
    .default(false)
    .volatile()
    .description("Allow roles to use models on paid provider routes"),
  reviewerModel: z
    .string()
    .default("same")
    .volatile()
    .description('Reviewer model: "same" keeps the fork review, "auto" asks Jev, or a catalog id'),
  advisorModel: z
    .string()
    .default("off")
    .volatile()
    .description('Advisor model: "off", "auto", or a catalog id'),
  adaptiveEffort: z
    .string()
    .default("high")
    .volatile()
    .description(
      "Reasoning effort the root executor gets at decision points (turn start, test failure, review/advisor reports, stalls); off keeps its default",
    ),
  advisorMaxConsults: z
    .number()
    .step(1)
    .min(0)
    .default(1)
    .volatile()
    .description("Advisor consultations per root task"),
  advisorStallSteps: z
    .number()
    .step(1)
    .min(3)
    .default(6)
    .volatile()
    .description("Root requests without new evidence before the advisor is consulted"),
  strategy: z.object({
    mode: z.union(["automatic", "single", "native"]).default("automatic"),
    weights: z
      .object({
        quality: z.number().min(0).max(1).default(0.8),
        latency: z.number().min(0).max(1).default(0.5),
        usage: z.number().min(0).max(1).default(0.5),
        cache: z.number().min(0).max(1).default(0.8),
      })
      .default({ quality: 0.8, latency: 0.5, usage: 0.5, cache: 0.8 }),
    routeWeights: z.dict(z.any()).default({}),
  }),
  maxChildren: z
    .number()
    .step(1)
    .min(0)
    .default(2)
    .volatile()
    .description("Maximum children per root task"),
  maxConcurrent: z
    .number()
    .step(1)
    .min(1)
    .default(2)
    .volatile()
    .description("Maximum children running at once"),
  maxChildRequests: z.number().step(1).min(1).default(16),
  maxChildTurnRequests: z.number().step(1).min(2).default(8),
  reviewBeforeFinish: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      "Start one independent review child before a root turn that changed files finishes",
    ),
  reviewMaxRequests: z
    .number()
    .step(1)
    .min(1)
    .default(6)
    .volatile()
    .description("Model requests allowed for one review child"),
  maxDecisions: z
    .number()
    .step(1)
    .min(1)
    .default(12)
    .volatile()
    .description("Jev decision calls per root task"),
  pressureTokens: z
    .number()
    .min(1024)
    .default(64000)
    .volatile()
    .description("Context pressure that starts compaction decisions"),
  ceilingRatio: z
    .number()
    .min(1)
    .default(1.5)
    .volatile()
    .description(
      "Hard pressure ceiling as a multiple of pressureTokens; at or above it the session must shrink",
    ),
  retainTokens: z
    .number()
    .min(1024)
    .default(8000)
    .volatile()
    .description("Recent tokens always kept during compaction"),
  economyGuidance: z
    .boolean()
    .default(false)
    .volatile()
    .description("Append one execution-economy note before the root task's first model request"),
  keepRatio: z
    .number()
    .min(0.1)
    .max(0.8)
    .default(0.35)
    .volatile()
    .description("Share of a compacted region's tokens kept by budgeted selection"),
  nativeThresholdRatio: z.number().min(0.01).max(1).default(0.8),
  recordFile: z.string(),
});
const delegation = new Set(["subagent", "subagent_fork"]);
// The plugin's own one-shot helpers count toward concurrency and requests, not child slots.
const HELPER_LABELS = new Set(["Independent review", "Advisor"]);
// Tools whose successful result means the turn changed files on disk.
const fileChanging = new Set(["edit", "write", "apply_patch", "multi_edit"]);
const REVIEW_PROMPT =
  "Independently check the change the parent just made against the original issue. Inspect `git diff`, re-read the issue, run a minimal reproduction and the single most relevant existing test file. Never run the whole test suite; keep every command under 60 seconds; batch independent checks into one step. Do NOT edit files. Start the first line with exactly `LGTM` (then the evidence) or `DEFECTS` (then each concrete defect with evidence).";
const reviewMessage = (report) =>
  "Independent review of your change:\n" +
  report +
  "\nIf it reports a defect, fix it and verify; otherwise finish.";
const ADVISOR_PROMPT =
  "You are a senior advisor to a coding agent. Do not call tools; answer from this brief only. Give the most likely root cause, the next 2–4 concrete steps, and what evidence would confirm them, in ≤ 1200 characters.";
const advisorMessage = (model, trigger, reply) =>
  "Advisor (" + model + ", independent, no tool access) on " + trigger + ":\n" + reply +
  "\nTreat this as a hypothesis; verify it against evidence before acting.";
const syncMessage = (edits) =>
  "Collaborator changes since your last step:\n" +
  edits.map((edit) => "- " + edit.path + " edited by " + edit.label).join("\n") +
  "\nRe-read these before relying on earlier content.";
const ledgerNote = (graph) =>
  "Evidence ledger of this session (files, tests and searches you already examined; re-read only what you need):\n" +
  digest(graph, 2000);
const text = (m) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
const note = (value) =>
  createUserMessage({
    content: [{ type: "text", text: value }],
    source: { kind: "dsh-autoctx" },
  });
const ECONOMY_GUIDANCE =
  "Execution economy: every model request is budgeted. Put independent tool calls (reads, searches, listings, test runs) in the same step. Read only the needed ranges; search before opening files; do not re-read content already shown. Run the narrowest relevant tests first, and stop once the fix is verified.";
const isEconomyGuidance = (message) =>
  message?.role === "user" &&
  message.source.kind === "dsh-autoctx" &&
  text(message) === ECONOMY_GUIDANCE;
const redact = (value, secret) => (secret ? value.split(secret).join("[redacted]") : value);
const boundedEvidence = (units) => {
  const currentEvidence = [],
    recentEvidenceOutsideBudget = [];
  for (const unit of units) {
    if (Buffer.byteLength(JSON.stringify([...currentEvidence, unit])) <= 6000)
      currentEvidence.push(unit);
    else recentEvidenceOutsideBudget.push(unit.id);
  }
  return { currentEvidence, recentEvidenceOutsideBudget };
};
// The salient argument is the one a compact dropped-unit line can carry:
// the path, pattern or command a later step must not blindly repeat.
const ARGUMENT_KEYS = ["file_path", "path", "pattern", "command", "query", "url", "agent_id"];
const salientArgument = (raw) => {
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!args || typeof args !== "object") return undefined;
  for (const key of ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
  }
  return undefined;
};
// Auto needs at least one route; the session's configured native model is the safe default.
export const buildDefaultRoute = (options) => ({
  id: "default",
  label: "Default",
  model: options.model,
  provider: options.provider,
  description: "General implementation, analysis and verification with the session main model",
  efforts: [],
});

// Settings-page fields are volatile: Loader hands them over as live references.
const live = (options) =>
  new Proxy(options, {
    get: (target, key) => {
      const value = target[key];
      return value && typeof value.get === "function" && !Array.isArray(value)
        ? value.get()
        : value;
    },
  });
export function apply(ctx, options) {
  const config = live(options);
  const roots = new Map(),
    tasks = new Map(),
    budgets = new Map(),
    assignments = new Map();
  const active = new Map(),
    settled = new Map(),
    waiters = new Map(),
    prepared = new Map();
  const pressureAnchors = new Map(),
    memos = new Map();
  const declinedDelegation = new Set();
  const turnRequests = new Map(),
    turnIds = new Map(),
    routedSessions = new Set(),
    collected = new Set(),
    reports = new Map(),
    reportingChildren = new Set();
  const currentTurn = new Map(),
    turnStartSteps = new Map(),
    changedTurn = new Map(),
    reviewedTurn = new Map(),
    reviewChildren = new Set(),
    reviewPending = new Set();
  // One evidence graph per live session, restored from storage on the first request.
  const graphs = new Map(),
    graphSteps = new Map(),
    loadedGraphs = new Set(),
    pendingLedgers = new Set(),
    syncCursors = new Map(),
    editLogs = new Map(),
    advisorState = new Map(),
    advisorChildren = new Set(),
    advisorPending = new Set(),
    chosenModels = new Map(),
    // Adaptive executor effort: why the root's next execution request should think (session -> reason).
    effortDue = new Map(),
    effortSupported = new Map(),
    effortStall = new Map(),
    // agent/request runs with the agent's scoped context as `this`; map it (and its scope key) to the root session.
    rootByScope = new Map(),
    modelKnowledge = new Map(),
    availableByRoot = new Map(),
    providersByRoot = new Map();
  const childLabels = new Map();
  const graphFor = (id) => {
    if (!graphs.has(id)) graphs.set(id, createGraph());
    return graphs.get(id);
  };
  const graphStep = (id) => graphSteps.get(id) ?? 0;
  const rootGraph = (agent) => graphFor(rootOf(agent));
  const editLog = (root) => {
    if (!editLogs.has(root)) editLogs.set(root, []);
    return editLogs.get(root);
  };
  const noteEdits = (root, id, label, since) => {
    const log = editLog(root);
    for (const [path, file] of Object.entries(graphFor(id).files))
      for (const edit of file.edits)
        if (edit.via === undefined && edit.event > since)
          log.push({ session: id, label, path, step: edit.step, seq: log.length + 1 });
  };
  const persistGraph = async (id) => {
    if (!graphs.has(id)) return;
    try {
      await (await storage()).table("graphs").put(id, { ...graphs.get(id), requests: graphStep(id) });
    } catch (error) {
      record({ kind: "graph_save_failed", session: id, error: String(error) });
    }
  };
  const restoreGraph = async (id) => {
    if (loadedGraphs.has(id)) return;
    loadedGraphs.add(id);
    try {
      const saved = (await storage()).table("graphs").get(id);
      const empty = !graphs.has(id) || graphs.get(id).sequence === 0;
      if (saved !== undefined && empty) {
        const graph = fromJSON(saved);
        graphs.set(id, graph);
        if (Number.isInteger(saved?.requests) && saved.requests >= 0)
          graphSteps.set(id, saved.requests);
      }
    } catch (error) {
      loadedGraphs.delete(id);
      record({ kind: "graph_restore_failed", session: id, error: String(error) });
    }
  };
  const rootOf = (agent) => agent.session.header.parentSession ?? agent.session.id;
  const budget = (id) => {
    if (!budgets.has(id))
      budgets.set(id, {
        children: new Set(),
        helpers: new Set(),
        pending: new Set(),
        childRequests: 0,
        decisions: 0,
      });
    return budgets.get(id);
  };
  const record = (value) => {
    if (config.recordFile)
      fs.appendFileSync(
        config.recordFile,
        JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n",
        { mode: 0o600 },
      );
    applyStats(value);
  };
  const statsMap = new Map();
  const statsRoot = (id) => ctx.agents.get(id)?.session.header.parentSession ?? id;
  const updateStats = (id, value = {}) => {
    const current =
      statsMap.get(id) ??
      newStats(config.apiKey ? config.mode : "native", config.maxDecisions, config.pressureTokens);
    statsMap.delete(id);
    statsMap.set(id, {
      ...applyStatsRecord(current, value, budgets.get(id)?.decisions ?? 0),
      maxDecisions: config.maxDecisions,
      pressureTokens: config.pressureTokens,
      updatedAt: Date.now(),
    });
    if (statsMap.size > 200) statsMap.delete(statsMap.keys().next().value);
  };
  const applyStats = (value) => {
    const session = value.root ?? value.parent ?? value.session;
    if (
      !session ||
      ![
        "policy_snapshot",
        "jev",
        "delegation_decision",
        "child_start",
        "child_end",
        "context_pressure",
        "context_scores",
        "context_kept",
        "context_replaced",
        "review_start",
        "review_end",
        "review_failed",
        "advisor_end",
        "sync_note",
        "ledger_note",
        "model_choice",
      ].includes(value.kind)
    )
      return;
    const id = statsRoot(session);
    updateStats(id, value);
  };
  ctx.inject(["connection"], (c) => {
    c.effect(
      () =>
        c.connection.fetch.register({
          path: "/api/dsh-autoctx/stats",
          methods: ["GET"],
          requestBody: "buffered",
          fetch: (request) => {
            const entry = statsMap.get(
              statsRoot(new URL(request.url).searchParams.get("session") ?? ""),
            );
            const { pendingSaved, ...stats } = entry ?? {};
            return new Response(
              JSON.stringify({ stats: entry ? stats : null, apiKeyConfigured: !!config.apiKey }),
              { headers: { "content-type": "application/json", "cache-control": "no-store" } },
            );
          },
        }),
      "dsh-autoctx: stats route",
    );
  });
  ctx.on("dispose", () => {
    statsMap.clear();
    memos.clear();
  });
  const modeOf = (agent) =>
    !config.apiKey
      ? "native"
      : config.mode === "auto"
        ? roots.get(rootOf(agent))?.mode
        : config.mode;
  let storePromise;
  const storage = () =>
    (storePromise ??= ctx.storageDomain.open(
      defineDomain({
        name: "dsh_auto",
        version: 1,
        layout: "per-record",
        tables: {
          policies: domainTable(schema.json()),
          assignments: domainTable(schema.json()),
          graphs: domainTable(schema.json()),
        },
      }),
    ));
  ctx.on("dispose", async () => {
    if (storePromise) await (await storePromise).close();
  });

  const memoFor = (root) => {
    if (!memos.has(root)) memos.set(root, createDecisionMemo());
    return memos.get(root);
  };
  async function decide(agent, request, signal) {
    const root = rootOf(agent),
      state = budget(root);
    const { questions, ...decisionState } = request;
    const body = JSON.stringify({
      model: config.jevModel,
      state: JSON.stringify(decisionState),
      questions,
    });
    const key = createHash("sha256").update(body).digest("hex");
    return memoFor(root)(key, async () => {
      if (state.decisions >= config.maxDecisions)
        throw new Error("Jev task decision budget exhausted.");
      state.decisions++;
      updateStats(root);
      const started = performance.now();
      const response = await fetch(config.jevEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body,
        signal,
      });
      const bodyText = redact(await response.text(), config.apiKey);
      if (!response.ok)
        throw new Error(`Jev decision failed (HTTP ${response.status}): ${bodyText}`);
      let result;
      try {
        result = JSON.parse(bodyText);
      } catch {
        throw new Error(
          `Jev decision returned invalid JSON (HTTP ${response.status}): ${bodyText}`,
        );
      }
      const problem = validateJevAnswers(request.questions, result?.answers);
      if (problem)
        throw new Error(
          `Jev decision returned an invalid answer (HTTP ${response.status}): ${problem}. ${bodyText}`,
        );
      record({
        kind: "jev",
        session: agent.session.id,
        trigger: request.trigger,
        httpStatus: response.status,
        wallMs: performance.now() - started,
        ...result,
      });
      return result;
    });
  }

  const providerOf = (agent, id) =>
    providersByRoot.get(rootOf(agent))?.[id];

  // Native preparation proves a configured model route exists before a role can use it.
  async function ensureAvailable(agent, signal) {
    const root = rootOf(agent);
    if (availableByRoot.has(root)) return availableByRoot.get(root);
    const executor = agent.options?.model;
    const routes = {
      ...(config.modelRoutes ?? {}),
      ...(executor ? { [executor]: agent.options.provider } : {}),
    };
    const available = [];
    for (const entry of availableModels(routes, { allowPaid: config.allowPaidModels === true })) {
      try {
        await ctx.llm.prepareCall({ provider: routes[entry.id], model: entry.id }, signal);
        available.push(entry);
      } catch (error) {
        if (signal.aborted) throw error;
        record({
          kind: "profile_unavailable",
          session: root,
          profile: entry.id,
          error: String(error),
        });
      }
    }
    availableByRoot.set(root, available);
    providersByRoot.set(root, routes);
    if (available.length) modelKnowledge.set(root, knowledge(available));
    return available;
  }

  async function initialize(agent, signal) {
    const id = agent.session.id;
    const configuredMode = config.apiKey ? config.mode : "native";
    await ensureAvailable(agent, signal);
    if (config.adaptiveEffort && config.adaptiveEffort !== "off" && agent.options?.model) {
      try {
        await ctx.llm.prepareCall(
          { provider: agent.options.provider, model: agent.options.model, reasoningEffort: config.adaptiveEffort },
          signal,
        );
        effortSupported.set(id, true);
      } catch (error) {
        if (signal.aborted) throw error;
        effortSupported.set(id, false);
        record({ kind: "effort_unavailable", session: id, effort: config.adaptiveEffort, error: String(error) });
      }
    }
    if (!config.apiKey || config.mode !== "auto") {
      const state = { configuredMode, mode: configuredMode, profiles: [] };
      roots.set(id, state);
      record({
        kind: "policy_snapshot",
        session: id,
        mode: state.mode,
        ...(config.apiKey ? {} : { reason: "no-api-key" }),
      });
      return state;
    }
    const policies = (await storage()).table("policies");
    let snapshot = policies.get(id);
    if (!snapshot) {
      snapshot = {
        routes: config.routes,
        strategy: config.strategy ?? {
          mode: "automatic",
          weights: { quality: 0.8, latency: 0.5, usage: 0.5, cache: 0.8 },
        },
      };
      await policies.put(id, snapshot);
    }
    const policy = snapshot.strategy;
    if (policy) {
      if (!["automatic", "single", "native"].includes(policy.mode))
        throw new Error("Unsupported compiled execution policy.");
      for (const key of ["quality", "latency", "usage", "cache"])
        if (!Number.isFinite(policy.weights?.[key]))
          throw new Error("Missing compiled strategy weight: " + key);
    }
    const state = {
      configuredMode,
      policy,
      mode: policy?.mode === "single" ? "single" : policy?.mode === "native" ? "native" : "auto",
      profiles: [],
      instruction: snapshot.instruction,
    };
    if (state.mode !== "auto") {
      roots.set(id, state);
      record({ kind: "policy_snapshot", session: id, mode: state.mode, policy });
      return state;
    }
    // The generated default route is never persisted, so it always follows the session's current model.
    for (const route of snapshot.routes.length
      ? snapshot.routes
      : [buildDefaultRoute(agent.options)]) {
      // Native preparation validates actual client-side routes and supported effort names.
      // An omitted/empty effort list explicitly requests the native default.
      const efforts = route.efforts ?? [];
      const provider = route.provider ?? agent.options.provider;
      for (const effort of efforts.length ? efforts : [undefined]) {
        const options = {
          provider,
          model: route.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
        try {
          await ctx.llm.prepareCall(options, signal);
          const info = modelInfo(route.model);
          state.profiles.push({
            id: route.id + "/" + (effort ?? "default"),
            routeId: route.id,
            label: route.label,
            capability: route.description,
            options,
            ...(info ? { knowledge: knowledge([info]) } : {}),
          });
        } catch (error) {
          if (signal.aborted) throw error;
          record({
            kind: "profile_unavailable",
            session: id,
            profile: route.id,
            effort: effort ?? null,
            error: String(error),
          });
        }
      }
    }
    if (!state.profiles.length)
      throw new Error(
        "No configured Auto execution profile is supported by this native dsh connection.",
      );
    roots.set(id, state);
    record({
      kind: "policy_snapshot",
      session: id,
      mode: state.mode,
      policy: state.policy,
      profiles: state.profiles,
    });
    return state;
  }

  ctx.tools.guard((exec) => {
    if (!delegation.has(exec.name)) return;
    const mode = exec.agent ? modeOf(exec.agent) : config.mode;
    if (mode === "single") return "This task permits one main agent only.";
    if (!exec.agent) return "Delegation requires a native dsh agent.";
    if (mode === "auto" && declinedDelegation.has(exec.agent.session.id))
      return "Jev already declined delegation with the current evidence. No child was created. Continue the work in the main agent; do not retry by rewording the proposal. Reconsider only after a new observation or user/child message.";
    if (exec.agent.session.header.parentSession !== undefined)
      return "Nested delegation exceeds this task depth limit.";
    const state = budget(rootOf(exec.agent));
    const running = [...active.values()].filter((x) => x.parent === rootOf(exec.agent)).length;
    if (
      state.pending.size + running >= config.maxConcurrent ||
      state.children.size + state.pending.size >= config.maxChildren
    )
      return "Task subagent resource limit reached.";
    if (state.childRequests >= config.maxChildRequests)
      return "Task child request budget reached; complete the remaining work in the main agent.";
    state.pending.add(exec.callId);
  });
  ctx.on("tools/result", (exec, result) => {
    if (exec.agent && !delegation.has(exec.name) && !result.isError)
      declinedDelegation.delete(exec.agent.session.id);
    const changesFiles =
      fileChanging.has(exec.name) ||
      (exec.name === "str_replace_editor" &&
        ["create", "str_replace", "insert"].includes(exec.arguments?.command));
    if (exec.agent && changesFiles && !result.isError) {
      const session = exec.agent.session.id;
      changedTurn.set(session, currentTurn.get(session));
    }
    if (exec.agent) {
      const id = exec.agent.session.id,
        root = rootOf(exec.agent);
      const step = graphStep(id),
        since = graphFor(id).sequence;
      observe(
        graphFor(id),
        step,
        { name: exec.name, arguments: exec.arguments },
        {
          isError: result.isError,
          text: (result.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        },
      );
      noteEdits(root, id, id === root ? "parent" : childLabels.get(id) ?? id, since);
      if (id === root) {
        // A failing test run is where a flash executor most often misdiagnoses; think on the next step.
        const latest = Object.values(graphFor(id).tests)
          .flatMap((test) => test.runs)
          .filter((run) => run.via === undefined && run.event > since)
          .at(-1);
        if (latest && (latest.outcome === "fail" || latest.outcome === "error"))
          wantEffort(exec.agent, "test_failure");
      }
    }
    if (!delegation.has(exec.name) || !exec.agent) return;
    budget(rootOf(exec.agent)).pending.delete(exec.callId);
    record({
      kind: "native_child_tool_result",
      parent: exec.agent.session.id,
      callId: exec.callId,
      tool: exec.name,
      isError: result.isError,
      value: result.value,
      error: result.error,
    });
  });
  ctx.on("subagent/start", (info) => {
    const child = ctx.agents.get(info.id);
    if (!child) throw new Error("Auto requires native in-process children.");
    const parent = rootOf(child),
      state = budget(parent),
      advisor = advisorPending.has(parent);
    if (advisor || reviewPending.has(parent)) state.helpers.add(info.id);
    else state.children.add(info.id);
    active.set(info.id, { parent, runId: info.runId });
    if (advisor) advisorChildren.add(info.id);
    const assignment = assignments.get(info.id);
    if (assignment?.callId) state.pending.delete(assignment.callId);
    record({
      kind: "child_start",
      ...info,
      parent,
      active: [...active.values()].filter((x) => x.parent === parent).length,
    });
  });
  ctx.on("subagent/end", async (info) => {
    const running = active.get(info.id);
    if (!running) throw new Error("Native child ended without a start.");
    active.delete(info.id);
    advisorChildren.delete(info.id);
    settled.set(info.id, info);
    record({
      kind: "child_end",
      ...info,
      parent: running.parent,
      active: [...active.values()].filter((x) => x.parent === running.parent).length,
    });
    for (const done of waiters.get(info.id) ?? []) done(info);
    waiters.delete(info.id);
    await persistGraph(info.id);
  });
  function awaitSettlement(id, previous, signal) {
    const current = settled.get(id);
    if (current && current.runId !== previous) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const done = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        waiters.get(id)?.delete(done);
        reject(signal.reason);
      };
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(done);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  // Effort is a request parameter, not prompt text, so raising it for one step keeps the cached prefix.
  function wantEffort(agent, reason) {
    if (!config.adaptiveEffort || config.adaptiveEffort === "off") return;
    if (agent.session.header.parentSession !== undefined) return;
    // The first turn's trigger fires before the root is initialized; use the configured mode then.
    if ((roots.has(agent.session.id) ? modeOf(agent) : config.apiKey ? config.mode : "native") !== "auto") return;
    if (!effortDue.has(agent.session.id)) effortDue.set(agent.session.id, reason);
  }

  // Helpers share the task's concurrency and request budgets.
  function rootHasChildSlot(id) {
    const state = budget(id);
    const running = [...active.values()].filter((x) => x.parent === id).length;
    return (
      state.pending.size + running < config.maxConcurrent &&
      state.children.size + state.pending.size < config.maxChildren &&
      state.childRequests < config.maxChildRequests
    );
  }

  // Explicit ids are honored only when native preparation accepted them; "auto"
  // spends one Jev question, then falls back to local price/role ranking.
  async function chooseModel(role, agent, reason, signal) {
    const root = rootOf(agent),
      setting = role === "reviewer" ? config.reviewerModel : config.advisorModel;
    const available = await ensureAvailable(agent, signal);
    const found = (id) => available.find((entry) => entry.id === id);
    const finish = (model, via) => {
      if (model && setting === "auto") chosenModels.set(root + "\u0000" + role, model.id);
      record({
        kind: "model_choice",
        session: root,
        role,
        ...(model ? { model: model.id } : {}),
        via,
      });
      return model;
    };
    if (setting && setting !== "same" && setting !== "auto" && setting !== "off") {
      const entry = found(setting) ?? found(modelInfo(setting)?.id);
      if (!entry) {
        record({ kind: "model_unavailable", session: root, role, model: setting });
        return undefined;
      }
      return finish(entry, "config");
    }
    // One Jev choice per role per root task: the catalog and the task do not change between consults.
    const memo = chosenModels.get(root + "\u0000" + role);
    if (setting === "auto" && memo && found(memo)) return found(memo);
    if (setting === "auto" && budget(root).decisions < config.maxDecisions) {
      const candidates = available
        .filter((entry) => entry.roles.includes(role))
        .slice(0, 4);
      if (candidates.length) {
        const criteria = Object.fromEntries(candidates.map((entry) => [entry.id, knowledge([entry])]));
        const models = modelKnowledge.get(root);
        const request = {
          ...(models ? { models } : {}),
          task: tasks.get(root),
          ledger: digest(rootGraph(agent), 1500),
          trigger: role + ": " + reason,
          questions: {
            model: {
              type: "choice",
              instructions:
                "Which model should act as " + role + " now? Weigh measured strengths, family independence from the executor, and price.",
              criteria,
            },
          },
        };
        try {
          if (Buffer.byteLength(JSON.stringify(request)) <= STATE_BYTES) {
            const decision = await decide(agent, request, signal);
            const answer = decision.answers?.model;
            const chosen = criteria[answer?.choice] ? found(answer.choice) : undefined;
            if (chosen && answer.confidence >= 0.4) return finish(chosen, "jev");
          }
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
    }
    return finish(pickModel(role, { executor: agent.options?.model, available }), "fallback");
  }

  async function independentReview(agent, turn, signal) {
    const id = agent.session.id,
      start = turnStartSteps.get(id),
      changed =
        changedTurn.get(id) === turn ||
        (start?.turn === turn && Object.values(graphFor(id).files).some((file) =>
          file.edits.some((edit) => edit.via === undefined && edit.step > start.step)));
    if (reviewedTurn.get(id) === turn || !changed) return;
    if (!rootHasChildSlot(id)) return;
    // Marked before starting, so a failed review never repeats within the turn.
    reviewedTurn.set(id, turn);
    const custom = config.reviewerModel !== undefined && config.reviewerModel !== "same";
    const reviewer = custom ? await chooseModel("reviewer", agent, "independent review", signal) : undefined;
    let run;
    record({
      kind: "review_start",
      session: id,
      turn,
      model: reviewer?.id ?? "same",
    });
    try {
      signal.throwIfAborted();
      const cross = !!reviewer;
      const provider = cross
        ? "spawn"
        : ctx.subagents.getProvider("fork") !== undefined
          ? "fork"
          : "spawn";
      // A spawn child does not share the parent's cache, so the brief carries the ledger.
      const prompt = cross
        ? REVIEW_PROMPT +
          "\n\nOriginal issue:\n" + tasks.get(id) +
          "\n\nParent evidence ledger:\n" + digest(rootGraph(agent), 3000)
        : REVIEW_PROMPT + "\n\nOriginal issue:\n" + tasks.get(id);
      reviewPending.add(id);
      run = await ctx.subagents.start(provider, {
        label: "Independent review",
        parent: agent,
        prompt: [{ type: "text", text: prompt }],
        ...(cross ? { agentOptions: { provider: providerOf(agent, reviewer.id), model: reviewer.id } } : {}),
        toolFilter: { deny: ["subagent", "subagent_fork"] },
        maxDepth: 1,
        signal,
      });
      reviewPending.delete(id);
      reviewChildren.add(run.id);
      childLabels.set(run.id, "Independent review");
      let outcome;
      try {
        outcome = await run.result;
      } finally {
        await run.dispose();
      }
      signal.throwIfAborted();
      if (outcome.stopReason !== "completed")
        throw new Error(
          "Review child ended with " + outcome.stopReason +
          (outcome.diagnostic ? ": " + outcome.diagnostic : "."),
        );
      const report = outcome.output
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!report) throw new Error("Review child returned no report.");
      record({
        kind: "review_end",
        session: id,
        turn,
        childId: run.id,
        model: reviewer?.id ?? "same",
        stopReason: outcome.stopReason,
        lgtm: /^[\W_]*LGTM\b/i.test(report),
      });
      agent.steer(note(reviewMessage(report)));
      wantEffort(agent, "review_report");
    } catch (error) {
      signal.throwIfAborted();
      record({ kind: "review_failed", session: id, turn, childId: run?.id, error: String(error) });
    } finally {
      if (!run) reviewPending.delete(id);
      if (run) reviewChildren.delete(run.id);
    }
  }

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const saved = persistGraph(agent.session.id);
    try {
      // Auto and native share the reviewer; single mode and keyless runs stay native-only.
      if (!config.reviewBeforeFinish || !config.apiKey) return;
      if (agent.session.header.parentSession !== undefined) return;
      if (modeOf(agent) === "single") return;
      await independentReview(agent, turn, signal);
    } finally {
      await saved;
    }
  });

  async function routeDelegation(args, exec, provider) {
    const parent = exec.agent,
      state = roots.get(parent.session.id),
      resources = budget(parent.session.id);
    const listing = await ctx.subagents.listChildren(parent.session.id, exec.signal);
    const persistedAssignments = (await storage()).table("assignments");
    const knownChildren = listing
      .filter((x) => x.kind === "child")
      .map((child) => {
        const assignment = assignments.get(child.id) ?? persistedAssignments.get(child.id);
        const outcome = settled.get(child.id);
        return {
          ...child,
          ...(assignment
            ? { assignment: assignment.proposal, profile: assignment.profile.id }
            : {}),
          ...(outcome
            ? { stopReason: outcome.stopReason, lastAssistantMessage: outcome.lastAssistantMessage }
            : {}),
        };
      });
    for (const child of knownChildren) {
      if (HELPER_LABELS.has(child.label)) {
        resources.children.delete(child.id);
        resources.helpers.add(child.id);
      } else resources.children.add(child.id);
    }
    const usedChildren =
      resources.children.size +
      resources.pending.size -
      (resources.pending.has(exec.callId) ? 1 : 0);
    const children = knownChildren.filter((x) => x.mode === "continuable" && !active.has(x.id));
    const canCreate = usedChildren < config.maxChildren;
    const decline = delegationDecline({
      canCreate,
      decisions: config.maxDecisions - resources.decisions,
    });
    if (decline) {
      declinedDelegation.add(parent.session.id);
      record({
        kind: "delegation_decision",
        session: parent.session.id,
        callId: exec.callId,
        action: "main",
        reason: decline,
        local: true,
      });
      throw new Error(
        "Jev declined delegation: " +
          decline +
          " No child was created. Complete the work in the main agent; do not retry by rewording the proposal.",
      );
    }
    const recent = [...parent.session.surface.nodes]
      .slice(-4)
      .flatMap((seq) => {
        const message = parent.session.deriveEventMessage(parent.session.eventAt(seq));
        // A requested tool call is an intention, not evidence of completed or assigned work.
        return message
          ? message.content
              .filter((block) => block.type !== "reasoning" && block.type !== "tool-call")
              .map((block, i) => ({
                id: "event_" + seq + "_evidence_" + i,
                kind: message.role + "/" + block.type,
                text: JSON.stringify(block),
              }))
          : [];
      })
      .slice(-3);
    // Model knowledge leads every Jev state and stays identical for the whole root task.
    const models = modelKnowledge.get(rootOf(parent)) ?? "";
    const request = {
      ...(models ? { models } : {}),
      instructions: DELEGATION_GUIDANCE,
      routes: state.profiles,
      task: tasks.get(parent.session.id),
      trigger: "delegation",
      history: [],
      observation: {
        proposal: args.prompt,
        proposalStatus: "Pending approval; this call has not created or assigned a child.",
        description: args.description,
        children: knownChildren,
        ...boundedEvidence(recent),
        childRequestsRemaining: config.maxChildRequests - resources.childRequests,
        childrenRemaining: Math.max(0, config.maxChildren - usedChildren),
      },
      questions: delegationQuestions(state.profiles, children),
    };
    const { questions, ...decisionState } = request;
    if (Buffer.byteLength(JSON.stringify(decisionState)) > STATE_BYTES)
      throw new Error(
        "The complete delegation state exceeds the Jev budget; narrow the proposed subtask or continue in the parent. No source was truncated.",
      );
    // Reserve any free slot across the asynchronous decision so parallel
    // proposals cannot overshoot maxChildren; release it again when no child starts.
    const reserved = "session-" + randomUUID();
    resources.pending.add(exec.callId);
    let id,
      previous,
      started = false;
    try {
      const decision = await decide(parent, request, exec.signal);
      exec.signal.throwIfAborted();
      const selected = selectDelegation(decision.answers, state.profiles, children, state.policy, {
        canCreate,
      });
      record({
        kind: "delegation_decision",
        session: parent.session.id,
        callId: exec.callId,
        ...selected,
      });
      if (selected.action === "main") {
        declinedDelegation.add(parent.session.id);
        throw new Error(
          "Jev declined delegation: " +
            selected.reason +
            " No child was created. Complete the work in the main agent; do not retry by rewording the proposal.",
        );
      }
      if (selected.action === "reuse") {
        resources.pending.delete(exec.callId);
        id = selected.child.id;
        previous = settled.get(id)?.runId;
        const messageId = await ctx.subagents.sendMessage(
          parent,
          id,
          [{ type: "text", text: args.prompt }],
          { signal: exec.signal },
        );
        record({ kind: "child_reused", parent: parent.session.id, id, messageId });
      } else {
        id = reserved;
        const task =
          "Your assigned subtask:\n" +
          args.prompt +
          "\n\nRoot request as background and constraints (instructions to the parent or other agents are NOT your assignment):\n" +
          JSON.stringify(tasks.get(parent.session.id));
        assignments.set(id, {
          task,
          proposal: args.prompt,
          profile: selected.profile,
          callId: exec.callId,
        });
        await persistedAssignments.put(id, assignments.get(id));
        const chosen =
          provider === "spawn" && ctx.subagents.getProvider("fork") !== undefined
            ? "fork"
            : provider;
        childLabels.set(id, args.description);
        await ctx.subagents.startContinuable({
          childId: id,
          provider: chosen,
          label: args.description,
          request: {
            parent,
            prompt: [
              {
                type: "text",
                text:
                  task +
                  "\n\nInvestigate only the assigned responsibility. Return concrete findings and evidence within the child budget. Leave code edits and test fixes to the parent.",
              },
            ],
            agentOptions: selected.profile.options,
            persona:
              "You are a delegated child, not the parent. Perform only your assigned investigation. The quoted root request is background; do not carry out its instructions for other agents. Do not delegate. " +
              selected.profile.label +
              ": " +
              selected.profile.capability,
            toolFilter: { deny: ["subagent", "subagent_fork"] },
            maxDepth: 1,
          },
          signal: exec.signal,
        });
        started = true;
      }
    } finally {
      if (!started) {
        resources.pending.delete(exec.callId);
        if (assignments.delete(reserved)) await persistedAssignments.delete(reserved);
      }
    }
    if (args.run_in_background !== false) return { kind: "continuable", subagentId: id };
    const outcome = await awaitSettlement(id, previous, exec.signal);
    recordCollection(parent.session.id, id, outcome);
    if (outcome.stopReason !== "completed")
      throw new Error(
        "Native child " +
          id +
          " ended with " +
          JSON.stringify(outcome.stopReason) +
          ". Its durable history and partial output remain available.",
      );
    if (reports.has(outcome.runId))
      return {
        kind: "foreground",
        runId: outcome.runId,
        output: [{ type: "text", text: reports.get(outcome.runId) }],
      };
    if (!Array.isArray(outcome.lastAssistantMessage) || !outcome.lastAssistantMessage.length)
      throw new Error("Native child completed without a final output to collect.");
    return { kind: "foreground", runId: outcome.runId, output: outcome.lastAssistantMessage };
  }

  function recordCollection(parent, id, outcome) {
    if (outcome && collected.has(outcome.runId)) return;
    if (outcome) collected.add(outcome.runId);
    record({
      kind: "child_collected",
      parent,
      id,
      runId: outcome?.runId,
      stopReason: outcome?.stopReason,
    });
  }

  function installRouting(agent) {
    if (routedSessions.has(agent.session.id)) return;
    for (const name of delegation) {
      if (!ctx.tools.get(name, agent))
        throw new Error("Required native delegation tool is unavailable: " + name);
    }
    routedSessions.add(agent.session.id);
  }

  function installChildReporting(agent) {
    if (reportingChildren.has(agent.session.id)) return;
    if (!ctx.tools.get("send_message", agent))
      throw new Error("Native child reporting requires send_message.");
    reportingChildren.add(agent.session.id);
  }

  ctx.on("tools/execute", async (exec, next) => {
    const agent = exec.agent,
      session = agent?.session.id;
    if (routedSessions.has(session) && modeOf(agent) === "auto") {
      if (delegation.has(exec.name)) {
        try {
          const violations = validateJsonSchemaValue(
            ctx.tools.get(exec.name, agent).parameters,
            exec.arguments,
            "",
          );
          if (violations.length) throw new ToolArgsError(violations);
          const value = await routeDelegation(
            exec.arguments,
            exec,
            exec.name === "subagent" ? "spawn" : "fork",
          );
          const content =
            value.kind === "foreground"
              ? value.output.filter((block) => block.type === "text" || block.type === "image")
              : [
                  {
                    type: "text",
                    text: `Started subagent ${value.subagentId} in the background; its result arrives as a message.`,
                  },
                ];
          return { isError: false, value, content };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, error: { message }, content: [{ type: "text", text: message }] };
        }
      }
      if (exec.name === "send_message") {
        const result = await next();
        if (result.isError)
          record({ kind: "native_message_error", session, causes: [result.error.message] });
        return result;
      }
    }
    if (exec.name === "send_message" && reportingChildren.has(session)) {
      let result = await next();
      const args = exec.arguments;
      if (
        !result.isError &&
        args.agent_id === rootOf(agent) &&
        ((turnRequests.get(session) ?? 0) >= config.maxChildTurnRequests ||
          budget(rootOf(agent)).childRequests >= config.maxChildRequests)
      ) {
        const run = active.get(session);
        if (run) reports.set(run.runId, args.message);
        result = { ...result, concludesTurn: true };
        record({ kind: "child_budget_report", session, runId: run?.runId });
      }
      return result;
    }
    return next();
  });

  class JevCompaction extends BasicCompactionEngine {
    async summarize(input, agent, signal) {
      const selection = prepared.get(agent.session.id);
      return selection
        ? { summary: selection.summary, provider: "opencode-console", model: selection.model }
        : super.summarize(input, agent, signal);
    }
  }
  const createCompactor = () =>
    new JevCompaction(ctx, {
      auto: false,
      thresholdRatio: config.nativeThresholdRatio,
      retainTokens: config.retainTokens,
      compactionRetries: 0,
      maxOverflowRetries: 0,
    });
  // Built on first use (one Service for the plugin's life); a saved retainTokens is applied in place.
  let compactor;
  const getCompactor = () => {
    compactor ??= createCompactor();
    if (compactor.config.retainTokens !== config.retainTokens)
      compactor.config = { ...compactor.config, retainTokens: config.retainTokens };
    return compactor;
  };

  const advisorFor = (root) => {
    if (!advisorState.has(root))
      advisorState.set(root, { key: undefined, consults: 0, stallDone: false, failures: new Set() });
    return advisorState.get(root);
  };
  const repeatedFailure = (graph, handled) => {
    for (const [key, test] of Object.entries(graph.tests)) {
      if (handled.has(key)) continue;
      const runs = test.runs.filter((run) => run.via === undefined);
      const latest = runs.at(-1);
      if (!latest || (latest.outcome !== "fail" && latest.outcome !== "error")) continue;
      const failing = runs.slice(0, -1).filter(
        (run) => run.outcome === "fail" || run.outcome === "error",
      );
      // Advice is worth a call only after the agent's own fix attempts keep failing:
      // at least two earlier failures, each followed by an edit before the next run.
      const edits = Object.values(graph.files).flatMap((file) =>
        file.edits.filter((edit) => edit.via === undefined).map((edit) => edit.event));
      const attempts = failing.filter((run, i) => {
        const next = (failing[i + 1] ?? latest).event;
        return edits.some((event) => event > run.event && event < next);
      });
      if (attempts.length >= 2) return key;
    }
    return undefined;
  };
  const takeSync = (agent) => {
    const id = agent.session.id,
      graph = graphFor(id),
      log = editLog(rootOf(agent));
    let cursor = syncCursors.get(id) ?? 0;
    const paths = new Map();
    for (const edit of log) {
      if (edit.seq <= cursor) continue;
      if (edit.session !== id && hasRead(graph, edit.path)) {
        if (!paths.has(edit.path) && paths.size === 6) break;
        paths.set(edit.path, edit);
      }
      cursor = edit.seq;
    }
    syncCursors.set(id, cursor);
    const changes = [...paths.values()];
    if (!changes.length) return undefined;
    record({ kind: "sync_note", session: id, paths: changes.map((edit) => edit.path) });
    return syncMessage(changes);
  };
  async function consultAdvisor(agent, trigger, signal) {
    const id = agent.session.id;
    if (config.advisorModel === "off" || modeOf(agent) !== "auto") return undefined;
    if (agent.session.header.parentSession !== undefined) return undefined;
    const state = advisorFor(id);
    if (state.consults >= (config.advisorMaxConsults ?? 2) || !rootHasChildSlot(id))
      return undefined;
    const model = await chooseModel("advisor", agent, trigger, signal);
    if (!model || !rootHasChildSlot(id)) return undefined;
    state.consults++;
    state.since = graphStep(id);
    if (trigger === "stall") state.stallDone = true;
    else state.failures.add(trigger.slice("repeated failure: ".length));
    record({ kind: "advisor_start", session: id, trigger, model: model.id });
    let run;
    try {
      signal.throwIfAborted();
      const prompt =
        ADVISOR_PROMPT +
        "\n\nOriginal issue:\n" + tasks.get(id) +
        "\n\nAgent evidence ledger:\n" + digest(rootGraph(agent), 3000) +
        "\n\nTrigger: " + trigger;
      advisorPending.add(id);
      run = await ctx.subagents.start("spawn", {
        label: "Advisor",
        parent: agent,
        prompt: [{ type: "text", text: prompt }],
        agentOptions: { provider: providerOf(agent, model.id), model: model.id },
        toolFilter: { allow: [] },
        maxDepth: 1,
        signal,
      });
      advisorPending.delete(id);
      advisorChildren.add(run.id);
      childLabels.set(run.id, "Advisor");
      let outcome;
      try {
        outcome = await run.result;
      } finally {
        await run.dispose();
      }
      signal.throwIfAborted();
      if (outcome.stopReason !== "completed")
        throw new Error("Advisor ended with " + outcome.stopReason + ".");
      const reply = outcome.output
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!reply) throw new Error("Advisor returned no text.");
      record({ kind: "advisor_end", session: id, model: model.id, chars: reply.length });
      return advisorMessage(model.id, trigger, reply);
    } catch (error) {
      signal.throwIfAborted();
      record({ kind: "advisor_failed", session: id, trigger, model: model.id, error: String(error) });
      return undefined;
    } finally {
      if (!run) advisorPending.delete(id);
      if (run) advisorChildren.delete(run.id);
    }
  }

  // Every injection is appended after next(), so the cached prompt prefix is untouched.
  function appendNotes(agent, admitted, { advisor, finalRequest }) {
    const id = agent.session.id;
    const extra = [];
    if (finalRequest)
      extra.push(
        note(
          "This is your final model request under the child budget. Return the concrete result, test evidence, and any unfinished work now.",
        ),
      );
    if (pendingLedgers.has(id)) {
      pendingLedgers.delete(id);
      extra.push(note(ledgerNote(graphFor(id))));
      record({ kind: "ledger_note", session: id });
    }
    const reminder = takeSync(agent);
    if (reminder) extra.push(note(reminder));
    if (advisor) {
      extra.push(note(advisor));
      wantEffort(agent, "advisor_report");
    }
    if (extra.length) admitted = { ...admitted, messages: [...(admitted.messages ?? []), ...extra] };
    if (agent.session.header.parentSession !== undefined) return admitted;
    const guidance = agent.session
      .snapshotEvents()
      .filter(
        (event) =>
          event.type === "user/message" &&
          isEconomyGuidance(agent.session.deriveEventMessage(event)),
      );
    if (
      (!config.economyGuidance && guidance.length === 0) ||
      guidance.some((event) => agent.session.surface.nodes.includes(event.seq))
    )
      return admitted;
    record({ kind: "economy_guidance", session: id });
    return { ...admitted, messages: [...(admitted.messages ?? []), note(ECONOMY_GUIDANCE)] };
  }

  ctx.on("agent/pre-step", async (payload, next) => {
    const { agent, messages, signal } = payload,
      id = agent.session.id,
      isChild = agent.session.header.parentSession !== undefined;
    let finalRequest = false;
    currentTurn.set(id, payload.turn);
    await restoreGraph(id);
    graphFor(id);
    if (!isChild && turnStartSteps.get(id)?.turn !== payload.turn) {
      turnStartSteps.set(id, { turn: payload.turn, step: graphStep(id) });
      wantEffort(agent, "turn_start");
    }
    if (!isChild && agent.ctx) {
      rootByScope.set(agent.ctx, id);
      const scope = scopeOf(agent.ctx);
      if (scope !== undefined) rootByScope.set(scope, id);
    }
    if (!isChild) {
      const key = progressKey(graphFor(id)),
        stall = effortStall.get(id);
      if (!stall || stall.key !== key) effortStall.set(id, { key, step: graphStep(id), done: false });
      else if (!stall.done && graphStep(id) - stall.step >= 4) {
        stall.done = true;
        wantEffort(agent, "stall");
      }
    }
    if (messages.some((m) => ["user", "agent-message", "subagent-settled"].includes(m.source.kind)))
      declinedDelegation.delete(id);
    if (isChild && turnIds.get(id) !== payload.turn) {
      turnIds.set(id, payload.turn);
      turnRequests.set(id, 0);
    }
    for (const message of messages)
      if (message.source.kind === "subagent-settled") {
        const child = message.source.senderSessionId;
        recordCollection(id, child, settled.get(child));
        // The child's evidence stays attributed to its label in the parent graph.
        await restoreGraph(child);
        merge(graphFor(id), graphFor(child), childLabels.get(child) ?? child);
      }
    if (!tasks.has(id)) {
      const assignment =
        assignments.get(id) ??
        (config.mode === "auto" ? (await storage()).table("assignments").get(id) : undefined);
      if (assignment) {
        tasks.set(id, assignment.task);
      } else {
        const previous = agent.session
          .snapshotEvents()
          .filter((e) => e.type === "user/message")
          .map((e) => agent.session.deriveEventMessage(e))
          .filter(Boolean);
        tasks.set(id, extendTask("", previous));
        tasks.set(id, extendTask(tasks.get(id), messages));
      }
      record({ kind: isChild ? "child_assignment" : "root_start", session: id });
    } else {
      tasks.set(id, extendTask(tasks.get(id), messages));
      if (isChild)
        for (const message of messages)
          if (
            message.source.kind === "agent-message" &&
            message.source.senderSessionId === rootOf(agent)
          )
            tasks.set(id, tasks.get(id) + "\n\nFollow-up assignment:\n" + text(message));
    }
    if (
      !isChild &&
      (!roots.has(id) || roots.get(id).configuredMode !== (config.apiKey ? config.mode : "native"))
    ) {
      if (config.mode !== "single") {
        const children = await ctx.subagents.listChildren(id, signal),
          resources = budget(id);
        for (const child of children)
          if (child.kind === "child") {
            if (HELPER_LABELS.has(child.label)) {
              resources.children.delete(child.id);
              resources.helpers.add(child.id);
            } else resources.children.add(child.id);
            if (typeof child.label === "string" && child.label) childLabels.set(child.id, child.label);
          }
      }
      const state = await initialize(agent, signal);
      if (state.mode === "auto") installRouting(agent);
    }
    if (!isChild && modeOf(agent) === "auto") installRouting(agent);
    if (isChild) {
      // The advisor has no tools at all, so it cannot (and need not) report through send_message.
      if (!advisorChildren.has(id)) installChildReporting(agent);
      const state = budget(rootOf(agent)),
        used = turnRequests.get(id) ?? 0,
        turnCap = reviewChildren.has(id) ? config.reviewMaxRequests :
          advisorChildren.has(id) ? 1 : config.maxChildTurnRequests;
      if (state.childRequests >= config.maxChildRequests || used >= turnCap) {
        record({
          kind: "child_budget_exhausted",
          session: id,
          taskChildRequests: state.childRequests,
          turnRequests: used,
        });
        throw new Error("Child request budget exhausted; parent budget remains available.");
      }
      if (used === turnCap - 1 || state.childRequests === config.maxChildRequests - 1)
        finalRequest = true;
    }
    // Advisor triggers are checked before admission, on the root's own evidence.
    let advisor;
    if (!isChild && config.advisorModel && config.advisorModel !== "off" && modeOf(agent) === "auto") {
      const state = advisorFor(id),
        graph = rootGraph(agent),
        key = progressKey(graph),
        now = graphStep(id),
        stallSteps = Math.max(
          3,
          Number.isFinite(config.advisorStallSteps) ? config.advisorStallSteps : 6,
        );
      if (state.key !== key) {
        state.key = key;
        state.since = now;
        state.stallDone = false;
        state.failures.clear();
      }
      if (state.since === undefined) state.since = now;
      const failing = repeatedFailure(graph, state.failures);
      if (state.consults < (config.advisorMaxConsults ?? 2)) {
        if (now - state.since >= stallSteps && !state.stallDone) {
          advisor = await consultAdvisor(agent, "stall", signal);
        } else if (failing) {
          advisor = await consultAdvisor(agent, "repeated failure: " + failing, signal);
        }
      }
    }
    if (!finalRequest && agent.session.requestHeader() !== undefined) {
      // A native compaction in this step rewrites the prefix, so its ledger can follow immediately.
      if (modeOf(agent) !== "auto") {
        try {
          await getCompactor().compactIfNeeded(agent, "pressure", signal);
        } catch (error) {
          if (signal.aborted) throw error;
          record({ kind: "context_unshrinkable", session: id, error: String(error) });
        }
      } else await selectUnderPressure(agent, signal);
    }
    const admitted = await next();
    if (admitted.kind === "reject") return admitted;
    graphSteps.set(id, graphStep(id) + 1);
    return appendNotes(agent, admitted, { advisor, finalRequest });
  });
  // Per-step executor effort through dsh's own request-config waterfall (as native model selection does).
  // A raised effort persists in the request header, so a non-due step strips it again unless the user
  // configured an effort for this agent.
  ctx.on("agent/request", async function (payload, next) {
    const resolved = await next();
    let id = rootByScope.get(this);
    if (id === undefined && this) {
      const scope = scopeOf(this);
      if (scope !== undefined) id = rootByScope.get(scope);
    }
    const agent = id === undefined ? undefined : ctx.agents.get(id);
    if (!agent || effortSupported.get(id) !== true) return resolved;
    if (agent.options?.reasoningEffort !== undefined) return resolved;
    if (effortDue.has(id)) {
      const reason = effortDue.get(id);
      effortDue.delete(id);
      record({ kind: "effort_raised", session: id, effort: config.adaptiveEffort, reason, step: payload.step });
      return { ...resolved, reasoningEffort: config.adaptiveEffort };
    }
    if (resolved.reasoningEffort === undefined) return resolved;
    const { reasoningEffort: _raised, ...withoutEffort } = resolved;
    return withoutEffort;
  });
  ctx.on("llm/stream", async function* (options, next) {
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
    if (agent && agent.session.header.parentSession !== undefined) {
      const id = agent.session.id,
        state = budget(rootOf(agent)),
        used = turnRequests.get(id) ?? 0,
        cap = reviewChildren.has(id) ? config.reviewMaxRequests :
          advisorChildren.has(id) ? 1 : config.maxChildTurnRequests;
      if (state.childRequests >= config.maxChildRequests || used >= cap)
        throw new Error("Child model-call budget exhausted, including compaction calls.");
      turnRequests.set(id, used + 1);
      state.childRequests++;
    }
    const started = performance.now();
    let usage;
    const dispatchEstimate = agent ? ctx.tokenMeter.measure(agent.session).totalTokens : undefined;
    if (agent) updateStats(rootOf(agent), { nativeEstimate: dispatchEstimate });
    try {
      for await (const chunk of next()) {
        if (chunk.type === "usage") usage = chunk.usage;
        yield chunk;
      }
    } finally {
      if (agent && options.purpose === undefined) {
        if (Number.isFinite(usage?.totalTokens) && Number.isFinite(usage?.outputTokens))
          pressureAnchors.set(agent.session.id, {
            input: usage.totalTokens - usage.outputTokens,
            estimate: dispatchEstimate,
          });
        else pressureAnchors.delete(agent.session.id);
      }
      record({
        kind: "execution_call",
        session: options.sessionId,
        model: options.model,
        effort: options.reasoningEffort,
        purpose: options.purpose ?? "execution",
        wallMs: performance.now() - started,
        ...(usage === undefined ? {} : { usage }),
      });
    }
  });
  ctx.on("session/event", (session, event) => {
    if (event.type === "compaction/summary") {
      pressureAnchors.delete(session.id);
      pendingLedgers.add(session.id);
    }
  });

  const region = (nodes, start, end, agent) =>
    nodes
      .slice(start, end + 1)
      .map((seq, index) => ({
        seq,
        position: start + index,
        message: agent.session.deriveEventMessage(agent.session.eventAt(seq)),
      }))
      .filter((x) => x.message !== null);

  async function selectUnderPressure(agent, signal) {
    const id = agent.session.id,
      measured = ctx.tokenMeter.measure(agent.session);
    updateStats(rootOf(agent), { nativeEstimate: measured.totalTokens });
    const anchor = pressureAnchors.get(id);
    const pressure = anchor
      ? anchor.input + Math.max(0, measured.totalTokens - anchor.estimate)
      : measured.totalTokens;
    const ceiling = Math.ceil(config.pressureTokens * config.ceilingRatio);
    if (pressure < config.pressureTokens) return;
    record({
      kind: "context_pressure",
      session: id,
      nativeEstimate: measured.totalTokens,
      pressure,
      ceiling,
      basis: anchor ? "observed_input_plus_estimated_growth" : "native_estimate",
      ...(anchor ? { observedInput: anchor.input } : {}),
    });
    const nodes = [...agent.session.surface.nodes];
    let start = 2,
      end = nodes.length - 1,
      retainTokens = config.retainTokens;
    while (start <= end && !toolPairingBalancedBefore(agent.session, nodes[start])) start++;
    do {
      end = nodes.length - 1;
      let tail = 0;
      while (end >= start && tail < retainTokens) {
        tail += measured.nodes[end].tokens;
        end--;
      }
      while (end >= start && !toolPairingBalancedAfter(agent.session, nodes[end])) end--;
      if (end >= start) break;
      if (pressure < ceiling) return;
      if (retainTokens === 0) {
        record({ kind: "context_unshrinkable", session: id, pressure, ceiling });
        return;
      }
      retainTokens = Math.floor(retainTokens / 2);
    } while (true);
    // The head (system + first user task) and the recent tail stay untouched, so
    // the cached prompt prefix survives the replacement.
    const fullEnd = end;
    const compactRegion = async (reason, regionEnd = fullEnd) => {
      signal.throwIfAborted();
      try {
        const result = await getCompactor().compactRegion(
          nodes[start],
          nodes[regionEnd],
          agent,
          signal,
        );
        record({
          kind: "context_replaced",
          session: id,
          start: nodes[start],
          end: nodes[regionEnd],
          reason,
          sourceCount: result.shadowedSeqs.length,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        record({
          kind: "context_unshrinkable",
          session: id,
          start: nodes[start],
          end: nodes[regionEnd],
          pressure,
          ceiling,
          reason,
          error: String(error),
        });
      }
    };
    if (retainTokens < config.retainTokens) {
      await compactRegion("ceiling_reduced_retention");
      return;
    }
    const units = (items) => {
      // The dropped index names the tool a unit came from, so a tool result is
      // linked back to its call through the provider-issued call id.
      const calls = new Map();
      for (const { message } of items)
        for (const block of message.content)
          if (block.type === "tool-call")
            calls.set(block.id, { tool: block.name, argument: salientArgument(block.arguments) });
      return items.flatMap(({ seq, position, message }) => {
        const required =
          message.role === "system" ||
          message.source.kind === "user" ||
          isEconomyGuidance(message) ||
          (agent.session.header.parentSession !== undefined &&
            message.source.kind === "agent-message" &&
            message.source.senderSessionId === rootOf(agent));
        if (required)
          return [
            {
              id: "event_" + seq,
              position,
              kind: message.role,
              text: JSON.stringify(message),
              required: true,
            },
          ];
        // Logical blocks keep final evidence separate from speculative reasoning.
        // Every block is complete; the original full messages stay in the journal.
        return message.content.map((block, i) => {
          const call =
            block.type === "tool-call"
              ? { tool: block.name, argument: salientArgument(block.arguments) }
              : message.source.kind === "tool"
                ? calls.get(message.source.callId)
                : undefined;
          return {
            id: "event_" + seq + "_block_" + i,
            position,
            kind: message.role + "/" + block.type,
            text: JSON.stringify(block),
            required: false,
            ...(call ?? {}),
          };
        });
      });
    };
    const history = units(region(nodes, start, end, agent));
    const recent = units(region(nodes, end + 1, nodes.length - 1, agent))
      .filter((x) => !x.kind.endsWith("/reasoning"))
      .slice(-3);
    const observation = {
      contextPressure: pressure,
      nativeEstimate: measured.totalTokens,
      ...boundedEvidence(recent),
    };
    const state = budget(rootOf(agent));
    let batch = selectionBatch(tasks.get(id), history, observation);
    const models = modelKnowledge.get(rootOf(agent));
    if (batch && models) {
      batch = { models, ...batch };
      while (batch.history.length && Buffer.byteLength(JSON.stringify(batch)) > STATE_BYTES)
        batch.history.pop();
      if (!batch.history.length) batch = null;
    }
    if (!batch) {
      record({
        kind: "decision_budget_boundary",
        session: id,
        action: "native_compaction",
        reason: "selection does not fit one Jev batch",
      });
      await compactRegion("selection_does_not_fit");
      return;
    }
    // The judged span is the oldest contiguous run of complete candidates in the
    // batch; the replacement shadows only that run and leaves the rest in place.
    const covered = new Set(batch.history.map((unit) => unit.id));
    const firstUnjudged = history.find((unit) => !unit.required && !covered.has(unit.id));
    let judgedEnd = firstUnjudged ? firstUnjudged.position - 1 : end;
    while (judgedEnd >= start && !toolPairingBalancedAfter(agent.session, nodes[judgedEnd]))
      judgedEnd--;
    if (judgedEnd < start) {
      await compactRegion("selection_does_not_fit");
      return;
    }
    const judged = history.filter((unit) => unit.position <= judgedEnd);
    const judgedIds = new Set(judged.map((unit) => unit.id));
    batch.history = batch.history.filter((unit) => judgedIds.has(unit.id));
    if (!batch.history.length) {
      await compactRegion("selection_does_not_fit");
      return;
    }
    if (state.decisions >= config.maxDecisions) {
      record({
        kind: "decision_budget_boundary",
        session: id,
        action: "native_compaction",
        remaining: 0,
      });
      await compactRegion("decision_budget");
      return;
    }
    let selection;
    try {
      const children = await ctx.subagents.listChildren(rootOf(agent), signal);
      const owners = Object.fromEntries(
        children
          .filter((x) => x.kind === "child" && x.id !== id)
          .map((x) => [x.id, "Existing child responsibility: " + x.label]),
      );
      selection = await scoreContext(
        (request) => decide(agent, request, signal),
        batch,
        owners,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      record({ kind: "context_decision_failed", session: id, error: String(error) });
      await compactRegion("decision_failed");
      return;
    }
    signal.throwIfAborted();
    const unitText = (unit) => unit.kind + ":\n" + unit.text;
    const tokensOf = (unit) => ctx.tokenMeter.estimateMessage(note(unitText(unit)));
    const regionTokens = measured.nodes
      .slice(start, judgedEnd + 1)
      .reduce((sum, node) => sum + node.tokens, 0);
    const budgeted = budgetedSelection(
      judged,
      selection.judgments,
      config.keepRatio * regionTokens,
      tokensOf,
    );
    const kept = new Set(budgeted.keptIds);
    const dropped = judged.filter((unit) => !kept.has(unit.id));
    const summary = judged
      .filter((unit) => kept.has(unit.id))
      .map((unit) => ({ type: "text", text: unitText(unit) }));
    if (dropped.length)
      summary.push({
        type: "text",
        text:
          "Archived units (already examined; listed for avoidance, content removed):\n" +
          dropped.map(droppedUnitLine).join("\n"),
      });
    const replacementTokens =
      ctx.tokenMeter.estimateMessage(note(summary.map((x) => x.text).join("\n"))) + 200;
    record({
      kind: "context_scores",
      session: id,
      judgments: selection.judgments,
      kept: kept.size,
      dropped: dropped.length,
      estimatedBefore: regionTokens,
      estimatedAfter: replacementTokens,
    });
    if (replacementTokens > regionTokens * 0.8) {
      await compactRegion(pressure >= ceiling ? "ceiling_native" : "selection_shortfall");
      return;
    }
    prepared.set(id, { summary, model: selection.model });
    try {
      await compactRegion("replacement", judgedEnd);
    } finally {
      prepared.delete(id);
    }
  }
}
