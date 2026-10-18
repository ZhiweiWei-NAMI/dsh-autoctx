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
import {
  scoreContext,
  planSelection,
  renderSelection,
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
import { createPlanDispatcher } from "./plandispatch.js";
import { planParameters, dispatcherLabel } from "./plan.js";
import { emptyRouteLedger, applyRouteFacts } from "./routeledger.js";
import { fingerprint, sharedPrefix, reusableTokens, switchEstimate } from "./cachespace.js";
import { contributionFacts, learningQuestions, proposalsFrom } from "./learning.js";
import { segmentUnits, focusTerms } from "./segments.js";
import { workspaceDiff, hunkContext, failureExcerpt, adviceQuestion, advisorBrief, reviewBrief, attemptsFrom } from "./briefs.js";
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
  CATALOG,
  modelInfo,
  availableModels,
  pickModel,
  knowledge,
  costUSD,
  jevCostUSD,
  routePolicy,
} from "./models.js";
import {
  emptyLedger,
  weightKey,
  parseKey,
  effective,
  experienceRows,
  propose,
  approve,
  reject,
  setMode,
  revert,
  setUser,
  withdraw,
  MODES,
} from "./ledger.js";

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

// 0.2.0 owns one-shot runs directly; 0.2.1 owns all runs as activations.
// Keep composition on the child's scope, including a cold-resumed worker.
export function createChildStarter(ctx, restoreComposition) {
  const pending = new Map();
  ctx.on("agent/created", async ({ agent }) => {
    const id = agent.session.id;
    if (agent.session.header.parentSession === undefined) return;
    if (!pending.has(id) && typeof ctx.subagents.startContinuable === "function") return;
    const composition = pending.get(id) ?? await restoreComposition?.(agent);
    if (!composition) return;
    // Historical descriptors already restore these fields in the host.
    const descriptor = agent.session.snapshotEvents().find((event) => event.type === "subagent/descriptor")?.data;
    if (composition.persona !== undefined && descriptor?.persona === undefined) agent.ctx.systemPrompt.section({
      name: "deployment:persona-prefix",
      order: agent.ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      text: composition.persona,
    });
    if (composition.toolFilter !== undefined && descriptor?.toolFilter === undefined)
      agent.ctx.tools.restrict(composition.toolFilter);
  });
  return async (provider, request, { childId, continuable = false } = {}) => {
    const runtime = ctx.subagents;
    if (!continuable && typeof runtime.start === "function") return runtime.start(provider, request);
    const { label, signal, ...options } = request;
    if (continuable && typeof runtime.startContinuable === "function")
      return runtime.startContinuable({ childId, provider, label, request: options, signal });
    const { persona, toolFilter, ...activationRequest } = options;
    const id = childId ?? randomUUID();
    pending.set(id, { persona, toolFilter });
    let activation;
    try {
      activation = await runtime.startActivation({
        childId: id, provider, label, request: activationRequest, signal,
        delivery: continuable ? "parent" : "caller",
      });
    } finally {
      pending.delete(id);
    }
    if (continuable) return activation;
    // Activation signals stop owning cancellation after acceptance. The old
    // one-shot contract keeps the caller's signal connected until collection.
    let abortDisposal;
    const abort = () => {
      abortDisposal ??= activation.dispose();
      // Disposal errors remain observable through the returned dispose().
      abortDisposal.catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      id: activation.childId,
      result: activation.result.finally(() => signal.removeEventListener("abort", abort)),
      dispose: async () => {
        signal.removeEventListener("abort", abort);
        await (abortDisposal ?? activation.dispose());
      },
    };
  };
}

