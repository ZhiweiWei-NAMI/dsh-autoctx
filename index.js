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
  CATALOG,
  modelInfo,
  availableModels,
  pickModel,
  knowledge,
  costUSD,
  jevCostUSD,
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
  FIT_LEVELS,
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
  learning: z
    .union(["auto", "manual", "frozen"])
    .default("auto")
    .volatile()
    .description(
      "Workspace adaptation weights: auto applies Jev's proposals, manual waits for approval, frozen only records them",
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
  "Independently check the change the parent just made against the original issue. Inspect `git diff`, re-read the issue, run a minimal reproduction and the single most relevant existing test file. Never run the whole test suite; keep every command under 60 seconds; batch independent checks into one step. Do NOT edit files. Report only defects in the change itself: failures that also happen without the change, untested extras and style are not defects. Start the first line with exactly `LGTM` (then one line of evidence) or `DEFECTS` (then each concrete defect with evidence).";
const reviewMessage = (report) =>
  "An independent reviewer reports possible defects in your change:\n" +
  report +
  "\nCheck each against the behavior the issue asks for: fix the real ones and verify with the most relevant test; keep your change where a report contradicts the issue. Do not investigate unrelated or pre-existing failures, then finish.";
const ADVISOR_PROMPT =
  "You are a senior advisor to a coding agent. Do not call tools; answer from this brief only. Give the most likely root cause, the next 2–4 concrete steps, and what evidence would confirm them, in ≤ 1200 characters.";
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
          ledger: domainTable(schema.json()),
          uses: domainTable(schema.json()),
        },
      }),
    ));
  ctx.on("dispose", async () => {
    if (storePromise) await (await storePromise).close();
  });

  // Workspace ledger: one record per workspace; every change is one serialized storage update.
  const workspaceOf = (agent) => agent?.session.header.cwd ?? "";
  const ledgerInits = new Map();
  // Per-record storage keys must be path-safe, so a workspace path is stored by its hash.
  const ledgerKey = (cwd) => "ws_" + createHash("sha256").update(cwd).digest("hex").slice(0, 32);
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
  function tripJev(root, session, status, detail) {
    if (jevDown.has(root)) return;
    jevDown.set(root, { status, detail });
    record({ kind: "jev_unavailable", session, model: config.jevModel, httpStatus: status, error: detail });
  }
  // `unbudgeted` is for the turn-end learning call, which must not compete with the task's decisions.
  async function decide(agent, request, signal, { unbudgeted = false } = {}) {
    const root = rootOf(agent),
      state = budget(root);
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
      if (!unbudgeted) state.decisions++;
      updateStats(root);
      const started = performance.now();
      let response;
      try {
        response = await fetch(config.jevEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
          body,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        tripJev(root, agent.session.id, undefined, redact(String(error), config.apiKey).slice(0, 300));
        throw error;
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
      record({
        kind: "jev",
        session: agent.session.id,
        trigger: request.trigger,
        httpStatus: response.status,
        wallMs: performance.now() - started,
        ...(usd === undefined ? {} : { usd }),
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
    const running = active.get(info.id);
    if (!running) throw new Error("Native child ended without a start.");
    active.delete(info.id);
    advisorChildren.delete(info.id);
    settled.set(info.id, info);
    if (childRoles.get(info.id) === "worker" && childModels.has(info.id)) {
      const use = roleUse(running.parent, "worker", childModels.get(info.id));
      if (info.stopReason === "completed") use.completed++;
      use.reports.push({ outcome: info.stopReason, at: graphFor(running.parent).sequence });
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

  // One Jev turn plan per root turn: the task tag keys the workspace ledger, and the thinking setting
  // stays for the whole turn. Toggling it per event split the cache (thinking on and off are separate
  // cache spaces on the measured route), so it changes only here and at a context checkpoint.
  async function planTurn(agent, signal) {
    const id = agent.session.id,
      turn = currentTurn.get(id),
      previous = turnPlans.get(id);
    const effortOn = config.adaptiveEffort && config.adaptiveEffort !== "off" && effortSupported.get(id) === true;
    // Without an effort to decide, nothing is asked here: the task tag rides on the first later decision
    // that needs it (role choice or learning).
    if (!effortOn) {
      turnPlans.set(id, { turn, via: "none" });
      return turnPlans.get(id);
    }
    const plan = { turn, effort: previous?.effort, via: "kept" };
    const questions = {
      task_tag: TAG_QUESTION,
      ...(effortOn
        ? {
            high_reasoning: {
              type: "noul",
              instructions:
                "Should the executor keep extended reasoning (thinking) on for the rest of this turn? It adds output tokens and time to every request; it pays off when the cause is unclear or several hypotheses must be weighed, less when the next steps are mechanical. A change from the current setting has the cache effect in `executor.thinkingCache`. Answer the probability that thinking on gives the better outcome under the user's preference.",
            },
          }
        : {}),
    };
    const anchor = pressureAnchors.get(id);
    const request = {
      task: tasks.get(id),
      trigger: "turn_plan",
      preference: roots.get(id)?.policy?.weights,
      executor: {
        model: agent.options?.model,
        route: agent.options?.provider,
        thinkingNow: previous?.effort ? "on (" + previous.effort + ")" : "off",
        thinkingCache: thinkingCacheFact(agent.options?.model),
        contextTokens: anchor?.input ?? ctx.tokenMeter.measure(agent.session).totalTokens,
        ...(lastCached.has(id) ? { lastCachedTokens: lastCached.get(id) } : {}),
      },
      questions,
    };
    try {
      const answers = (await decide(agent, request, signal)).answers;
      plan.tag = answers.task_tag.choice;
      plan.tagConfidence = answers.task_tag.confidence;
      if (effortOn) {
        plan.highReasoning = answers.high_reasoning.noul;
        plan.effort = answers.high_reasoning.noul >= 0.5 ? config.adaptiveEffort : undefined;
      }
      plan.via = "jev";
    } catch (error) {
      if (signal.aborted) throw error;
      // Without Jev the current setting stays: a switch would only cost a cache rebuild.
      plan.error = String(error).slice(0, 200);
    }
    turnPlans.set(id, plan);
    record({ kind: "turn_plan", session: id, turn, tag: plan.tag ?? null, effort: plan.effort ?? null, via: plan.via,
      ...(plan.highReasoning === undefined ? {} : { highReasoning: plan.highReasoning }),
      ...(plan.error ? { error: plan.error } : {}) });
    return plan;
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
      if (id === root) effort = effortSupported.get(root) === true ? turnPlans.get(root)?.effort : undefined;
      else {
        // A same-model child keeps the effort its branch started with: a later parent checkpoint does
        // not rewrite the cache identity of a running child.
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
      candidates = [];
    for (const entry of available)
      if (Number.isFinite(entry.context) && entry.context < 2 * briefTokens)
        filtered.push({ model: entry.id, reason: "context window " + entry.context + " is below twice the brief" });
      else candidates.push(entry);
    const rowsNow = () => candidates.map((entry) => ({ model: entry.id, ...weight(entry.id) }));
    const rows = rowsNow();
    const fallback = () =>
      pickModel(role, { available: candidates, weightOf: (id) => weight(id).weight });
    if (setting === "auto" && candidates.length && budget(root).decisions < config.maxDecisions) {
      const criteria = Object.fromEntries(candidates.map((entry) => [entry.id, knowledge([entry])]));
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
      const prompt =
        REVIEW_PROMPT +
        "\n\nOriginal issue:\n" + tasks.get(id) +
        "\n\nParent evidence ledger:\n" + digest(rootGraph(agent), 3000);
      reviewPending.add(id);
      run = await ctx.subagents.start(provider, {
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
        agent.steer(note(reviewMessage(report)));
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
    if (advisor) extra.push(note(advisor));
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
    const newTurn = !isChild && turnStartSteps.get(id)?.turn !== payload.turn;
    if (newTurn) {
      turnStartSteps.set(id, { turn: payload.turn, step: graphStep(id) });
      if (turnUses.get(id)?.turn !== payload.turn) turnUses.set(id, newUse(payload.turn));
    }
    const reopened = !isChild && turnUses.get(id);
    if (reopened?.settled && reopened.turn === payload.turn) {
      reopened.settled = false;
      reopened.generation = (reopened.generation ?? 0) + 1;
      record({ kind: "turn_reopened", session: id, turn: payload.turn });
    }
    installEffort(agent);
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
    return appendNotes(agent, admitted, { advisor, finalRequest, staleNotes });
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
      const wallMs = performance.now() - started;
      const spent = agent ? account(agent, options, usage, wallMs) : undefined;
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
      });
    }
  });
  ctx.on("session/event", (session, event) => {
    if (event.type === "compaction/summary") {
      pressureAnchors.delete(session.id);
      pendingLedgers.add(session.id);
    }
    if (session.header.parentSession !== undefined) return;
    // Learning settles once per completed root turn, outside the turn: it never delays the user.
    if (event.type === "turn/end" && event.data?.reason?.kind === "completed")
      settleTurn(session, event.data.turn).catch((error) =>
        record({ kind: "learning_failed", session: session.id, error: String(error) }));
    feedbackEvent(session, event);
  });
  // Feedback on a session that is not loaded is committed to its log and announced here instead.
  ctx.on("feedback/committed", (inspection) => {
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
  const editsAfterEvent = (graph, event) =>
    Object.values(graph.files).flatMap((file) => file.edits).filter((edit) => edit.via === undefined && edit.event > event).length;
  const basisOf = (fact, context) =>
    [
      fact.children + " " + fact.role + " run(s)",
      ...fact.reports.slice(0, 2).map((report) =>
        (report.verdict ?? report.outcome ?? "advice") + (report.executorEditsAfter ? ", executor edited after" : ", no edits after")),
      "tests " + context.tests.passing + " pass/" + context.tests.failing + " fail",
      "$" + fact.usd,
      fact.seconds + "s",
      ...(fact.cacheHit === null ? [] : ["cache " + Math.round(fact.cacheHit * 100) + "%"]),
      ...(context.feedback ? ["user " + context.feedback.rating + (context.feedback.category ? " (" + context.feedback.category + ")" : "")] : []),
    ].join("; ").slice(0, 160);

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
      .map(([key, entry]) => {
        const input = since(key, entry, "input");
        return {
          role: entry.role,
          model: entry.model,
          children: since(key, entry, "children"),
          completed: since(key, entry, "completed"),
          calls: since(key, entry, "calls"),
          usd: round(since(key, entry, "usd")),
          seconds: round(since(key, entry, "ms") / 1000, 1),
          cacheHit: input ? round(since(key, entry, "cacheRead") / input, 3) : null,
          reports: entry.reports.slice(base[key]?.reports ?? 0)
            .map(({ at, ...report }) => ({ ...report, executorEditsAfter: editsAfterEvent(graph, at) })),
        };
      });
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
    const questions = Object.fromEntries(facts.map((fact, i) => ["fit_" + i, {
      type: "score",
      instructions:
        "How well does " + fact.model + " fit the " + fact.role + " role for " + (tagged ? context.tag : "this kind of") + " tasks in this workspace, given facts[" + i + "] from this task and its current weight? Use observed facts only: a defects report the executor acted on before tests passed was useful; one contradicted by passing tests without edits, or by user feedback, was wrong advice; cost and time count under the user's need (" + context.need + "). One task is weak evidence.",
      criteria: FIT_LEVELS,
    }]));
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
    const proposals = facts.map((fact, i) => ({
      key: weightKey(tag, fact.model, fact.role),
      evidence: [evidenceId + ":" + fact.role + "|" + fact.model],
      target: answers["fit_" + i].score / (FIT_LEVELS.length - 1),
      basis: basisOf(fact, context),
      // Jev's confidence is not calibrated; it is shown as is, labeled so.
      uncertainty: round(1 - answers["fit_" + i].confidence, 2),
    }));
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
          if (checkpointEffort.effort !== plan.effort)
            record({ kind: "effort_checkpoint", session: id, from: plan.effort ?? null, to: checkpointEffort.effort ?? null,
              highReasoning: checkpointEffort.highReasoning });
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
    const unitText = (unit) => unit.kind + ":\n" + unit.text;
    const tokensOf = (unit) => ctx.tokenMeter.estimateMessage(note(unitText(unit)));
    const sizes = new Map(history.map((unit) => [unit.id, tokensOf(unit)]));
    const largestFirst = [...history].sort((a, b) => sizes.get(b.id) - sizes.get(a.id));
    const batch = selectionBatch(tasks.get(id), largestFirst, observation);
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
    const judged = history.filter((unit) => judgedIds.has(unit.id));
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
            high_reasoning: {
              type: "noul",
              instructions:
                "After this checkpoint, should the executor keep extended reasoning (thinking) on for the rest of the turn? The replacement re-reads the context anyway, so switching now costs no extra cache rebuild. Answer the probability that thinking on gives the better outcome under the user's preference.",
            },
          }
        : {}),
    };
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
        { ...batch, economics, preference: roots.get(rootOf(agent))?.policy?.weights, executorThinking: turnPlans.get(id)?.effort ?? "off" },
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
    if (selection.answers.high_reasoning)
      checkpointEffort = {
        effort: selection.answers.high_reasoning.noul >= 0.5 ? config.adaptiveEffort : undefined,
        highReasoning: selection.answers.high_reasoning.noul,
      };
    const regionTokens = regionTokensEstimate;
    // Unjudged units are kept first (required ones always); when they alone exceed the keep budget,
    // the oldest non-required ones are archived to one line each.
    const keepBudget = config.keepRatio * regionTokens;
    const unjudged = history.filter((unit) => !judgedIds.has(unit.id));
    const kept = new Set(unjudged.map((unit) => unit.id));
    let unjudgedTokens = unjudged.reduce((sum, unit) => sum + sizes.get(unit.id), 0);
    for (const unit of unjudged) {
      if (unjudgedTokens <= keepBudget) break;
      if (unit.required) continue;
      kept.delete(unit.id);
      unjudgedTokens -= sizes.get(unit.id);
    }
    const budgeted = budgetedSelection(
      judged,
      selection.judgments,
      Math.max(0, keepBudget - unjudgedTokens),
      tokensOf,
    );
    for (const keptId of budgeted.keptIds) kept.add(keptId);
    const dropped = history.filter((unit) => !kept.has(unit.id));
    const summary = history
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
      await compactRegion("replacement");
    } finally {
      prepared.delete(id);
    }
  }
}