export const Config = z.object({
  mode: z
    .union(["auto", "single", "native", "plan"])
    .default("auto")
    .volatile()
    .description(
      "auto routes decisions through Jev, single keeps one agent, native keeps native compaction, plan dispatches explicit subtasks",
    ),
  planRouting: z.union(["jev", "fixed"]).default("jev").volatile(),
  planMaxChildren: z.number().step(1).min(0).default(3).volatile(),
  planMinDelegated: z.number().step(1).min(0).default(0).volatile()
    .description("Mechanism smoke only: delegated subtasks a root task's plans must contain in total; 0 keeps the main agent's choice"),
  planMaxJevCalls: z.number().step(1).min(0).default(6).volatile(),
  planChildRequests: z.number().step(1).min(1).default(16).volatile(),
  apiKey: z.string().role("secret").volatile().description("Jev API key; unset keeps native mode, or fixed routing in plan mode"),
  jevModel: z
    .string()
    .default("jev-1.13")
    .volatile()
    .description(
      "Jev model answering the decisions: jev-1.13 (billed to the key's workspace) or jev-1.13-free (free tier, rate limited)",
    ),
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
  preferredProviders: z
    .array(z.string())
    .default([])
    .volatile()
    .description("Preferred providers for executor-side roles (the default choice when suitability is comparable). Jev keeps its own route"),
  allowedProviders: z
    .array(z.string())
    .default([])
    .volatile()
    .description("Further valid providers for executor-side roles; with preferredProviders they exclude other providers whenever one fits"),
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
      "Reasoning effort used when Jev judges a phase needs it; it stays for the turn and changes only at a context checkpoint. off keeps the default",
    ),
  effortSwitchFreeTokens: z.number().min(0).default(4096)
    .description("Decision-point pulses with at most this estimated uncached re-read proceed without asking Jev"),
  maxEffortDecisions: z.number().min(0).default(6)
    .description("Separate Jev effort decision calls per root task; never spends the routing/context budget"),
  effortPhaseRequests: z.number().min(1).default(4)
    .description("Maximum high-effort requests after a phase trigger; a new trigger renews this window"),
  cacheTtlSeconds: z.number().min(0).default(300)
    .description("Conservative assumed reuse lifetime in seconds; provider cache TTL is unverified"),
  learning: z
    .union(["auto", "manual", "frozen"])
    .default("frozen")
    .volatile()
    .description(
      "Workspace adaptation weights: frozen (default) only records evidence, auto (beta) applies Jev's proposals, manual waits for approval",
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
    .default(false)
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
  contextSelection: z
    .union(["jev", "summary"])
    .default("jev")
    .volatile()
    .description(
      "Under pressure, Jev keeps the most relevant units verbatim (jev) or the executor summarizes the region (summary)",
    ),
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
const changesFilesCall = (name, args) =>
  fileChanging.has(name) ||
  (name === "str_replace_editor" && ["create", "str_replace", "insert"].includes(args?.command));
// Task tags key the workspace ledger; Jev picks one per root turn.
const TASK_TAGS = {
  debugging: "Find and fix the cause of a reported failure or wrong behavior.",
  implementation: "Add or change behavior from a specification.",
  review: "Inspect code or a change and report findings; editing is not the main goal.",
  retrieval: "Answer a question about the code or gather information.",
  planning: "Design or explain an approach before any change.",
};
const TAG_QUESTION = {
  type: "choice",
  instructions: "Which kind of task is the user's current request? Judge the request, not the tools used so far.",
  criteria: TASK_TAGS,
};
const LEARNED_ROLES = new Set(["reviewer", "advisor", "worker"]);
// Thinking policies Jev chooses from per turn (and again at a context checkpoint).
const THINKING_POLICIES = {
  off: "No thinking this turn: every request stays in one provider cache space. Fits mechanical, well-specified work.",
  decision_points:
    "Think only on the request right after a decision point: the start of the turn, a failing test, a reviewer's defect report, an advisor reply, or several steps without new evidence. Other requests stay off; each switch re-reads the context uncached once.",
  always: "Think on every request this turn: one cache space, but more output tokens and time on every request.",
};
// Measured in dsh-bench (12 SWE-bench Verified pytest tasks, 600 s, 64 calls incl. Jev; resolved tasks).
const THINKING_MEASURED =
  "dsh-bench, 12 SWE-bench Verified tasks per run: deepseek-v4.1-flash resolved 18/24 with decision_points and 15/24 with thinking off for the whole turn; glm-5.3-flash 18/24 with decision_points and 7/12 with off; always was not measured. Small samples.";
const EFFORT_STATE_BYTES = 8000;
const shortText = (value, chars) => String(value ?? "").slice(0, chars);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const EFFORT_CHOICES = {
  skip: "Keep the current effort/cache space; no effort change.",
  pulse: "High effort for the next request only.",
  phase: "High effort until the trigger is resolved or the request window/turn ends; new triggers renew the window.",
};
// Measured on deepseek-v4.1-flash through WorkBuddy (same affinity id): thinking on and off are separate
// provider cache spaces. Other routes were not measured.
const thinkingCacheFact = (model) =>
  modelInfo(model)?.family === "deepseek"
    ? "measured: on this model family, requests with thinking on and off use separate provider cache spaces; a switch re-reads the whole context uncached once, then the new setting caches again"
    : "unknown: whether switching thinking invalidates the provider cache was not measured for this model";
// The user's preference vector (strategy weights) named as the dominant need.
const needOf = (weights) => {
  if (!weights) return "balanced";
  const { quality = 0.5, latency = 0.5, usage = 0.5 } = weights;
  if (quality >= Math.max(latency, usage) + 0.2) return "quality";
  if (usage >= Math.max(quality, latency) + 0.2) return "cost";
  if (latency >= Math.max(quality, usage) + 0.2) return "speed";
  return "balanced";
};
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const REVIEW_PROMPT =
  "Independently check the change the parent just made against the original issue. The change and the code around it are below (run `git diff` only where the brief says it is truncated); re-read the issue, run a minimal reproduction and the single most relevant existing test file. Never run the whole test suite; keep every command under 60 seconds; batch independent checks into one step. Do NOT edit files. Report only defects in the change itself: failures that also happen without the change, untested extras and style are not defects. Start the first line with exactly `LGTM` (then one line of evidence) or `DEFECTS` (then each concrete defect with evidence).";
const reviewMessage = (report) =>
  "An independent reviewer reports possible defects in your change:\n" +
  report +
  "\nCheck each against the behavior the issue asks for: fix the real ones and verify with the most relevant test; keep your change where a report contradicts the issue. Do not investigate unrelated or pre-existing failures, then finish.";
const ADVISOR_PROMPT =
  "You are a senior advisor to a coding agent. Do not call tools; answer from this brief only. Answer its Question from the observed failure, the change and the code shown: name the specific line or condition at fault, the concrete fix, and what evidence would confirm it, in ≤ 1200 characters.";
const advisorMessage = (model, trigger, reply) =>
  "Advisor (" + model + ", independent, no tool access) on " + trigger + ":\n" + reply +
  "\nTreat this as a hypothesis; verify it against evidence before acting.";
const syncMessage = (edits) =>
  "Collaborator changes since your last step:\n" +
  edits.map((edit) => "- " + edit.path + " edited by " + edit.label).join("\n") +
  "\nRe-read these before relying on earlier content.";
const staleMessage = (label, paths, newUserMessage) =>
  label + " started before " +
  [paths.length ? "your edits to " + paths.join(", ") : "", newUserMessage ? "the latest user message" : ""]
    .filter(Boolean).join(" and ") +
  "; its result describes the earlier state. Check it against the current files and request before relying on it.";
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
    memos = new Map(),
    jevDown = new Map();
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
    // root session -> test key -> raw output of its latest failing run (the advisor has no tools).
    failureOutput = new Map(),
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
    // Sticky executor effort: one Jev turn plan (task tag + thinking) per root turn, revisited only at a
    // context checkpoint, so the cached prefix is not split between thinking on and off.
    turnPlans = new Map(),
    effortSupported = new Map(),
    effortInstalled = new Set(),
    effortSet = new Map(),
    effortDue = new Map(),
    effortStall = new Map(),
    effortSkips = new Map(),
    effortPulses = new Map(),
    effortPhases = new Map(),
    effortRequests = new Map(),
    effortOutputs = new Map(),
    effortReports = new Map(),
    effortTools = new Map(),
    taskHeads = new Map(),
    turnHeads = new Map(),
    admittedMessages = new Map(),
    cacheSpaces = new Map(),
    userEffort = new Set(),
    childEffort = new Map(),
    // Per-root accounting of the current turn: role use, cost and cache by category.
    turnUses = new Map(),
    childRoles = new Map(),
    childModels = new Map(),
    childStarts = new Map(),
    deferredSelection = new Map(),
    filteredByRoot = new Map(),
    modelKnowledge = new Map(),
    availableByRoot = new Map(),
    providersByRoot = new Map(),
    lastCached = new Map();
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
  // Real user requests only: compaction checkpoints and plugin notes are also user/message events.
  const userMessages = (agent) =>
    agent.session.snapshotEvents().filter((event) =>
      event.type === "user/message" && agent.session.deriveEventMessage(event)?.source.kind === "user").length;
  // The model the session currently requests with (a live model switch updates the request header).
  const currentModel = (agent) => agent?.session.requestHeader?.()?.config?.model ?? agent?.options?.model;
  const budget = (id) => {
    if (!budgets.has(id))
      budgets.set(id, {
        children: new Set(),
        helpers: new Set(),
        pending: new Set(),
        childRequests: 0,
        decisions: 0,
        effortDecisions: 0,
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
    const maxDecisions = config.mode === "plan" ? config.planMaxJevCalls ?? 6 : config.maxDecisions;
    const decisions = config.mode === "plan" ? planDispatcher.jevCalls(id) : budgets.get(id)?.decisions ?? 0;
    const current =
      statsMap.get(id) ??
      newStats(config.mode === "plan" ? "plan" : config.apiKey ? config.mode : "native", maxDecisions, config.pressureTokens);
    statsMap.delete(id);
    statsMap.set(id, {
      ...applyStatsRecord(current, value, decisions),
      maxDecisions,
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
        "jev_unavailable",
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
        "execution_call",
        "turn_plan",
        "effort_checkpoint",
        "effort_raised",
        "effort_decision",
        "effort_phase_end",
        "context_deferred",
        "learning",
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
    c.effect(
      () =>
        c.connection.fetch.register({
          path: "/api/dsh-autoctx/ledger",
          methods: ["GET", "POST"],
          requestBody: "buffered",
          fetch: (request) => ledgerRoute(request),
        }),
      "dsh-autoctx: ledger route",
    );
  });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  // Ledger view for the UI: effective weights with their source and evidence count, the pending card,
  // and the last changes. Values are never invented: an unused key is simply absent.
  const ledgerView = (ledger) => ({
    mode: ledger.mode,
    version: ledger.version,
    weights: Object.entries(ledger.weights).map(([key, entry]) => ({
      key,
      ...effective(ledger, key),
      ...(entry.learned === undefined ? {} : { learned: entry.learned }),
      ...(entry.user === undefined ? {} : { user: entry.user }),
      updatedAt: entry.updatedAt,
    })),
    pending: ledger.pending,
    history: ledger.history.slice(-8),
  });
  async function ledgerRoute(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const session = body.session ?? url.searchParams.get("session");
    const cwd =
      body.cwd ?? url.searchParams.get("cwd") ??
      (session ? ctx.agents.get(statsRoot(session))?.session.header.cwd : undefined) ?? "";
    if (request.method === "GET") return json({ cwd, ledger: ledgerView(await readLedger(cwd)) });
    const now = Date.now();
    const actions = {
      approve: (ledger) => approve(ledger, body.version, now),
      reject: (ledger) => reject(ledger, body.version, now),
      revert: (ledger) => revert(ledger, body.version, now),
      mode: (ledger) => ({ ledger: setMode(ledger, body.mode) }),
      user: (ledger) => ({ ledger: setUser(ledger, body.key, body.value ?? null, now) }),
    };
    if (!actions[body.action] || (body.action === "mode" && !MODES.includes(body.mode)))
      return json({ error: "unknown action" }, 400);
    if (body.action === "user" && (typeof body.key !== "string" || (body.value !== null && !(body.value >= 0 && body.value <= 1))))
      return json({ error: "user weight needs a key and a value in [0, 1] or null" }, 400);
    const result = await updateLedger(cwd, actions[body.action]);
    record({ kind: "ledger_action", cwd, action: body.action, version: body.version, error: result.error });
    return json({ cwd, ledger: ledgerView(result.ledger), ...(result.error ? { error: result.error } : {}) },
      result.error === "stale" ? 409 : result.error ? 404 : 200);
  }
  ctx.on("dispose", () => {
    statsMap.clear();
    memos.clear();
  });
  const modeOf = (agent) =>
    config.mode === "plan" ? "plan" : !config.apiKey
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
          ledger: domainTable(schema.json()),
          uses: domainTable(schema.json()),
        },
      }),
    ));
  ctx.on("dispose", async () => {
    if (storePromise) await (await storePromise).close();
  });
  const startChild = createChildStarter(ctx, async (agent) => {
    if (config.mode !== "auto") return;
    const assignment = assignments.get(agent.session.id) ??
      (await storage()).table("assignments").get(agent.session.id);
    return assignment?.composition;
  });
  const listChildren = async (id, signal) =>
    (await ctx.subagents.listChildren(id, signal)).map((child) => ({
      ...child,
      // Direct catalogs have no recursive-list discriminator on either host.
      ...(child.kind === undefined ? { kind: "child" } : {}),
      // Caller-delivered helpers remain one-shot to the routing layer even
      // though 0.2.1 catalogs every native activation as continuable.
      ...(child.mode === "continuable" && HELPER_LABELS.has(child.label) ? { mode: "one-shot" } : {}),
    }));

  // Workspace ledger: one record per workspace; every change is one serialized storage update.
  const workspaceOf = (agent) => agent?.session.header.cwd ?? "";
  const ledgerInits = new Map();
  // Per-record storage keys must be path-safe, so a workspace path is stored by its hash.
  const ledgerKey = (cwd) => "ws_" + createHash("sha256").update(cwd).digest("hex").slice(0, 32);
  let routeStorePromise;
  const routeStorage = () => (routeStorePromise ??= ctx.storageDomain.open(defineDomain({
    name: "dsh_auto_plan_routes", version: 1, layout: "per-record",
    tables: { routes: domainTable(schema.json()) },
  })));
  const routeUpdates = new Map();
  ctx.on("dispose", async () => { if (routeStorePromise) await (await routeStorePromise).close(); });
  const planRoute = (agent) => {
    const current = agent.session.requestHeader?.()?.config ?? agent.options;
    return { provider: current.provider, model: current.model,
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }) };
  };
  const planProfiles = async (agent, signal) => {
    const profiles = [];
    const configured = config.routes?.length ? config.routes : [buildDefaultRoute(planRoute(agent))];
    const routeOf = (route) => route.provider ?? planRoute(agent).provider;
    const policy = routePolicy(configured, routeOf, { preferred: config.preferredProviders, allowed: config.allowedProviders });
    if (policy.dropped.length)
      record({ kind: "route_policy", session: agent.session.id, role: "worker", dropped: policy.dropped.map((route) => route.id) });
    for (const route of policy.kept) {
      for (const effort of route.efforts?.length ? route.efforts : [undefined]) {
        const options = { provider: route.provider ?? planRoute(agent).provider, model: route.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }) };
        try {
          await ctx.llm.prepareCall(options, signal);
          const info = modelInfo(route.model);
          profiles.push({ id: route.id + "/" + (effort ?? "default"), options, capability: route.description,
            route: routeOf(route), preferredRoute: (config.preferredProviders ?? []).includes(routeOf(route)),
            ...(info ? { knowledge: knowledge([info]) } : {}) });
        } catch (error) {
          if (signal.aborted) throw error;
          record({ kind: "profile_unavailable", session: agent.session.id, profile: route.id, effort: effort ?? null });
        }
      }
    }
    if (!profiles.length) throw new Error("No supported plan route profiles.");
    return profiles;
  };
  const planDispatcher = createPlanDispatcher({ ctx, config, record, note, changesFilesCall, graphFor,
    currentRoute: planRoute, profilesFor: planProfiles,
    decide: (agent, request, signal) => decide(agent, request, signal, { unbudgeted: true }),
    tokensOf: (value) => ctx.tokenMeter.estimateMessage(note(value)),
    prefixOf: (agent) => ({ tokens: ctx.tokenMeter.measure(agent.session).totalTokens,
      end: agent.session.snapshotEvents().findLast((event) => event.type === "turn/end")?.seq ?? -1,
      latest: cacheSpaces.get(agent.session.id)?.latest }),
    briefFor: (agent) => agent.session.snapshotEvents().filter((event) => event.type === "user/message")
      .map((event) => agent.session.deriveEventMessage(event)).filter((message) => message?.source.kind === "user")
      .map(text).join("\n\n") + "\nObserved evidence:\n" + digest(graphFor(agent.session.id), 4000),
    readLedger: async (cwd) => (await routeStorage()).table("routes").get(ledgerKey(cwd)) ?? emptyRouteLedger(),
    learn: async (cwd, key, facts, mode) => {
      const workspace = ledgerKey(cwd);
      const previous = routeUpdates.get(workspace) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        const table = (await routeStorage()).table("routes");
        const result = applyRouteFacts(table.get(workspace) ?? emptyRouteLedger(), key, facts, mode);
        if (result.applied) await table.put(workspace, result.ledger);
        return result;
      });
      routeUpdates.set(workspace, pending);
      try { return await pending; } finally { if (routeUpdates.get(workspace) === pending) routeUpdates.delete(workspace); }
    },
    diffFiles: async (cwd) => {
      const change = await workspaceDiff(cwd);
      if (change.error) throw new Error(change.error);
      return [...new Set([...change.files, ...change.untracked])];
    },
  });
  let planToolInstalled = false;
  const planSnapshots = new Set();
  const installPlanTool = () => {
    if (planToolInstalled) return;
    ctx.tools.register({
      name: "plan", description: "Record subtasks before editing files. Delegated plans end this turn; children start at the completed-turn boundary. Release each main-owned dependency by send_message to the dependent child's reserved id with JSON {subtask,summary} reporting the actual result. Use dependsOn to order subtasks.",
      parameters: planParameters,
      output: {
        schema: { type: "object", required: ["recorded", "assignments"], additionalProperties: false,
          properties: { recorded: { type: "boolean", const: true }, assignments: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["subtask", "model", "effort", "contextOption"],
            properties: Object.fromEntries(["subtask", "model", "effort", "contextOption"].map((key) => [key, { type: "string" }])),
          } } } },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const violations = validateJsonSchemaValue(planParameters, args, "");
        if (violations.length) throw new ToolArgsError(violations);
        const result = await planDispatcher.tool(args, { ...exec, turn: currentTurn.get(exec.agent?.session.id) });
        if (result.isError) throw new Error(result.error.message);
        if (result.concludesTurn) exec.concludeTurn();
        return result.value;
      },
    });
    planToolInstalled = true;
  };
  if (config.mode === "plan") installPlanTool();
  const useKey = (session, turn) => session.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + String(turn).replace(/[^a-zA-Z0-9_-]/g, "_");
  const readLedger = async (cwd) =>
    (await storage()).table("ledger").get(ledgerKey(cwd)) ?? emptyLedger(config.learning);
  async function updateLedger(cwd, fn) {
    const table = (await storage()).table("ledger"),
      key = ledgerKey(cwd);
    if (table.get(key) === undefined) {
      if (!ledgerInits.has(key))
        ledgerInits.set(key, table.put(key, emptyLedger(config.learning)).finally(() => ledgerInits.delete(key)));
      await ledgerInits.get(key);
    }
    let result;
    await table.update(key, (current) => {
      result = fn(current);
      return result.ledger;
    });
    return result;
  }

  const newUse = (turn) => ({
    turn,
    startedAt: Date.now(),
    roles: {},
    cost: { executor: 0, children: 0, jev: 0, compaction: 0 },
    unpriced: 0,
  });
  const useOf = (root) => {
    if (!turnUses.has(root)) turnUses.set(root, newUse(currentTurn.get(root)));
    return turnUses.get(root);
  };
  const roleUse = (root, role, model) => {
    const roles = useOf(root).roles,
      key = role + "|" + model;
    return (roles[key] ??= { role, model, children: 0, completed: 0, calls: 0, usd: 0, ms: 0, input: 0, cacheRead: 0, reports: [] });
  };
  // Host usage is disjoint: inputTokens is the uncached part; cache reads and writes are separate.
  function account(agent, options, usage, ms) {
    const id = agent.session.id,
      root = rootOf(agent);
    const category = options.purpose !== undefined ? "compaction" : id === root ? "executor" : "children";
    const role = category === "compaction" ? undefined : id === root ? "executor" : childRoles.get(id) ?? "worker";
    const usd = usage ? costUSD(options.model, usage) : undefined;
    const use = useOf(root);
    if (usd === undefined) use.unpriced++;
    else use.cost[category] += usd;
    if (role) {
      const entry = roleUse(root, role, modelInfo(options.model)?.id ?? options.model);
      entry.calls++;
      entry.ms += ms;
      if (usd !== undefined) entry.usd += usd;
      entry.input += (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
      entry.cacheRead += usage?.cacheReadTokens ?? 0;
    }
    return { category, role, usd };
  }

  const memoFor = (root) => {
    if (!memos.has(root)) memos.set(root, createDecisionMemo());
    return memos.get(root);
  };
  // Circuit breaker: an unusable Jev (rate limit, auth, billing, server or network failure) is recorded once
  // and the task stops calling it, so the local fallbacks take over without spending the request budget.
  const JEV_UNAVAILABLE = new Set([401, 402, 403, 429]);
  // A gateway or network failure is usually a brief upstream outage: it pauses Jev for a minute instead of
  // ending it for the task. Auth, billing and rate limits stay off.
  const JEV_TRANSIENT = new Set([502, 503, 504]),
    JEV_PAUSE_MS = 60000;
  function tripJev(root, session, status, detail) {
    if (jevDown.has(root)) return;
    const transient = status === undefined || JEV_TRANSIENT.has(status);
    jevDown.set(root, { status, detail, ...(transient ? { until: Date.now() + JEV_PAUSE_MS } : {}) });
    record({ kind: "jev_unavailable", session, model: config.jevModel, httpStatus: status, error: detail,
      ...(transient ? { pausedMs: JEV_PAUSE_MS } : {}) });
  }
  // Learning and effort calls do not compete with routing/context decisions. Effort has its own cap.
  async function decide(agent, request, signal, { unbudgeted = false } = {}) {
    const root = rootOf(agent),
      state = budget(root);
    if (jevDown.get(root)?.until < Date.now()) jevDown.delete(root);
    const down = jevDown.get(root);
    if (down)
      throw new Error(`Jev unavailable for this task (${down.status ?? "network"}); using local fallbacks.`);
    const { questions, ...decisionState } = request;
    const body = JSON.stringify({
      model: config.jevModel,
      state: JSON.stringify(decisionState),
      questions,
    });
    const key = createHash("sha256").update(body).digest("hex");
    return memoFor(root)(key, async () => {
      if (!unbudgeted && state.decisions >= config.maxDecisions)
        throw new Error("Jev task decision budget exhausted.");
      if (unbudgeted && request.trigger === "effort_decision") {
        if (state.effortDecisions >= (config.maxEffortDecisions ?? 6))
          throw Object.assign(new Error("Jev effort decision budget exhausted."), { code: "EFFORT_BUDGET" });
        state.effortDecisions++;
      }
      if (!unbudgeted) state.decisions++;
      updateStats(root);
      const started = performance.now();
      let response;
      // One retry absorbs a momentary gateway or network failure before the breaker trips.
      for (let attempt = 0; ; attempt++) {
        let failure;
        try {
          response = await fetch(config.jevEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
            body,
            signal,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          failure = error;
        }
        if (attempt === 0 && (failure || JEV_TRANSIENT.has(response.status))) {
          record({ kind: "jev_retry", session: agent.session.id, httpStatus: failure ? null : response.status });
          if (!failure) await response.text().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 1500));
          signal?.throwIfAborted();
          continue;
        }
        if (failure) {
          tripJev(root, agent.session.id, undefined, redact(String(failure), config.apiKey).slice(0, 300));
          throw failure;
        }
        break;
      }
      const bodyText = redact(await response.text(), config.apiKey);
      if (!response.ok) {
        if (JEV_UNAVAILABLE.has(response.status) || response.status >= 500)
          tripJev(root, agent.session.id, response.status, bodyText.slice(0, 300));
        throw new Error(`Jev decision failed (HTTP ${response.status}): ${bodyText}`);
      }
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
      const usd = jevCostUSD(config.jevModel, result.usage);
      if (usd !== undefined) useOf(root).cost.jev += usd;
      else useOf(root).unpriced++;
      // The effort state contains raw task/failure evidence. Keep only the validated choice and
      // billing counters even if a gateway echoes state or adds free-text explanations.
      const logged = request.trigger?.startsWith("plan_") ? { model: result.model, usage: result.usage, answers: result.answers } : request.trigger === "effort_decision" ? { model: result.model, usage: result.usage,
        answers: { thinking: { type: "choice", choice: result.answers.thinking.choice,
          confidence: result.answers.thinking.confidence } } } : result;
      record({
        kind: "jev",
        session: agent.session.id,
        trigger: request.trigger,
        httpStatus: response.status,
        wallMs: performance.now() - started,
        ...(usd === undefined ? {} : { usd }),
        ...logged,
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
    const available = [],
      routable = availableModels(routes, { allowPaid: config.allowPaidModels === true });
    // Every catalog model that is not a candidate keeps its reason for the UI.
    const filtered = (CATALOG.models ?? [])
      .filter((entry) => !routable.some((x) => x.id === entry.id))
      .map((entry) => ({
        model: entry.id,
        reason: Object.hasOwn(routes, entry.id) ? "paid route not allowed (allowPaidModels)" : "no dsh route configured",
      }));
    for (const entry of routable) {
      try {
        await ctx.llm.prepareCall({ provider: routes[entry.id], model: entry.id }, signal);
        available.push(entry);
      } catch (error) {
        if (signal.aborted) throw error;
        filtered.push({ model: entry.id, reason: "route preparation failed" });
        record({
          kind: "profile_unavailable",
          session: root,
          profile: entry.id,
          error: String(error),
        });
      }
    }
    availableByRoot.set(root, available);
    filteredByRoot.set(root, filtered);
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
    if (config.mode === "plan") return planDispatcher.guard(exec);
    if (exec.name === "plan") return "plan requires mode=plan.";
    // Role limits for helper children are enforced here rather than by a tool filter, so a forked
    // child keeps the parent's exact tool block (and its cached prefix where the route shares it).
    const role = exec.agent ? childRoles.get(exec.agent.session.id) : undefined;
    if (role === "reviewer" && changesFilesCall(exec.name, exec.arguments))
      return "The independent reviewer reports defects; it does not edit files.";
    if (role === "advisor") return "The advisor answers from its brief without tools.";
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
    if (config.mode === "plan") planDispatcher.onResult(exec, result);
    if (exec.agent && !delegation.has(exec.name) && !result.isError)
      declinedDelegation.delete(exec.agent.session.id);
    if (exec.agent && changesFilesCall(exec.name, exec.arguments) && !result.isError) {
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
        // A failing test run is where a flash executor most often misdiagnoses: a decision point.
        const latest = Object.values(graphFor(id).tests)
          .flatMap((test) => test.runs)
          .filter((run) => run.via === undefined && run.event > since)
          .at(-1);
        const recent = effortTools.get(id) ?? [];
        recent.push({ name: shortText(exec.name, 80), outcome: latest?.outcome ?? (result.isError ? "error" : "success") });
        effortTools.set(id, recent.slice(-6));
        if (config.mode !== "plan") resolveEffortPhase(exec, result, latest);
        if (latest && (latest.outcome === "fail" || latest.outcome === "error")) {
          const key = Object.entries(graphFor(id).tests).find(([, test]) => test.runs.includes(latest))?.[0];
          if (key) {
            if (!failureOutput.has(id)) failureOutput.set(id, new Map());
            const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
            failureOutput.get(id).set(key, text.slice(-40000));
          }
          if (config.mode !== "plan") wantEffort(exec.agent, "test_failure", { testKey: key });
        }
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
    if (config.mode === "plan") return planDispatcher.onChildStart(info);
    const child = ctx.agents.get(info.id);
    if (!child) throw new Error("Auto requires native in-process children.");
    const parent = rootOf(child),
      state = budget(parent),
      advisor = advisorPending.has(parent);
    if (advisor || reviewPending.has(parent)) state.helpers.add(info.id);
    else state.children.add(info.id);
    childRoles.set(info.id, advisor ? "advisor" : reviewPending.has(parent) ? "reviewer" : "worker");
    // Delegated workers are learning evidence too (reviewer and advisor are counted where they start).
    if (childRoles.get(info.id) === "worker") {
      const model = modelInfo(currentModel(child))?.id ?? currentModel(child);
      childModels.set(info.id, model);
      roleUse(parent, "worker", model).children++;
    }
    // What the child's result is based on: later parent edits or user messages make parts of it stale.
    const root = ctx.agents.get(parent);
    childStarts.set(info.id, { edits: editLog(parent).length, users: root ? userMessages(root) : 0 });
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
    if (config.mode === "plan") return planDispatcher.onChildEnd(info);
    const running = active.get(info.id);
    if (!running) throw new Error("Native child ended without a start.");
    active.delete(info.id);
    advisorChildren.delete(info.id);
    settled.set(info.id, info);
    const role = childRoles.get(info.id);
    if (role === "reviewer" || role === "advisor") {
      if (!effortReports.has(running.parent)) effortReports.set(running.parent, new Map());
      effortReports.get(running.parent).set(role === "reviewer" ? "review_report" : "advisor_report",
        shortText((info.lastAssistantMessage ?? []).filter(block => block.type === "text").map(block => block.text).join("\n"), 1500));
    }
    if (childRoles.get(info.id) === "worker" && childModels.has(info.id)) {
      const use = roleUse(running.parent, "worker", childModels.get(info.id));
      if (info.stopReason === "completed") use.completed++;
      const text = (info.lastAssistantMessage ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      use.reports.push({ outcome: info.stopReason, at: graphFor(running.parent).sequence, text: text.slice(0, 300) });
    }
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

  // One Jev turn plan per root turn: the task tag keys the workspace ledger, and Jev picks the turn's
  // thinking policy with the measured outcomes and the cache cost of a switch in view. The policy holds
  // for the turn and is revisited only at a context checkpoint, where the prefix is rebuilt anyway.
  const thinkingQuestion = (instructions) => ({ type: "choice", instructions, criteria: THINKING_POLICIES });
  const thinkingState = (agent, contextTokens) => {
    const price = modelInfo(currentModel(agent))?.price;
    return {
      model: currentModel(agent),
      route: agent.options?.provider,
      contextTokens,
      cache: thinkingCacheFact(currentModel(agent)),
      ...(price
        ? { switchCostUSDNow: round((contextTokens * (price.input - (price.cacheRead ?? price.input))) / 1e6, 5) }
        : {}),
      measured: THINKING_MEASURED,
    };
  };
  async function planTurn(agent, signal) {
    const id = agent.session.id,
      turn = currentTurn.get(id),
      previous = turnPlans.get(id);
    const effortOn = config.adaptiveEffort && config.adaptiveEffort !== "off" && effortSupported.get(id) === true;
    // Without an effort to decide, nothing is asked here: the task tag rides on the first later decision
    // that needs it (role choice or learning).
    if (!effortOn) {
      turnPlans.set(id, { turn, thinking: "off", via: "none" });
      return turnPlans.get(id);
    }
    // Without a Jev answer the measured default holds: thinking at decision points.
    const plan = { turn, thinking: previous?.thinking ?? "decision_points", via: "default" };
    const anchor = pressureAnchors.get(id);
    const request = {
      task: tasks.get(id),
      trigger: "turn_plan",
      preference: roots.get(id)?.policy?.weights,
      executor: {
        ...thinkingState(agent, anchor?.input ?? ctx.tokenMeter.measure(agent.session).totalTokens),
        thinkingNow: previous?.thinking ?? "decision_points",
      },
      questions: {
        task_tag: TAG_QUESTION,
        thinking: thinkingQuestion(
          "Which thinking policy should the executor follow for this turn? Quality of the result comes first; weigh the measured outcomes in `executor.measured`, the extra output tokens and time of thinking, and the cache cost of each switch (`executor.switchCostUSDNow`) under the user's preference.",
        ),
      },
    };
    try {
      const answers = (await decide(agent, request, signal)).answers;
      plan.tag = answers.task_tag.choice;
      plan.tagConfidence = answers.task_tag.confidence;
      plan.thinking = answers.thinking.choice;
      plan.thinkingProbabilities = answers.thinking.probabilities;
      plan.via = "jev";
    } catch (error) {
      if (signal.aborted) throw error;
      plan.error = String(error).slice(0, 200);
    }
    plan.effort = plan.thinking === "always" ? config.adaptiveEffort : undefined;
    turnPlans.set(id, plan);
    record({ kind: "turn_plan", session: id, turn, tag: plan.tag ?? null, thinking: plan.thinking, effort: plan.effort ?? null,
      via: plan.via, ...(plan.thinkingProbabilities ? { probabilities: plan.thinkingProbabilities } : {}),
      ...(plan.error ? { error: plan.error } : {}) });
    if (plan.thinking === "decision_points") wantEffort(agent, "turn_start");
    return plan;
  }

  const phaseWindow = () => Math.max(1, Math.floor(config.effortPhaseRequests ?? 4));
  const failingTest = (id) => Object.entries(graphFor(id).tests)
    .map(([key, test]) => ({ key, run: test.runs.filter(run => run.via === undefined).at(-1) }))
    .filter(({ run }) => ["fail", "error"].includes(run?.outcome))
    .sort((a, b) => b.run.event - a.run.event)[0];
  function phaseTrigger(id, reason, details = {}) {
    return { reason, testKey: details.testKey ?? (reason === "test_failure" ? failingTest(id)?.key : undefined),
      progress: progressKey(graphFor(id)), event: graphFor(id).sequence };
  }
  function extendEffortPhase(id, phase, trigger) {
    phase.triggers.set(trigger.reason + "|" + (trigger.testKey ?? ""), trigger);
    phase.until = (effortRequests.get(id) ?? 0) + phaseWindow();
  }
  function endEffortPhase(id, endedBy) {
    const phase = effortPhases.get(id);
    if (!phase) return;
    effortPhases.delete(id);
    record({ kind: "effort_phase_end", session: id, reason: phase.reason, requests: phase.requests, endedBy });
  }
  function resolveEffortPhase(exec, result, latest) {
    const id = exec.agent.session.id, phase = effortPhases.get(id);
    if (!phase) return;
    const successful = !result.isError && !["fail", "error", "unknown"].includes(latest?.outcome);
    let endedBy;
    for (const [key, trigger] of phase.triggers) {
      if (graphFor(id).sequence <= trigger.event) continue;
      if (trigger.reason === "test_failure") {
        const test = graphFor(id).tests[trigger.testKey];
        const run = test?.runs.filter(run => run.via === undefined).at(-1);
        if (!successful || run?.outcome !== "pass" || run.event <= trigger.event) continue;
        endedBy = "test_passed";
      } else if (["review_report", "advisor_report"].includes(trigger.reason)) {
        if (!successful || !(latest?.outcome === "pass" || changesFilesCall(exec.name, exec.arguments))) continue;
        endedBy = "report_acted_on";
      } else {
        if (!successful || progressKey(graphFor(id)) === trigger.progress) continue;
        endedBy = "progress";
      }
      phase.triggers.delete(key);
    }
    if (!phase.triggers.size) endEffortPhase(id, endedBy);
  }

  // A fresh trigger renews an active phase locally, without spending another Jev decision.
  function wantEffort(agent, reason, details = {}) {
    if (agent.session.header.parentSession !== undefined) return;
    const id = agent.session.id;
    if (turnPlans.get(id)?.thinking !== "decision_points") return;
    const trigger = phaseTrigger(id, reason, details), phase = effortPhases.get(id);
    if (phase) extendEffortPhase(id, phase, trigger);
    else if (!effortDue.has(id) || ["turn_start", "stall"].includes(effortDue.get(id).reason))
      effortDue.set(id, trigger);
  }

  function invalidateCache(id, reason) {
    const cache = cacheSpaces.get(id);
    record({ kind: "cache_invalidated", session: id, reason,
      spaces: cache?.spaces.size ?? 0, hadLatest: !!cache?.latest });
    cacheSpaces.set(id, { spaces: new Map(), latest: undefined, invalidated: reason, failed: false });
  }
  function checkCacheGeneration(agent) {
    const cache = cacheSpaces.get(agent.session.id), generation = agent.session.surface?.contentGeneration;
    if (cache?.generation !== undefined && generation !== undefined && cache.generation !== generation)
      invalidateCache(agent.session.id, "surface_generation_changed");
  }

  // Use the live projected messages, never an old request plus a token-count delta when available.
  function effortEstimate(agent, resolved, payload) {
    checkCacheGeneration(agent);
    const id = agent.session.id, cache = cacheSpaces.get(id), price = modelInfo(resolved.model)?.price;
    const projected = agent.session.deriveMessages?.();
    const messages = payload.messages ?? resolved.messages ?? (projected === undefined ? undefined :
      [...projected, ...(admittedMessages.get(id) ?? [])]);
    let current = cache?.latest, source = "latest_plus_pending", pendingTokens = 0;
    if (messages !== undefined) {
      current = fingerprint({ ...resolved, tools: payload.tools ?? resolved.tools ?? agent.session.requestHeader?.()?.tools,
        messages }, message => ctx.tokenMeter.estimateMessage(message));
      source = payload.messages !== undefined || resolved.messages !== undefined ? "request_messages" : "session.deriveMessages+admitted";
    } else if (current) {
      pendingTokens = Math.max(0, ctx.tokenMeter.measure(agent.session).totalTokens -
        current.tokens.reduce((sum, value) => sum + value, 0));
    }
    const totalTokens = current ? current.tokens.reduce((sum, value) => sum + value, 0) + pendingTokens : null;
    if (cache?.invalidated && !cache.latest)
      return { totalTokens, reusableTokens: 0, uncachedTokens: 0, usd: 0, source,
        postReplacement: true };
    if (!current || !price)
      return { totalTokens, reusableTokens: null, uncachedTokens: null, usd: null, source };
    const target = cache?.spaces.get(`${resolved.provider}|${resolved.model}|${config.adaptiveEffort}`);
    const estimate = switchEstimate({ latest: current, target: target?.fingerprint, at: target?.at,
      now: Date.now(), ttlMs: (config.cacheTtlSeconds ?? 300) * 1000, pendingTokens, price });
    // Reuse in the current space is the baseline: entering high cannot lose tokens the baseline also
    // has to read. After a replacement both spaces must read the new prefix, so the premium is zero.
    const baseline = cache?.spaces.get(`${resolved.provider}|${resolved.model}|${effortSet.get(id) ?? resolved.reasoningEffort ?? "default"}`);
    const baselineReuse = reusableTokens(baseline?.fingerprint, current, { now: Date.now(), at: baseline?.at,
      ttlMs: (config.cacheTtlSeconds ?? 300) * 1000 });
    estimate.uncachedTokens = Math.max(0, baselineReuse - estimate.reusableTokens);
    estimate.usd = round(estimate.uncachedTokens * (price.input - (price.cacheRead ?? price.input)) / 1e6);
    return { ...estimate, source };
  }

  function effortOptionCosts(id, resolved, estimate) {
    const price = modelInfo(resolved.model)?.price;
    const measured = effortOutputs.get(id)?.get(`${resolved.provider}|${resolved.model}`);
    const pulses = effortPulses.get(id) ?? { count: 0, reasons: {}, rePulsedWithin3: 0 };
    const average = measured?.calls ? measured.outputTokens / measured.calls : null;
    const reasoning = measured?.reasoningCalls ? measured.reasoningTokens / measured.reasoningCalls : null;
    const churn = { pulses: pulses.count, rePulsedWithin3: pulses.rePulsedWithin3,
      reentryIfTriggeredSoon: { uncachedTokens: estimate.uncachedTokens, usd: estimate.usd,
        basis: "Same prefix/target-space reuse as now; future growth and cache hits are unknown." },
      observed: "1.2.3: 58% of switches reverted within 3 requests" };
    const option = (requests) => ({ label: "estimate, cache hit not guaranteed", expectedRequests: requests,
      enter: { uncachedTokens: estimate.uncachedTokens, usd: estimate.usd },
      extraOutput: { averageTokens: average, averageReasoningTokens: reasoning, reasoningIncludedInOutput: true,
        tokens: average === null ? null : round(average * requests),
        usd: average === null || !price ? null : round(average * requests * price.output / 1e6),
        basis: average === null ? THINKING_MEASURED : "session high-effort output (including reasoning); upper estimate, no off-output subtraction" },
      churn, requestsPotentiallySaved: "Not measured; consider whether deliberate reasoning avoids later failed attempts/requests." });
    return { skip: { label: "estimate, cache hit not guaranteed", expectedRequests: 0,
      enter: { uncachedTokens: 0, usd: 0 }, extraOutput: { tokens: 0, usd: 0 } },
      pulse: option(1), phase: option(phaseWindow()) };
  }

  async function effortEvidence(agent, trigger) {
    const id = agent.session.id, graph = graphFor(id), reason = trigger.reason;
    const evidence = { task: shortText(taskHeads.get(id), 800) };
    if (reason === "test_failure") {
      const key = trigger.testKey ?? failingTest(id)?.key;
      const runs = graph.tests[key]?.runs.filter(run => run.via === undefined) ?? [];
      const raw = failureOutput.get(id)?.get(key);
      const excerpt = raw === undefined ? "(no raw failure output captured)" : failureExcerpt(raw, { maxChars: 1500 });
      const focus = focusTerms({ failingTests: key ? [key] : [],
        errors: excerpt.match(/\b[A-Za-z_$][\w$]*(?:Error|Exception)\b/g) ?? [],
        symbols: [...(key?.match(/\btest_\w+|[\w./-]+\.(?:py|js|ts|go|rs)\b/g) ?? []),
          ...(excerpt.match(/[\w./-]+\.(?:py|js|ts|tsx|jsx|go|rs|java|c|cpp)\b/g) ?? [])] });
      const change = await workspaceDiff(workspaceOf(agent), { maxChars: 1500, focus });
      evidence.testKey = shortText(key, 400);
      evidence.failureExcerpt = shortText(excerpt, 1500);
      evidence.attempts = { count: runs.length, outcomes: runs.map(run => run.outcome),
        summary: shortText(attemptsFrom(graph, key), 1000) };
      evidence.change = shortText(change.evidence ?? (change.error ? "Diff unavailable: " + change.error : change.diff), 1500);
    } else if (["review_report", "advisor_report"].includes(reason)) {
      evidence.report = shortText(effortReports.get(id)?.get(reason), 1500);
    } else if (reason === "stall") {
      evidence.stepsWithoutProgress = graphStep(id) - (effortStall.get(id)?.step ?? graphStep(id));
      evidence.tools = (effortTools.get(id) ?? []).slice(-6);
    } else evidence.request = shortText(turnHeads.get(id), 800);
    return evidence;
  }

  // Bound the entire serialized state (and question) in UTF-8 bytes, including JSON escaping. Preserve
  // the observed failure ahead of background/diff text when non-ASCII evidence needs more space.
  function boundEffortRequest(request) {
    const evidence = request.evidence;
    const fields = [[evidence, "task"], [evidence, "request"], [evidence, "change"],
      [evidence.attempts, "summary"], [evidence, "testKey"], [evidence, "report"], [evidence, "failureExcerpt"]];
    while (jsonBytes(request) > EFFORT_STATE_BYTES) {
      const field = fields.find(([object, key]) => typeof object?.[key] === "string" && object[key].length > 64);
      if (field) {
        const [object, key] = field;
        object[key] = object[key].slice(0, Math.max(64, Math.floor(object[key].length / 2)));
      } else if (evidence.tools?.length) evidence.tools.pop();
      else throw new Error("Effort state metadata exceeds byte budget");
    }
  }

  async function decisionPointEffort(agent, resolved, trigger, payload) {
    const id = agent.session.id, reason = trigger.reason;
    let estimate = { totalTokens: null, reusableTokens: null, uncachedTokens: null, usd: null },
      decision = "fallback", optionCosts = effortOptionCosts(id, resolved, estimate), evidenceBytes = 0, evidenceKey;
    try {
      estimate = effortEstimate(agent, resolved, payload);
      optionCosts = effortOptionCosts(id, resolved, estimate);
      if (estimate.postReplacement) decision = "post_replacement";
      else if (estimate.uncachedTokens !== null && estimate.uncachedTokens <= (config.effortSwitchFreeTokens ?? 4096))
        decision = "cheap";
      else if (budget(id).effortDecisions >= (config.maxEffortDecisions ?? 6)) decision = "fallback_budget";
      else {
        const evidence = await effortEvidence(agent, trigger);
        const request = { trigger: "effort_decision", reason, evidence,
          estimate: { ...estimate, label: "estimate, cache hit not guaranteed" }, optionCosts,
          preference: roots.get(id)?.policy?.weights,
          questions: { thinking: { type: "choice", criteria: EFFORT_CHOICES, instructions:
            "Choose the effort justified by this evidence. Quality comes first; skip is right for a mechanical fix. Weigh entry, output, churn and requests a phase may save." } } };
        boundEffortRequest(request);
        evidenceBytes = jsonBytes(evidence);
        evidenceKey = createHash("sha256").update(JSON.stringify([reason, evidence, progressKey(graphFor(id))])).digest("hex");
        const skipped = effortSkips.get(id)?.get(reason);
        if (skipped === evidenceKey) decision = "skip";
        else {
          if (!config.apiKey) throw new Error("Effort decision unavailable");
          const timeout = AbortSignal.timeout(15000);
          const signal = payload.signal ? AbortSignal.any([payload.signal, timeout]) : timeout;
          decision = (await decide(agent, request, signal, { unbudgeted: true })).answers.thinking.choice;
          if (decision === "skip") {
            if (!effortSkips.has(id)) effortSkips.set(id, new Map());
            effortSkips.get(id).set(reason, evidenceKey);
          }
        }
      }
    } catch (error) {
      if (payload.signal?.aborted) throw error;
      decision = error.code === "EFFORT_BUDGET" ? "fallback_budget" : "fallback";
    }
    record({ kind: "effort_decision", session: id, reason, decision, ...estimate,
      optionCosts, evidenceBytes, ...(evidenceKey ? { evidenceHash: evidenceKey } : {}) });
    return decision;
  }

  // The root's sticky effort through dsh's request-config waterfall on the agent's own scoped context, as
  // dsh's native model selection does. Same-model children inherit it, so a forked branch stays in the
  // parent's cache space. A user-configured effort on the agent always wins.
  function installEffort(agent) {
    const id = agent.session.id;
    if (effortInstalled.has(id) || !agent.ctx || !config.adaptiveEffort || config.adaptiveEffort === "off") return;
    effortInstalled.add(id);
    // Prepended so it runs outermost: dsh's model selection drops any effort an inner listener sets.
    agent.ctx.on("agent/request", async (payload, next) => {
      const resolved = await next();
      if (agent.options?.reasoningEffort !== undefined) return resolved;
      // An effort that is not the one this listener last set is the user's model selection (dsh passes
      // it through next()); it is kept as is.
      if (resolved.reasoningEffort !== undefined && resolved.reasoningEffort !== effortSet.get(id)) {
        if (!userEffort.has(id)) record({ kind: "effort_user", session: id, effort: resolved.reasoningEffort });
        userEffort.add(id);
        return resolved;
      }
      const root = rootOf(agent);
      let effort;
      if (id === root) {
        const requestNumber = (effortRequests.get(id) ?? 0) + 1;
        effortRequests.set(id, requestNumber);
        checkCacheGeneration(agent);
        const plan = effortSupported.get(root) === true ? turnPlans.get(root) : undefined;
        if (effortPhases.has(id) && plan?.thinking !== "decision_points") endEffortPhase(id, "policy_changed");
        if (plan?.thinking === "always") {
          effort = plan.effort;
          if (effort !== undefined)
            record({ kind: "effort_raised", session: id, effort, reason: "always", step: payload.step });
        }
        else if (plan?.thinking === "decision_points") {
          let phase = effortPhases.get(id);
          if (phase && requestNumber > phase.until) {
            endEffortPhase(id, "request_limit");
            phase = undefined;
          }
          const trigger = effortDue.get(id);
          let decision;
          if (!phase && trigger) {
            decision = await decisionPointEffort(agent, resolved, trigger, payload);
            if (decision === "phase") {
              phase = { reason: trigger.reason, requests: 0, triggers: new Map(),
                until: requestNumber + phaseWindow() - 1 };
              phase.triggers.set(trigger.reason + "|" + (trigger.testKey ?? ""), trigger);
              effortPhases.set(id, phase);
            }
            effortDue.delete(id);
          }
          if (phase) {
            effort = config.adaptiveEffort;
            phase.requests++;
            record({ kind: "effort_raised", session: id, effort, reason: phase.reason, step: payload.step, phase: true });
          } else if (decision === "skip") {
            // A skip leaves the currently selected space intact, even if the previous pulse was high.
            effort = effortSet.get(id) ?? resolved.reasoningEffort;
            if (effort === config.adaptiveEffort)
              record({ kind: "effort_raised", session: id, effort, reason: trigger.reason, step: payload.step });
          } else if (decision !== undefined) {
            effort = config.adaptiveEffort;
            const pulses = effortPulses.get(id) ?? { count: 0, reasons: {}, rePulsedWithin3: 0 };
            if (pulses.lastRequest !== undefined && requestNumber - pulses.lastRequest <= 3) pulses.rePulsedWithin3++;
            pulses.count++;
            pulses.lastRequest = requestNumber;
            pulses.reasons[trigger.reason] = (pulses.reasons[trigger.reason] ?? 0) + 1;
            effortPulses.set(id, pulses);
            record({ kind: "effort_raised", session: id, effort, reason: trigger.reason, step: payload.step });
          }
        }
      } else {
        // A same-model child keeps the effort its branch started with (only an always-thinking parent
        // passes one on): a later parent checkpoint does not rewrite a running child's cache identity.
        if (!childEffort.has(id))
          childEffort.set(id, effortSupported.get(root) === true && resolved.model === currentModel(ctx.agents.get(root))
            ? turnPlans.get(root)?.effort : undefined);
        effort = childEffort.get(id);
      }
      effortSet.set(id, effort);
      if (effort === resolved.reasoningEffort) return resolved;
      if (effort !== undefined) return { ...resolved, reasoningEffort: effort };
      const { reasoningEffort: _dropped, ...withoutEffort } = resolved;
      return withoutEffort;
    }, { prepend: true });
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

  // Explicit ids are honored only when native preparation accepted them. "auto" asks Jev once per role per
  // root task over every routed model that fits the brief, with priors, measured records and this
  // workspace's experience; without an answer, the best effective weight wins, then the cheaper brief.
  async function chooseModel(role, agent, reason, signal) {
    const root = rootOf(agent),
      setting = role === "reviewer" ? config.reviewerModel : config.advisorModel;
    const available = await ensureAvailable(agent, signal);
    const found = (id) => available.find((entry) => entry.id === id);
    let tag = turnPlans.get(root)?.tag;
    const ledger = await readLedger(workspaceOf(agent));
    const weight = (model) => effective(ledger, weightKey(tag ?? "general", model, role));
    const finish = (model, via, detail = {}) => {
      if (model && setting === "auto") chosenModels.set(root + "\u0000" + role, { id: model.id, tag, version: ledger.version });
      record({
        kind: "model_choice",
        session: root,
        role,
        tag: tag ?? null,
        ...(model ? { model: model.id } : {}),
        via,
        ...detail,
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
    // Reused only while the task tag and the workspace ledger are unchanged.
    const memo = chosenModels.get(root + "\u0000" + role);
    if (setting === "auto" && memo && memo.tag === tag && memo.version === ledger.version && found(memo.id))
      return found(memo.id);
    // Hard capability only: the brief must fit the context window. Route availability was checked natively.
    const briefTokens = ctx.tokenMeter.estimateMessage(note(tasks.get(root) ?? "")) + 4000;
    const filtered = [...(filteredByRoot.get(root) ?? [])],
      fitting = [];
    for (const entry of available)
      if (Number.isFinite(entry.context) && entry.context < 2 * briefTokens)
        filtered.push({ model: entry.id, reason: "context window " + entry.context + " is below twice the brief" });
      else fitting.push(entry);
    const policy = routePolicy(fitting, (entry) => providerOf(agent, entry.id),
      { preferred: config.preferredProviders, allowed: config.allowedProviders });
    for (const entry of policy.dropped)
      filtered.push({ model: entry.id, reason: "a preferred or allowed provider model fits this role (preferredProviders/allowedProviders)" });
    if (policy.dropped.length)
      record({ kind: "route_policy", session: root, role, dropped: policy.dropped.map((entry) => entry.id) });
    const candidates = policy.kept;
    const rowsNow = () => candidates.map((entry) => ({ model: entry.id, ...weight(entry.id) }));
    const rows = rowsNow();
    const fallback = () =>
      pickModel(role, { available: policy.preferredOnly.length ? policy.preferredOnly : candidates, weightOf: (id) => weight(id).weight });
    if (setting === "auto" && candidates.length && budget(root).decisions < config.maxDecisions) {
      const routeNote = (entry) => (config.preferredProviders ?? []).length
        ? "\nroute: " + providerOf(agent, entry.id) + (policy.isPreferred(entry) ? " (preferred)" : " (valid alternative)") : "";
      const criteria = Object.fromEntries(candidates.map((entry) => [entry.id, knowledge([entry]) + routeNote(entry)]));
      const models = modelKnowledge.get(root);
      const request = {
        ...(models ? { models } : {}),
        experience: {
          note: "Workspace weights for the " + role + " role by task tag, learned from finished tasks (no row means no evidence; user-set weights are explicit preferences). Use the rows of this task's tag.",
          rows: Object.keys(ledger.weights)
            .map(parseKey)
            .filter((key) => key.role === role && candidates.some((entry) => entry.id === key.model))
            .map((key) => ({ tag: key.tag, ...experienceRows(ledger, [weightKey(key.tag, key.model, role)])[0] }))
            .map(({ key: _key, role: _role, ...row }) => row),
        },
        preference: roots.get(root)?.policy?.weights,
        executor: agent.options?.model,
        task: tasks.get(root),
        ledger: digest(rootGraph(agent), 1500),
        trigger: role + ": " + reason,
        questions: {
          ...(tag === undefined ? { task_tag: TAG_QUESTION } : {}),
          model: {
            type: "choice",
            instructions:
              "Which model should act as " + role + " now? Prefer measured records and workspace experience over priors; weigh the expected quality of its " + role + " work first, then total cost (its price for this brief) and time under the user's preference. The executor's own model is a candidate; family relation to it is information, not a rule.",
            criteria,
          },
        },
      };
      try {
        if (Buffer.byteLength(JSON.stringify(request)) <= STATE_BYTES) {
          const decision = await decide(agent, request, signal);
          if (tag === undefined) {
            tag = decision.answers.task_tag.choice;
            turnPlans.set(root, { ...turnPlans.get(root), tag, via: turnPlans.get(root)?.via ?? "choice" });
          }
          const answer = decision.answers?.model;
          const chosen = criteria[answer?.choice] ? found(answer.choice) : undefined;
          const detail = {
            confidence: answer?.confidence,
            candidates: rowsNow().map((row) => ({ ...row, probability: answer?.probabilities?.[row.model] })),
            filtered,
          };
          if (chosen && answer.confidence >= 0.4) return finish(chosen, "jev", detail);
          return finish(fallback(), "fallback", { ...detail, reasonFallback: "low confidence" });
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return finish(fallback(), "fallback", { candidates: rows, filtered });
  }

  async function independentReview(agent, turn, signal) {
    const id = agent.session.id,
      start = turnStartSteps.get(id),
      changed =
        changedTurn.get(id) === turn ||
        (start?.turn === turn && Object.values(graphFor(id).files).some((file) =>
          file.edits.some((edit) => edit.via === undefined && edit.step > start.step)));
    if (reviewedTurn.get(id) === turn || !changed) return false;
    if (!rootHasChildSlot(id)) return false;
    // Marked before starting, so a failed review never repeats within the turn.
    reviewedTurn.set(id, turn);
    const custom = config.reviewerModel !== undefined && config.reviewerModel !== "same";
    const chosen = custom ? await chooseModel("reviewer", agent, "independent review", signal) : undefined;
    const executor = modelInfo(currentModel(agent))?.id ?? currentModel(agent);
    // The executor's own model reviews through a fork whatever setting picked it.
    const cross = !!chosen && chosen.id !== executor;
    const provider = !cross && ctx.subagents.getProvider("fork") !== undefined ? "fork" : "spawn";
    // The host fork seeds only completed turns (host gap: no mid-turn seed), so inside the first turn a
    // fork starts without the parent's history and the brief must carry the ledger like a spawn.
    const seeded = provider === "fork" && agent.session.snapshotEvents().some((event) => event.type === "turn/end");
    const model = chosen?.id ?? executor;
    let run;
    record({
      kind: "review_start",
      session: id,
      turn,
      model: cross ? model : "same",
      provider,
      historySeeded: seeded,
    });
    try {
      signal.throwIfAborted();
      // Even a seeded fork lacks the current turn (the host seeds completed turns only), so the brief
      // always carries the evidence ledger; it is appended after the inherited prefix.
      // The reviewer starts from the actual change and its surrounding code instead of rediscovering them.
      const cwd = workspaceOf(agent),
        change = await workspaceDiff(cwd);
      signal.throwIfAborted();
      const prompt = reviewBrief({
        prompt: REVIEW_PROMPT,
        task: tasks.get(id),
        diff: change.diff || "(no diff available" + (change.error ? ": " + change.error : "") + ")",
        context: change.diff ? await hunkContext(cwd, change.diff) : "",
        ledger: digest(rootGraph(agent), 3000),
      });
      record({ kind: "brief", session: id, role: "reviewer", chars: prompt.length, diffChars: change.diff.length,
        files: change.files.length, ...(change.error ? { error: change.error } : {}) });
      reviewPending.add(id);
      run = await startChild(provider, {
        label: "Independent review",
        parent: agent,
        prompt: [{ type: "text", text: prompt }],
        // A fork keeps the parent's tool block; the guard enforces the reviewer's limits instead.
        ...(provider === "fork"
          ? {}
          : {
              ...(cross ? { agentOptions: { provider: providerOf(agent, model), model } } : {}),
              toolFilter: { deny: ["subagent", "subagent_fork"] },
            }),
        maxDepth: 1,
        signal,
      });
      reviewPending.delete(id);
      reviewChildren.add(run.id);
      roleUse(id, "reviewer", model).children++;
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
      const lgtm = /^[\W_]*LGTM\b/i.test(report);
      record({
        kind: "review_end",
        session: id,
        turn,
        childId: run.id,
        model: cross ? model : "same",
        stopReason: outcome.stopReason,
        lgtm,
      });
      const use = roleUse(id, "reviewer", model);
      use.completed++;
      use.reports.push({ verdict: lgtm ? "LGTM" : "DEFECTS", at: graphFor(id).sequence, text: report.slice(0, 300) });
      // LGTM ends the turn as is: steering the report back reopened it, and flash executors chased
      // the reviewer's caveats until the request cap.
      if (!lgtm) {
        if (!effortReports.has(id)) effortReports.set(id, new Map());
        const received = (settled.get(run.id)?.lastAssistantMessage ?? [])
          .filter(block => block.type === "text").map(block => block.text).join("\n");
        effortReports.get(id).set("review_report", shortText(received || report, 1500));
        agent.steer(note(reviewMessage(report)));
        wantEffort(agent, "review_report");
        return true;
      }
    } catch (error) {
      signal.throwIfAborted();
      record({ kind: "review_failed", session: id, turn, childId: run?.id, error: String(error) });
      return false;
    } finally {
      if (!run) reviewPending.delete(id);
      if (run) reviewChildren.delete(run.id);
    }
  }

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    const saved = persistGraph(agent.session.id);
    try {
      if (agent.session.header.parentSession !== undefined) return;
      if (config.mode === "plan") {
        await planDispatcher.settleLearning(agent).catch((error) =>
          record({ kind: "route_learning_failed", session: agent.session.id, error: String(error) }));
        return;
      }
      // Auto and native share the reviewer; single mode and keyless runs stay native-only.
      const steered =
        config.reviewBeforeFinish && config.apiKey && modeOf(agent) !== "single"
          ? await independentReview(agent, turn, signal)
          : false;
      // A turn that is really ending settles its learning here, awaited and bounded, so a headless run
      // does not exit before the ledger is written; `turn/end` remains the fallback.
      if (!steered && modeOf(agent) === "auto")
        await settleTurn(agent.session, turn).catch((error) =>
          record({ kind: "learning_failed", session: agent.session.id, error: String(error) }));
      if (!steered) endEffortPhase(agent.session.id, "turn_end");
    } finally {
      await saved;
    }
  });

  async function routeDelegation(args, exec, provider) {
    const parent = exec.agent,
      state = roots.get(parent.session.id),
      resources = budget(parent.session.id);
    const listing = await listChildren(parent.session.id, exec.signal);
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
    // Workspace experience of delegated workers by model (rows exist only where evidence exists).
    const workspace = await readLedger(workspaceOf(parent));
    const workerRows = Object.keys(workspace.weights)
      .map(parseKey)
      .filter((key) => key.role === "worker" && state.profiles.some((profile) => profile.options.model === key.model))
      .map((key) => {
        const { weight, source, n, summary } = effective(workspace, weightKey(key.tag, key.model, "worker"));
        return { tag: key.tag, model: key.model, weight, source, n, ...(summary ? { summary } : {}) };
      });
    const request = {
      ...(models ? { models } : {}),
      ...(workerRows.length ? { experience: { note: "Workspace weights of delegated workers by task tag and model (learned from finished tasks).", rows: workerRows } } : {}),
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
          // No persona section or tool filter: the child keeps the parent's system prompt and tool block
          // (as a native child does); its role leads the first message and maxDepth 1 blocks nested delegation.
          role:
              "You are a delegated child, not the parent. Perform only your assigned investigation. The quoted root request is background; do not carry out its instructions for other agents. Do not delegate. " +
              selected.profile.label +
              ": " +
              selected.profile.capability,
          composition: {},
        });
        await persistedAssignments.put(id, assignments.get(id));
        const chosen =
          provider === "spawn" && ctx.subagents.getProvider("fork") !== undefined
            ? "fork"
            : provider;
        childLabels.set(id, args.description);
        const activation = await startChild(chosen, {
          label: args.description,
          parent,
          prompt: [
            {
              type: "text",
              text:
                assignments.get(id).role + "\n\n" +
                task +
                "\n\nInvestigate only the assigned responsibility. Return concrete findings and evidence within the child budget. Leave code edits and test fixes to the parent.",
            },
          ],
          agentOptions: selected.profile.options,
          ...assignments.get(id).composition,
          maxDepth: 1,
          signal: exec.signal,
        }, { childId: id, continuable: true });
        // The old receipt has no result; the new activation can reject on an
        // infrastructure failure even though worker collection uses events.
        activation.result?.catch((error) =>
          record({ kind: "child_activation_failed", parent: parent.session.id, id, error: String(error) }));
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
    if (config.mode === "plan") {
      const dependency = agent && await planDispatcher.mainDependency(exec);
      if (dependency) return dependency;
      await planDispatcher.beforeEdit(exec);
      return next();
    }
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
          // 0.2.1 validates wrapper-authored values against an activation-only
          // tool output schema. Keep the internal routing/collection contract.
          const activationOutput = ctx.tools.get(exec.name, agent).output?.schema?.properties?.kind?.const === "activation";
          return { isError: false, value: activationOutput ? { kind: "activation", subagentId: value.subagentId } : value, content };
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
      const selection = config.mode === "plan" ? undefined : prepared.get(agent.session.id);
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
      // The advisor has no tools: the question, the raw failure, the change and the code around it are
      // its evidence; the task and the ledger are background.
      const graph = rootGraph(agent),
        cwd = workspaceOf(agent),
        test = trigger.startsWith("repeated failure: ") ? trigger.slice("repeated failure: ".length) : undefined,
        runs = test ? (graph.tests[test]?.runs ?? []).filter((run) => run.via === undefined) : [],
        change = await workspaceDiff(cwd);
      signal.throwIfAborted();
      const symbols = [...change.diff.matchAll(/^@@[^@]*@@\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
      const raw = test ? failureOutput.get(id)?.get(test) : undefined;
      const prompt = advisorBrief({
        prompt: ADVISOR_PROMPT,
        question: adviceQuestion(trigger, { test, attempts: test ? Math.max(0, runs.length - 1) : undefined }),
        failure: raw
          ? failureExcerpt(raw, { focus: symbols })
          : test ? (runs.at(-1)?.summary ?? "(no output captured)") : "(no failing run; trigger: " + trigger + ")",
        diff: change.diff || "(no diff available" + (change.error ? ": " + change.error : "") + ")",
        context: change.diff ? await hunkContext(cwd, change.diff) : "",
        attempts: test ? attemptsFrom(graph, test) : "",
        task: tasks.get(id),
        ledger: digest(graph, 3000),
      });
      record({ kind: "brief", session: id, role: "advisor", chars: prompt.length, diffChars: change.diff.length,
        files: change.files.length, failureChars: raw?.length ?? 0, ...(change.error ? { error: change.error } : {}) });
      advisorPending.add(id);
      run = await startChild("spawn", {
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
      roleUse(id, "advisor", model.id).children++;
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
      if (!effortReports.has(id)) effortReports.set(id, new Map());
      const received = (settled.get(run.id)?.lastAssistantMessage ?? [])
        .filter(block => block.type === "text").map(block => block.text).join("\n");
      effortReports.get(id).set("advisor_report", shortText(received || reply, 1500));
      record({ kind: "advisor_end", session: id, model: model.id, chars: reply.length });
      const use = roleUse(id, "advisor", model.id);
      use.completed++;
      use.reports.push({ trigger, at: graphFor(id).sequence, text: reply.slice(0, 300) });
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
  function appendNotes(agent, admitted, { advisor, finalRequest, staleNotes = [] }) {
    const id = agent.session.id;
    const extra = staleNotes.map(note);
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
    if (config.mode === "plan") {
      installPlanTool();
      if (!isChild && !planSnapshots.has(id)) {
        planSnapshots.add(id);
        record({ kind: "policy_snapshot", session: id, mode: "plan", routing: config.planRouting ?? "jev" });
      }
      if (isChild) {
        const used = planDispatcher.childRequests(id), cap = config.planChildRequests ?? 16;
        if (used >= cap) throw new Error("Plan child request budget exhausted.");
        finalRequest = used === cap - 1;
      } else {
        await planDispatcher.startReady(agent, signal);
      }
      if (!finalRequest && agent.session.requestHeader() !== undefined) {
        try { await getCompactor().compactIfNeeded(agent, "pressure", signal); }
        catch (error) {
          if (signal.aborted) throw error;
          record({ kind: "context_unshrinkable", session: id, error: String(error) });
        }
      }
      if (isChild) {
        const used = planDispatcher.childRequests(id), cap = config.planChildRequests ?? 16;
        if (used >= cap) throw new Error("Plan child request budget exhausted.");
        finalRequest = used === cap - 1;
      }
      const admitted = await next();
      if (admitted.kind === "reject") return admitted;
      graphSteps.set(id, graphStep(id) + 1);
      const state = !isChild && planDispatcher.stateFor(agent);
      const message = isChild && finalRequest ? dispatcherLabel + " This is your final model request under the plan child budget. Report the actual result and unfinished work through structured_output now." :
        state && !state.planned && !state.prompted ? dispatcherLabel + " Call plan before the first file-changing tool. Read-only tools may run first." : undefined;
      if (!message) return admitted;
      if (state) state.prompted = true;
      record({ kind: "message_appended", to: id, from: rootOf(agent), messageKind: finalRequest ? "budget" : "plan-reminder",
        label: true, sourceLabel: dispatcherLabel, chars: message.length });
      return { ...admitted, messages: [...(admitted.messages ?? []), note(message)] };
    }
    const newTurn = !isChild && turnStartSteps.get(id)?.turn !== payload.turn;
    if (newTurn) {
      endEffortPhase(id, "turn_end");
      turnStartSteps.set(id, { turn: payload.turn, step: graphStep(id) });
      effortPulses.delete(id);
      effortSkips.delete(id);
      effortRequests.delete(id);
      effortDue.delete(id);
      if (turnUses.get(id)?.turn !== payload.turn) turnUses.set(id, newUse(payload.turn));
    }
    const reopened = !isChild && turnUses.get(id);
    if (reopened?.settled && reopened.turn === payload.turn) {
      reopened.settled = false;
      reopened.generation = (reopened.generation ?? 0) + 1;
      record({ kind: "turn_reopened", session: id, turn: payload.turn });
    }
    installEffort(agent);
    if (!isChild) {
      // Several steps without new evidence are a decision point too.
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
    const staleNotes = [];
    for (const message of messages)
      if (message.source.kind === "subagent-settled") {
        const child = message.source.senderSessionId;
        recordCollection(id, child, settled.get(child));
        // The child's evidence stays attributed to its label in the parent graph. Its reads of files the
        // parent edited after the child started are stale and are not merged.
        await restoreGraph(child);
        const started = childStarts.get(child);
        const editedSince = new Set(
          editLog(id).slice(started?.edits ?? 0).filter((edit) => edit.session === id).map((edit) => edit.path));
        // Test runs the child made before those edits ran against older code; they are not merged either.
        merge(graphFor(id), graphFor(child), childLabels.get(child) ?? child,
          { skipReadsOf: editedSince, skipTests: editedSince.size > 0 });
        const users = userMessages(agent) + messages.filter((message) => message.source.kind === "user").length;
        if (started && (editedSince.size || users > started.users)) {
          staleNotes.push(staleMessage(childLabels.get(child) ?? child, [...editedSince], users > started.users));
          record({ kind: "stale_child_result", session: id, child, paths: [...editedSince], newUserMessage: users > started.users });
        }
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
    if (!isChild && (!taskHeads.has(id) || newTurn)) {
      const previous = agent.session.snapshotEvents()
        .filter(event => event.type === "user/message")
        .map(event => agent.session.deriveEventMessage(event))
        .filter(message => message?.source.kind === "user");
      const pending = messages.filter(message => message.source.kind === "user");
      const first = previous[0] ?? pending[0], current = pending.at(-1) ?? previous.at(-1);
      if (first && !taskHeads.has(id)) taskHeads.set(id, shortText(text(first), 800));
      if (current && newTurn) turnHeads.set(id, shortText(text(current), 800));
    }
    if (
      !isChild &&
      (!roots.has(id) || roots.get(id).configuredMode !== (config.apiKey ? config.mode : "native"))
    ) {
      if (config.mode !== "single") {
        const children = await listChildren(id, signal),
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
    if (newTurn && modeOf(agent) === "auto") await planTurn(agent, signal);
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
    const withNotes = appendNotes(agent, admitted, { advisor, finalRequest, staleNotes });
    if (!isChild) admittedMessages.set(id, withNotes.messages ?? []);
    return withNotes;
  });
  ctx.on("llm/stream", async function* (options, next) {
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
    if (agent && config.mode === "plan" && agent.session.header.parentSession !== undefined) {
      if (planDispatcher.childRequests(agent.session.id) >= (config.planChildRequests ?? 16))
        throw new Error("Plan child model-call budget exhausted, including compaction calls.");
      planDispatcher.countRequest(agent.session.id);
    } else if (agent && agent.session.header.parentSession !== undefined) {
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
    let usage, cacheFingerprint, prefixReuse;
    const rootExecution = agent && agent.session.header.parentSession === undefined && options.purpose === undefined;
    const fingerprintFailed = () => {
      const cache = cacheSpaces.get(agent.session.id);
      // The last successfully fingerprinted request may no longer describe the current prefix.
      cache.latest = undefined;
      if (!cache.failed) {
        cache.failed = true;
        record({ kind: "cache_fingerprint_failed", session: agent.session.id });
      }
    };
    if (rootExecution || (agent && config.mode === "plan" && options.purpose === undefined)) {
      // The host has now committed these messages. Retries derive them from the surface itself.
      admittedMessages.delete(agent.session.id);
      checkCacheGeneration(agent);
      if (!cacheSpaces.has(agent.session.id))
        cacheSpaces.set(agent.session.id, { spaces: new Map(), latest: undefined, failed: false });
      try {
        cacheFingerprint = fingerprint(options, (message) => ctx.tokenMeter.estimateMessage(message));
        const previous = cacheSpaces.get(agent.session.id).spaces.get(cacheFingerprint.space);
        prefixReuse = { space: cacheFingerprint.space,
          sharedMessages: sharedPrefix(previous?.fingerprint, cacheFingerprint),
          estReusedTokens: reusableTokens(previous?.fingerprint, cacheFingerprint, {
            now: Date.now(), at: previous?.at, ttlMs: (config.cacheTtlSeconds ?? 300) * 1000,
          }) };
      } catch {
        cacheFingerprint = undefined;
        fingerprintFailed();
      }
    }
    const dispatchEstimate = agent ? ctx.tokenMeter.measure(agent.session).totalTokens : undefined;
    if (agent) updateStats(rootOf(agent), { nativeEstimate: dispatchEstimate });
    try {
      for await (const chunk of next()) {
        if (chunk.type === "usage") usage = chunk.usage;
        yield chunk;
      }
      if (cacheFingerprint) {
        try {
          const cache = cacheSpaces.get(agent.session.id);
          cache.latest = cacheFingerprint;
          delete cache.invalidated;
          cache.generation = agent.session.surface?.contentGeneration;
          cache.spaces.delete(cacheFingerprint.space);
          cache.spaces.set(cacheFingerprint.space, { fingerprint: cacheFingerprint, at: Date.now() });
          if (cache.spaces.size > 4) cache.spaces.delete(cache.spaces.keys().next().value);
        } catch {
          fingerprintFailed();
        }
      }
    } finally {
      const wallMs = performance.now() - started;
      const spent = agent ? account(agent, options, usage, wallMs) : undefined;
      if (rootExecution && options.reasoningEffort === config.adaptiveEffort && Number.isFinite(usage?.outputTokens)) {
        const id = agent.session.id, route = `${options.provider}|${options.model}`;
        if (!effortOutputs.has(id)) effortOutputs.set(id, new Map());
        const sample = effortOutputs.get(id).get(route) ?? { calls: 0, outputTokens: 0, reasoningTokens: 0, reasoningCalls: 0 };
        sample.calls++;
        sample.outputTokens += usage.outputTokens;
        if (Number.isFinite(usage.reasoningTokens)) {
          sample.reasoningTokens += usage.reasoningTokens;
          sample.reasoningCalls++;
        }
        effortOutputs.get(id).set(route, sample);
      }
      if (agent && options.purpose === undefined && usage) lastCached.set(agent.session.id, usage.cacheReadTokens ?? 0);
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
        wallMs,
        ...(spent ?? {}),
        ...(usage === undefined ? {} : { usage }),
        ...(prefixReuse === undefined ? {} : { prefixReuse }),
      });
    }
  });
  ctx.on("session/event", (session, event) => {
    if (config.mode === "plan") {
      planDispatcher.onEvent(session, event);
      return;
    }
    if (event.type === "compaction/summary") {
      pressureAnchors.delete(session.id);
      pendingLedgers.add(session.id);
    }
    if (session.header.parentSession !== undefined) return;
    if (event.type === "compaction/summary" || event.type === "compaction/prune" ||
        event.type === "image/offload" || event.surfaceOp?.op === "replace")
      invalidateCache(session.id, event.surfaceOp?.op === "replace" ? "surface_replaced" : event.type);
    if (event.type === "turn/end") {
      endEffortPhase(session.id, "turn_end");
      effortDue.delete(session.id);
    }
    // Learning settles once per completed root turn, outside the turn: it never delays the user.
    if (event.type === "turn/end" && event.data?.reason?.kind === "completed")
      settleTurn(session, event.data.turn).catch((error) =>
        record({ kind: "learning_failed", session: session.id, error: String(error) }));
    feedbackEvent(session, event);
  });
  // Feedback on a session that is not loaded is committed to its log and announced here instead.
  ctx.on("feedback/committed", (inspection) => {
    if (config.mode === "plan") return;
    const event = inspection?.events?.at(-1);
    if (!event || inspection.meta?.parentSession !== undefined) return;
    const events = inspection.events;
    feedbackEvent({ id: inspection.meta.id, header: inspection.meta, snapshotEvents: () => events }, event);
  });
  function feedbackEvent(session, event) {
    const failed = (error) => record({ kind: "learning_failed", session: session.id, error: String(error) });
    if (event.type === "feedback/message-put") settleFeedback(session, event.data.item).catch(failed);
    // Deleted feedback leaves the pending card; values already applied stay (and remain revertible).
    if (event.type === "feedback/message-delete")
      updateLedger(session.header.cwd ?? "", (ledger) => withdraw(ledger, "feedback:" + event.data.messageId + ":", Date.now()))
        .then(() => record({ kind: "feedback_withdrawn", session: session.id, messageId: event.data.messageId }))
        .catch(failed);
  }

  // Observed facts only: the latest outcome per test, edits after a report, cost, time and cache.
  const testState = (graph) => {
    const latest = Object.values(graph.tests).map((test) => test.runs.at(-1)?.outcome);
    return { passing: latest.filter((x) => x === "pass").length, failing: latest.filter((x) => x === "fail" || x === "error").length };
  };

  async function settleTurn(session, turn) {
    const id = session.id,
      use = turnUses.get(id);
    if (!use || use.turn !== turn || use.settled) return;
    use.settled = true;
    // A turn reopened after an earlier settlement (a late child result or user steer) settles only what
    // happened since, as a new piece of evidence.
    const base = use.baseline ?? {},
      part = use.generation ?? 0;
    use.baseline = structuredClone(Object.fromEntries(Object.entries(use.roles).map(([key, entry]) =>
      [key, { ...entry, reports: entry.reports.length }])));
    const plan = turnPlans.get(id),
      graph = graphFor(id);
    const tag = plan?.tag,
      need = needOf(roots.get(id)?.policy?.weights),
      tests = testState(graph);
    const since = (key, entry, field) => entry[field] - (base[key]?.[field] ?? 0);
    const facts = Object.entries(use.roles)
      .filter(([key, entry]) => LEARNED_ROLES.has(entry.role) && since(key, entry, "children") > 0)
      // Each report is split into its specific claims, each paired with the later facts it names.
      .map(([key, entry]) => contributionFacts({
        role: entry.role,
        model: entry.model,
        ...Object.fromEntries(["children", "completed", "calls", "usd", "ms", "input", "cacheRead"]
          .map((field) => [field, since(key, entry, field)])),
        reports: entry.reports.slice(base[key]?.reports ?? 0).map((report) => ({ ...report, text: report.text ?? "" })),
      }, graph));
    const executor = Object.values(use.roles).find((entry) => entry.role === "executor");
    const summary = {
      turn,
      tag: tag ?? null,
      need,
      effort: plan?.effort ?? null,
      tests,
      seconds: round((Date.now() - use.startedAt) / 1000, 1),
      cost: Object.fromEntries(Object.entries(use.cost).map(([key, value]) => [key, round(value)])),
      totalUSD: round(Object.values(use.cost).reduce((sum, value) => sum + value, 0)),
      unpriced: use.unpriced,
      ...(executor
        ? { executor: { model: executor.model, calls: executor.calls, cacheHit: executor.input ? round(executor.cacheRead / executor.input, 3) : null } }
        : {}),
      roles: facts,
    };
    // Feedback on any answer of this turn reaches every part, so a reopened turn accumulates its roles.
    const previous = part ? (await storage()).table("uses").get(useKey(id, turn)) : undefined;
    await (await storage()).table("uses").put(useKey(id, turn),
      previous ? { ...summary, roles: [...(previous.roles ?? []), ...facts], parts: part + 1 } : summary);
    record({ kind: "turn_use", session: id, part, ...summary });
    if (facts.length)
      await learn(session, facts, { tag, need, tests, totalUSD: summary.totalUSD }, "turn:" + id + ":" + turn + (part ? ":" + part : ""));
  }

  // Native message feedback on a root answer becomes evidence for the roles that turn used.
  async function settleFeedback(session, item) {
    if (!item?.messageId) return;
    const event = session
      .snapshotEvents()
      .find((x) => x.type === "assistant/message" && x.data?.message?.id === item.messageId);
    if (!event) return;
    const saved = (await storage()).table("uses").get(useKey(session.id, event.data.turn));
    const feedback = { rating: item.rating, ...(item.category ? { category: item.category } : {}), ...(item.note ? { note: String(item.note).slice(0, 300) } : {}) };
    record({ kind: "feedback_evidence", session: session.id, turn: event.data.turn, ...feedback, roles: saved?.roles?.length ?? 0 });
    if (!saved?.roles?.length) return;
    await learn(session, saved.roles, { tag: saved.tag ?? undefined, need: saved.need, tests: saved.tests, totalUSD: saved.totalUSD, feedback },
      "feedback:" + item.messageId + ":" + item.version);
  }

  // Jev proposes one weight per (tag, model, role) the turn actually used; the ledger applies, queues or
  // records it by mode. Unused candidates get no proposal, so not being chosen never lowers a weight.
  async function learn(session, facts, context, evidenceId) {
    // A cold session (feedback after it was closed) has no live agent; Jev is asked on its behalf.
    const id = session.id,
      cwd = session.header.cwd ?? "",
      agent = ctx.agents.get(id) ?? { session };
    const ledger = await readLedger(cwd);
    if (ledger.mode === "frozen" || !agent || !config.apiKey || jevDown.has(id)) {
      record({ kind: "learning", session: id, mode: ledger.mode, tag: context.tag ?? null,
        evidence: facts.map((fact) => fact.role + "|" + fact.model), proposed: false,
        reason: ledger.mode === "frozen" ? "frozen" : "jev unavailable" });
      return;
    }
    const tagged = context.tag !== undefined;
    // Use records saved before claims were extracted carry no claims: nothing in them is judgeable.
    facts = facts.map((fact) => ({ ...fact, reports: (fact.reports ?? []).map((report) => ({ claims: [], unmatched: 0, ...report })) }));
    const questions = learningQuestions(facts, { tag: context.tag, need: context.need });
    // Without a tag yet, the current weights of every tag are shown and the tag is asked in the same call.
    const current = (fact) =>
      tagged
        ? effective(ledger, weightKey(context.tag, fact.model, fact.role))
        : Object.fromEntries(Object.keys(TASK_TAGS).map((tag) => [tag, effective(ledger, weightKey(tag, fact.model, fact.role)).weight]));
    const request = {
      trigger: "learning",
      task: (tasks.get(id) ?? "").slice(0, 2000),
      context,
      facts: facts.map((fact) => ({ ...fact, current: current(fact) })),
      questions: tagged ? questions : { task_tag: TAG_QUESTION, ...questions },
    };
    const answers = (await decide(agent, request, AbortSignal.timeout(20000), { unbudgeted: true })).answers;
    const tag = tagged ? context.tag : answers.task_tag.choice;
    context = { ...context, tag };
    // A contribution Jev cannot tie to observed facts is no observation: its weight and count stay.
    const { proposals, unassessable } = proposalsFrom(answers, facts, { tag, evidenceId, weightKey });
    if (!proposals.length) {
      record({ kind: "learning", session: id, tag, mode: ledger.mode, proposed: false, reason: "unassessable", unassessable });
      return;
    }
    const result = await updateLedger(cwd, (latest) => propose(latest, proposals, Date.now()));
    record({
      kind: "learning",
      session: id,
      tag,
      mode: result.ledger.mode,
      version: result.ledger.version,
      proposed: true,
      applied: result.applied.map((item) => ({ key: item.key, from: item.current, to: item.proposed })),
      pending: result.pending ? result.ledger.pending.version : null,
      skipped: result.skipped,
      unassessable,
    });
  }

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
    // Jev deferred the last replacement; ask again after 25% growth or at the ceiling.
    const deferredUntil = deferredSelection.get(id);
    if (deferredUntil !== undefined && pressure < deferredUntil && pressure < ceiling) return;
    deferredSelection.delete(id);
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
      end = nodes.length - 1;
    while (start <= end && !toolPairingBalancedBefore(agent.session, nodes[start])) start++;
    // Retain only as much tail as lets one replacement land near 60% of the pressure budget. With the
    // full retainTokens, head + tail + kept units sat just under pressure and two large tool results
    // forced the next replacement (6197: nine decisions in one task).
    const headTokens = measured.nodes.slice(0, start).reduce((sum, node) => sum + node.tokens, 0);
    const fit = Math.floor(
      (0.6 * config.pressureTokens - headTokens - config.keepRatio * (pressure - headTokens)) /
        (1 - config.keepRatio),
    );
    const baseRetain = Math.min(config.retainTokens, Math.max(2000, fit));
    let retainTokens = baseRetain;
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
    // A thinking change decided at this checkpoint applies only once the prefix was actually rebuilt.
    let checkpointEffort;
    const compactRegion = async (reason, regionEnd = fullEnd) => {
      signal.throwIfAborted();
      try {
        const result = await getCompactor().compactRegion(
          nodes[start],
          nodes[regionEnd],
          agent,
          signal,
        );
        if (agent.session.header.parentSession === undefined) invalidateCache(id, "context_replaced:" + reason);
        record({
          kind: "context_replaced",
          session: id,
          start: nodes[start],
          end: nodes[regionEnd],
          reason,
          sourceCount: result.shadowedSeqs.length,
        });
        if (checkpointEffort) {
          const plan = turnPlans.get(id) ?? { via: "checkpoint" };
          if (checkpointEffort.thinking !== plan.thinking)
            record({ kind: "effort_checkpoint", session: id, from: plan.thinking ?? null, to: checkpointEffort.thinking });
          turnPlans.set(id, { ...plan, ...checkpointEffort, via: "checkpoint" });
        }
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
    if (retainTokens < baseRetain) {
      await compactRegion("ceiling_reduced_retention");
      return;
    }
    if (config.contextSelection === "summary") {
      await compactRegion("summary");
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
    // One decision covers the whole region: Jev judges the largest units, where the savings are, and
    // the rest stay verbatim. Judging only the oldest batch freed 2-4K tokens per replacement, so
    // pressure returned within a few steps and every return cost another decision from the budget.
    // Candidates are evidence pieces (a test section, a diff hunk, a definition), not whole outputs, so a
    // decisive line in the middle of a long output reaches Jev. The open problem and what stays anyway are
    // in the state, because Jev judges each candidate on its own; duplicates and complements are local.
    const own = graphFor(id),
      failing = Object.entries(own.tests)
        .filter(([, test]) => ["fail", "error"].includes(test.runs.at(-1)?.outcome))
        .map(([key, test]) => ({ key, run: test.runs.at(-1) }));
    const rawFailures = failing.map(({ key }) => failureOutput.get(rootOf(agent))?.get(key) ?? "").join("\n");
    const focus = focusTerms({
      failingTests: failing.flatMap(({ key }) => key.match(/\btest_\w+|[\w./-]+\.py\b/g) ?? []),
      errors: [...new Set(rawFailures.match(/\b[A-Z]\w*(?:Error|Exception)\b/g) ?? [])].slice(0, 8),
    });
    const openQuestion = failing.length
      ? "Still failing: " + failing.slice(0, 3).map(({ key, run }) => key + (run.summary ? " (" + String(run.summary).slice(0, 160) + ")" : "")).join("; ")
      : undefined;
    const retained = {
      note: "Kept regardless of this selection: the instructions below, the context before this region, and observation.currentEvidence.",
      instructions: history.filter((unit) => unit.required).map((unit) => unit.text.slice(0, 400)).slice(-4),
    };
    const segments = segmentUnits(history, { focus });
    const unitText = (unit) => unit.kind + ":\n" + unit.text;
    const tokensOf = (piece) => ctx.tokenMeter.estimateMessage(note(piece.unitId === undefined ? unitText(piece) : piece.text));
    const sizes = new Map(segments.map((piece) => [piece.id, tokensOf(piece)]));
    const largestFirst = [...segments].sort((a, b) => sizes.get(b.id) - sizes.get(a.id));
    const batch = selectionBatch(tasks.get(id), largestFirst, observation, { openQuestion, retained, focus });
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
    const judgedIds = new Set(batch.history.map((unit) => unit.id));
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
    // Cost of replacing now versus later, from observed usage and catalog prices (estimates labeled).
    const regionTokensEstimate = measured.nodes.slice(start, end + 1).reduce((sum, node) => sum + node.tokens, 0);
    const price = modelInfo(agent.options?.model)?.price;
    const afterTokens = Math.round(pressure - regionTokensEstimate * (1 - config.keepRatio));
    const economics = price
      ? (() => {
          const read = price.cacheRead ?? price.input,
            delta = 2000;
          const perNow = ((pressure - delta) * read + delta * price.input) / 1e6,
            perAfter = ((afterTokens - delta) * read + delta * price.input) / 1e6,
            rebuild = ((afterTokens - headTokens) * (price.input - read)) / 1e6;
          return {
            basis: "estimate from catalog prices; assumes the head stays cached and everything after it is re-read uncached once",
            contextTokens: pressure,
            ...(lastCached.has(id) ? { lastCachedTokens: lastCached.get(id) } : {}),
            estimatedAfterTokens: afterTokens,
            ceilingTokens: ceiling,
            perRequestInputUSDNow: round(perNow, 5),
            perRequestInputUSDAfter: round(perAfter, 5),
            rebuildOnceUSD: round(rebuild, 5),
            breakEvenRequests: perNow > perAfter ? Math.ceil(rebuild / (perNow - perAfter)) : null,
            requestsSoFarThisTurn: Object.values(useOf(rootOf(agent)).roles).find((entry) => entry.role === "executor")?.calls ?? 0,
          };
        })()
      : { basis: "no catalog price for this model", contextTokens: pressure, estimatedAfterTokens: afterTokens, ceilingTokens: ceiling };
    const isRoot = agent.session.header.parentSession === undefined;
    const effortOn = isRoot && config.adaptiveEffort && config.adaptiveEffort !== "off" && effortSupported.get(id) === true;
    const extra = {
      ...(pressure < ceiling
        ? {
            replace_now: {
              type: "noul",
              instructions:
                "Should this context be replaced now rather than later? Replacing re-reads the kept context uncached once (economics.rebuildOnceUSD) and lowers the input cost of every later request (economics.perRequestInputUSDNow vs After; break-even after economics.breakEvenRequests requests). Deferring keeps the cache, but the context keeps growing until the ceiling forces a replacement. Weigh the expected remaining work and the quality effect of a long context against losing verbatim evidence, under the user's preference.",
            },
          }
        : {}),
      ...(effortOn
        ? {
            thinking: thinkingQuestion(
              "Which thinking policy should the executor follow after this checkpoint? The replacement re-reads the context anyway, so changing the policy now adds no cache rebuild. Quality of the result comes first; weigh `executorThinking.measured` and the extra output tokens and time under the user's preference.",
            ),
          }
        : {}),
    };
    let selection;
    try {
      const children = await listChildren(rootOf(agent), signal);
      const owners = Object.fromEntries(
        children
          .filter((x) => x.kind === "child" && x.id !== id)
          .map((x) => [x.id, "Existing child responsibility: " + x.label]),
      );
      selection = await scoreContext(
        (request) => decide(agent, request, signal),
        { ...batch, economics, preference: roots.get(rootOf(agent))?.policy?.weights,
          ...(effortOn ? { executorThinking: { now: turnPlans.get(id)?.thinking ?? "off", measured: THINKING_MEASURED } } : {}) },
        owners,
        extra,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      record({ kind: "context_decision_failed", session: id, error: String(error) });
      await compactRegion("decision_failed");
      return;
    }
    signal.throwIfAborted();
    if (selection.answers.replace_now && selection.answers.replace_now.noul < 0.5) {
      deferredSelection.set(id, Math.ceil(pressure * 1.25));
      record({ kind: "context_deferred", session: id, pressure, ceiling, replaceNow: selection.answers.replace_now.noul,
        recheckAt: deferredSelection.get(id), economics });
      return;
    }
    if (selection.answers.thinking)
      checkpointEffort = {
        thinking: selection.answers.thinking.choice,
        effort: selection.answers.thinking.choice === "always" ? config.adaptiveEffort : undefined,
      };
    const regionTokens = regionTokensEstimate;
    // Required pieces always stay; then Jev's necessary pieces, unjudged ones newest first, and the rest
    // by importance, each with the definition or report it needs, one copy of each duplicate.
    const plan = planSelection({
      segments,
      judgedIds: [...judgedIds],
      judgments: selection.judgments,
      keepBudget: config.keepRatio * regionTokens,
      tokensOf: (piece) => sizes.get(piece.id),
    });
    const rendered = renderSelection(history, segments, plan.keptIds, droppedUnitLine);
    const kept = new Set(plan.keptIds),
      dropped = rendered.dropped;
    const summary = rendered.blocks.map((text) => ({ type: "text", text }));
    if (dropped.length)
      summary.push({
        type: "text",
        text:
          "Archived units (already examined; listed for avoidance, content removed):\n" +
          dropped.join("\n"),
      });
    const replacementTokens =
      ctx.tokenMeter.estimateMessage(note(summary.map((x) => x.text).join("\n"))) + 200;
    record({
      kind: "context_scores",
      session: id,
      judgments: selection.judgments,
      segments: segments.length,
      kept: kept.size,
      dropped: dropped.length,
      ...(openQuestion ? { openQuestion } : {}),
      estimatedBefore: regionTokens,
      estimatedAfter: replacementTokens,
    });
    if (replacementTokens > regionTokens * 0.8) {
      await compactRegion(pressure >= ceiling ? "ceiling_native" : "selection_shortfall");
      return;
    }
    prepared.set(id, { summary, model: selection.model });
    try {
      await compactRegion("replacement");
    } finally {
      prepared.delete(id);
    }
  }
}
