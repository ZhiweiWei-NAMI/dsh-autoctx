import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apply, buildDefaultRoute, Config } from "../index.js";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import {
  STATE_BYTES,
  PREVIEW_CHARS,
  selectionBatch,
  scoreContext,
  budgetedSelection,
  droppedUnitLine,
  extendTask,
  createDecisionMemo,
} from "../decisions.js";
import { selectDelegation, validateJevAnswers } from "../routing.js";

function composition(mode) {
  const handlers = new Map();
  let guard;
  const ctx = {
    tools: {
      guard(fn) {
        guard = fn;
      },
    },
    on(name, fn) {
      handlers.set(name, fn);
    },
    inject() {},
  };
  apply(ctx, { mode, maxChildren: 2, maxConcurrent: 2, pressureTokens: 24000, retainTokens: 8000 });
  return { guard, handlers };
}

test("ordinary native tool executions remain usable in single-agent mode", () => {
  const { guard } = composition("single");
  assert.equal(
    guard({ name: "bash", arguments: { command: "python -m unittest" }, callId: "call-1" }),
    undefined,
  );
  assert.match(guard({ name: "subagent", arguments: {}, callId: "call-2" }), /main agent only/);
});

test("delegation on a non-routed session uses native dispatch", async () => {
  const { handlers } = composition("native");
  const agent = { session: { id: "root", header: {} } };
  const result = {
    isError: false,
    value: { kind: "continuable", subagentId: "child" },
    content: [],
  };
  let calls = 0;
  const actual = await handlers.get("tools/execute")(
    { name: "subagent", arguments: {}, agent },
    async () => {
      calls++;
      return result;
    },
  );
  assert.equal(calls, 1);
  assert.equal(actual, result);
});

test("native delegation reservations share a task limit and release on failure", () => {
  const { guard, handlers } = composition("native");
  const agent = { session: { id: "root", header: {} } };
  const first = { name: "subagent", callId: "first", agent };
  const second = { name: "subagent_fork", callId: "second", agent };
  assert.equal(guard(first), undefined);
  assert.equal(guard(second), undefined);
  assert.match(guard({ name: "subagent", callId: "third", agent }), /limit reached/);
  handlers.get("tools/result")(first, { isError: true });
  assert.equal(guard({ name: "subagent", callId: "replacement", agent }), undefined);
  const unrelated = { session: { id: "other-task", header: {} } };
  assert.equal(guard({ name: "subagent", callId: "other", agent: unrelated }), undefined);
});

test("the final budgeted child report concludes the returned native result", async () => {
  const handlers = new Map();
  const agent = {
    session: {
      id: "child",
      header: { parentSession: "root" },
      snapshotEvents: () => [],
      requestHeader: () => undefined,
    },
  };
  const ctx = {
    tools: { guard() {}, get: () => ({}) },
    agents: { get: (id) => (id === "child" ? agent : undefined) },
    tokenMeter: { measure: () => ({ totalTokens: 100 }) },
    on(name, fn) {
      handlers.set(name, fn);
    },
    inject() {},
  };
  apply(ctx, { mode: "native", retainTokens: 8000, maxChildRequests: 16, maxChildTurnRequests: 2 });
  await handlers.get("agent/pre-step")(
    { agent, messages: [], turn: "turn", signal: new AbortController().signal },
    async () => ({ kind: "continue" }),
  );
  for (let i = 0; i < 2; i++) {
    const stream = handlers.get("llm/stream")({ sessionId: "child" }, async function* () {});
    await stream.next();
  }
  const result = { isError: false, value: { accepted: true }, content: [] };
  let dispatched = 0;
  const actual = await handlers.get("tools/execute")(
    {
      name: "send_message",
      agent,
      arguments: { agent_id: "root", message: "Completed the assigned work." },
      concludeTurn() {},
    },
    async () => {
      dispatched++;
      return result;
    },
  );
  assert.equal(dispatched, 1);
  assert.deepEqual(actual, { ...result, concludesTurn: true });
});

const profiles = [
  { id: "general/high", routeId: "general" },
  { id: "review/high", routeId: "review" },
];
const answer = {
  independent: { noul: 0.95 },
  useful: { score: 1.9, confidence: 0.9 },
  fit_0: { score: 1.8, confidence: 0.8 },
  fit_1: { score: 1.8, confidence: 0.8 },
};
const weights = { quality: 1, latency: 0.5, usage: 0.5, cache: 1 };
test("configured initial preferences affect the chosen eligible native profile", () => {
  assert.equal(
    selectDelegation(
      answer,
      profiles,
      [],
      { weights, routeWeights: { general: 1, review: 0 } },
      { canCreate: true },
    ).profile.routeId,
    "general",
  );
  assert.equal(
    selectDelegation(
      answer,
      profiles,
      [],
      { weights, routeWeights: { general: 0, review: 1 } },
      { canCreate: true },
    ).profile.routeId,
    "review",
  );
  assert.equal(
    selectDelegation(
      answer,
      profiles,
      [],
      { weights, routeWeights: { general: 0.5 } },
      { canCreate: true },
    ).profile.routeId,
    "general",
  );
  const inheritedNames = [
    { id: "constructor/high", routeId: "constructor" },
    { id: "toString/high", routeId: "toString" },
  ];
  assert.deepEqual(
    selectDelegation(
      answer,
      inheritedNames,
      [],
      { weights, routeWeights: {} },
      { canCreate: true },
    ).ranking.map((x) => x.weightedScore),
    [1.8, 1.8],
  );
});
test("malformed route preferences retain their prior rejection behavior", () => {
  assert.throws(
    () =>
      selectDelegation(
        answer,
        profiles,
        [],
        { weights, routeWeights: { general: "high", review: 1 } },
        { canCreate: true },
      ),
    /routeWeights.general must be a number between 0 and 1/,
  );
});
test("an empty route list falls back to the session native model", () => {
  assert.deepEqual(
    buildDefaultRoute({ provider: "deepseek-official", model: "deepseek-v4.1-flash" }),
    {
      id: "default",
      label: "Default",
      provider: "deepseek-official",
      model: "deepseek-v4.1-flash",
      description: "General implementation, analysis and verification with the session main model",
      efforts: [],
    },
  );
});
test("direct Jev answers require valid primitive fields", () => {
  const questions = {
    useful: { type: "score", criteria: ["a", "b", "c"] },
    independent: { type: "noul" },
    fit_0: { type: "score", criteria: ["a", "b", "c"] },
    owner: { type: "choice", criteria: { current: "c", archive: "a" } },
  };
  assert.equal(
    validateJevAnswers(questions, {
      useful: { type: "score", score: 1.9, confidence: 0.9 },
      independent: { type: "noul", noul: 0.95 },
      fit_0: { type: "score", score: 1.8, confidence: 0.8 },
      owner: { type: "choice", choice: "current", confidence: 0.9 },
    }),
    null,
  );
  assert.match(
    validateJevAnswers(questions, {
      useful: { type: "score", score: 1.9 },
      independent: { type: "noul", noul: 0.95 },
      fit_0: { type: "score", score: 1.8, confidence: 0.8 },
      owner: { type: "choice", choice: "current", confidence: 0.9 },
    }),
    /useful: missing or invalid confidence/,
  );
  assert.match(
    validateJevAnswers(questions, {
      useful: { type: "score", score: 1.9, confidence: 0.9 },
      independent: { type: "noul", noul: 2 },
      fit_0: { type: "score", score: 1.8, confidence: 0.8 },
      owner: { type: "choice", choice: "current", confidence: 0.9 },
    }),
    /independent: missing or invalid noul/,
  );
  assert.match(
    validateJevAnswers(questions, {
      useful: { type: "score", score: 1.9, confidence: 0.9 },
      independent: { type: "noul", noul: 0.95 },
      fit_0: { type: "score", score: 1.8, confidence: 0.8 },
      owner: { type: "choice", choice: "other", confidence: 0.9 },
    }),
    /owner: choice was not offered/,
  );
  assert.match(
    validateJevAnswers(
      { owner: { type: "choice", criteria: { shared: "Shared evidence" } } },
      { owner: { type: "choice", choice: ["shared"], confidence: 0.9 } },
    ),
    /owner: choice was not offered/,
  );
});
test("ambiguous benefit does not start expensive investigation", () => {
  const uncertain = { ...answer, useful: { score: 1.8, confidence: 0.09 } };
  assert.equal(selectDelegation(uncertain, profiles, [], null, { canCreate: true }).action, "main");
});
test("a matching continuing conversation can be reused when new child slots are exhausted", () => {
  const result = selectDelegation(
    { ...answer, reuse_0: { score: 1.95, confidence: 0.9 } },
    profiles,
    [{ id: "existing" }],
    null,
    { canCreate: false },
  );
  assert.equal(result.action, "reuse");
  assert.equal(result.child.id, "existing");
});

test("continued user requirements preserve complete tails and update the decision task", () => {
  const original = "Implement the issue while keeping its public API.";
  const request = "Detailed constraint. ".repeat(200) + "Keep the Unicode suffix.";
  const updated = extendTask(original, [
    { source: { kind: "user" }, content: [{ type: "text", text: request }] },
    { source: { kind: "plugin" }, content: [{ type: "text", text: "A transient plugin notice." }] },
  ]);
  assert.ok(updated.startsWith(original));
  assert.ok(updated.endsWith("Keep the Unicode suffix."));
  assert.ok(updated.includes(request));
  assert.ok(!updated.includes("transient plugin"));
});

test("a batch judges previews of the oldest complete candidates without carrying full text", () => {
  const history = [
    { id: "oldest", kind: "assistant/reasoning", text: "Evidence " + "x".repeat(1600) },
    ...Array.from({ length: 32 }, (_, i) => ({
      id: "source-" + i,
      kind: "tool/text",
      text: "Evidence " + i,
    })),
  ];
  const batch = selectionBatch("Task", history);
  assert.deepEqual(
    batch.history.map((unit) => unit.id),
    history.slice(0, 32).map((unit) => unit.id),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= STATE_BYTES);
  const preview = batch.history[0].text;
  assert.ok(preview.length <= PREVIEW_CHARS);
  assert.match(preview, /chars omitted/);
  assert.ok(preview.startsWith("assistant/reasoning\nEvidence "));
  assert.equal(preview.includes("x".repeat(1600)), false);
  const command = "x".repeat(STATE_BYTES) + "ESSENTIAL_TAIL";
  const oversized = selectionBatch("Task", [
    { id: "large", kind: "assistant/tool-call", tool: "bash", argument: command, text: command },
  ]);
  assert.equal(oversized.history.length, 1);
  assert.deepEqual(Object.keys(oversized.history[0]), ["id", "text"]);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= STATE_BYTES);
  assert.ok(oversized.history[0].text.length <= PREVIEW_CHARS);
  assert.match(oversized.history[0].text, /^assistant\/tool-call bash \(/);
  assert.match(oversized.history[0].text, /ESSENTIAL_TAIL$/);
});

test("a selection whose previews cannot fit one batch returns no request", () => {
  const huge = {
    task: "x".repeat(STATE_BYTES),
    trigger: "selection",
    history: [],
    observation: {},
  };
  assert.equal(
    selectionBatch(huge.task, [{ id: "u", kind: "tool", text: "y", required: false }], {}),
    null,
  );
});

test("identical decision requests reuse one response and retry after failure", async () => {
  const memo = createDecisionMemo();
  let calls = 0;
  const run = async () => {
    calls++;
    return { answers: {} };
  };
  assert.deepEqual(await memo("same", run), { answers: {} });
  assert.deepEqual(await memo("same", run), { answers: {} });
  assert.equal(calls, 1);
  for (let i = 0; i < 65; i++) await memo("other-" + i, run);
  await memo("same", run);
  assert.equal(calls, 66);
  await assert.rejects(
    memo("boom", async () => {
      throw new Error("HTTP 500");
    }),
    /HTTP 500/,
  );
  let retried = 0;
  await memo("boom", async () => {
    retried++;
    return "ok";
  });
  assert.equal(retried, 1);
});

test("complete sources receive relevance and ownership judgments in one call", async () => {
  const full = "实验记录😃\n".repeat(500) + "USEFUL_REQUIREMENT";
  const history = [
    { id: "instruction", kind: "user", text: "Keep the public API.", required: true },
    { id: "long", kind: "assistant", text: full, required: false },
    { id: "old", kind: "tool", text: "Obsolete unrelated evidence", required: false },
  ];
  let calls = 0;
  const result = await scoreContext(
    async (request) => {
      calls++;
      const answers = {};
      for (const [i, unit] of request.history.entries()) {
        const useful = unit.text.includes("USEFUL_REQUIREMENT");
        answers["importance_" + i] = { type: "score", score: useful ? 2 : 0, confidence: 0.9 };
        answers["owner_" + i] = {
          type: "choice",
          choice: useful ? "current" : "archive",
          confidence: 0.9,
        };
      }
      return { model: "jev-1.13-free", answers };
    },
    selectionBatch("Fix the public API.", history),
    {},
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.judgments.map((judgment) => judgment.source), ["long", "old"]);
  assert.deepEqual(result.judgments.map((judgment) => judgment.importance.score), [2, 0]);
});

test("uncertain context scores are returned unchanged for budgeted selection", async () => {
  const history = [{ id: "evidence", text: "Potentially essential evidence", required: false }];
  const result = await scoreContext(
    async () => ({
      model: "jev-1.13-free",
      answers: {
        importance_0: { score: 0.2, confidence: 0.1 },
        owner_0: { choice: "archive", confidence: 0.9 },
      },
    }),
    selectionBatch("Task", history),
    {},
  );
  assert.deepEqual(result.judgments, [{
    source: "evidence",
    part: "evidence",
    importance: { score: 0.2, confidence: 0.1 },
    owner: { choice: "archive", confidence: 0.9 },
  }]);
});

test("a failed primitive request is not retried or replaced with a synthetic keep", async () => {
  let calls = 0;
  const history = [{ id: "evidence", text: "Source", required: false }];
  await assert.rejects(
    scoreContext(
      async () => {
        calls++;
        throw new Error("HTTP 401");
      },
      selectionBatch("Task", history),
      {},
    ),
    /HTTP 401/,
  );
  assert.equal(calls, 1);
});

test("a complete single batch preserves the evidence tail and reasoning in previews", () => {
  const history = [
    { id: "evidence", text: "x".repeat(1600) + "TAIL_REQUIREMENT" },
    { id: "reasoning", kind: "assistant/reasoning", text: "Reasoning evidence" },
  ];
  const batch = selectionBatch("Task", history);
  assert.deepEqual(
    batch.history.map((unit) => unit.id),
    ["evidence", "reasoning"],
  );
  assert.match(batch.history[0].text, /TAIL_REQUIREMENT$/);
  assert.equal(batch.history[1].text, "assistant/reasoning\nReasoning evidence");
});

function autoComposition(options = {}) {
  const handlers = new Map(),
    children = [],
    agents = new Map(),
    tables = new Map();
  let guard,
    call = 0;
  const signal = new AbortController().signal;
  const config = {
    mode: "auto",
    apiKey: "test-key",
    jevModel: "jev-test",
    jevEndpoint: "https://jev.invalid",
    routes: [],
    maxChildren: 2,
    maxConcurrent: 1,
    maxChildRequests: 16,
    maxDecisions: 100,
    pressureTokens: 2000,
    ceilingRatio: 1.5,
    retainTokens: 1024,
    economyGuidance: true,
    contextSelection: "jev",
    keepRatio: 0.35,
    ...options,
  };
  const events = [
    {
      role: "system",
      source: { kind: "system" },
      content: [{ type: "text", text: "System instructions" }],
    },
    {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Investigate the issue" }],
    },
    {
      role: "assistant",
      source: { kind: "assistant" },
      content: [{ type: "text", text: "e".repeat(10000) }],
    },
    {
      role: "assistant",
      source: { kind: "assistant" },
      content: [{ type: "text", text: "Recent evidence" }],
    },
  ].map((message, seq) => ({ seq, type: message.role + "/message", data: { message } }));
  const agent = {
    options: { provider: "native", model: "main" },
    session: {
      id: "root",
      header: {},
      requestHeader: () => (options.pressure ? {} : undefined),
      snapshotEvents: () => events,
      surface: { nodes: options.pressure ? [0, 1, 2, 3] : [] },
      eventAt: (seq) => events[seq],
      deriveEventMessage: (event) => event.data.message,
    },
  };
  agents.set("root", agent);
  const ctx = {
    tools: {
      guard(fn) {
        guard = fn;
      },
      get: () => ({ parameters: { type: "object" } }),
    },
    on(name, fn) {
      handlers.set(name, fn);
    },
    inject() {},
    reflect: { provide() {} },
    llm: { prepareCall: async () => {} },
    agents: { get: (id) => agents.get(id) },
    tokenMeter: {
      measure: () => ({
        totalTokens: 3724,
        nodes: [100, 100, 2500, 1024].map((tokens) => ({ tokens })),
      }),
      estimateMessage: (message) => JSON.stringify(message).length / 4,
    },
    storageDomain: {
      open: async () => ({
        table: (name) => {
          if (!tables.has(name)) tables.set(name, new Map());
          const records = tables.get(name);
          return {
            get: (key) => records.get(key),
            delete: async (key) => records.delete(key),
            put: async (key, value) => {
              if (name === "assignments" && options.failPut) {
                options.failPut = false;
                throw new Error("storage failed");
              }
              records.set(key, value);
            },
          };
        },
        close: async () => {},
      }),
    },
    subagents: {
      listChildren: async () => children,
      getProvider: () => ({}),
      startContinuable: async (spec) => {
        if (options.failStart) {
          options.failStart = false;
          throw new Error("provider refused");
        }
        const child = {
          id: spec.childId,
          kind: "child",
          mode: "continuable",
          label: "Investigation",
          provider: spec.provider,
        };
        children.push(child);
        agents.set(child.id, { session: { id: child.id, header: { parentSession: "root" } } });
        handlers.get("subagent/start")({ id: child.id, runId: child.id + "-run" });
      },
    },
  };
  apply(ctx, config);
  const step = (abort = signal) =>
    handlers.get("agent/pre-step")(
      { agent, messages: [], turn: "turn", signal: abort },
      async () => ({ kind: "continue" }),
    );
  const execute = async (prompt = "Inspect the failure") => {
    const exec = {
      name: "subagent",
      arguments: { prompt },
      callId: "call-" + ++call,
      agent,
      signal,
    };
    const blocked = guard(exec);
    const result = blocked
      ? { isError: true, error: { message: blocked } }
      : await handlers.get("tools/execute")(exec, () => {
          throw new Error("Unexpected native dispatch");
        });
    handlers.get("tools/result")(exec, result);
    return result;
  };
  return {
    agent,
    config,
    children,
    handlers,
    step,
    execute,
    tables,
    ctx,
    agents,
    guard: (exec) => guard(exec),
  };
}

function jevReply(body) {
  const { questions } = JSON.parse(body),
    answers = {};
  for (const [id, question] of Object.entries(questions))
    answers[id] =
      question.type === "noul"
        ? { type: "noul", noul: 0.95 }
        : question.type === "choice"
          ? { type: "choice", choice: "shared", confidence: 0.9 }
          : { type: "score", score: id.startsWith("reuse_") ? 0 : 2, confidence: 0.9 };
  return { ok: true, status: 200, text: async () => JSON.stringify({ model: "jev", answers }) };
}

test("a fresh root can use every child slot through the real guard, then declines locally", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    requests.push(body);
    return jevReply(body);
  });
  const app = autoComposition();
  await app.step();
  for (let i = 0; i < app.config.maxChildren; i++) {
    const result = await app.execute("Investigate part " + i);
    assert.equal(result.isError, false);
    const child = app.children.at(-1);
    assert.equal(child.provider, "fork");
    app.handlers.get("subagent/end")({
      id: child.id,
      runId: child.id + "-run",
      stopReason: "completed",
    });
  }
  assert.equal(app.children.length, app.config.maxChildren);
  assert.match((await app.execute()).error.message, /resource limit reached/);
  assert.equal(requests.length, app.config.maxChildren);
  const body = JSON.parse(requests[0]);
  assert.deepEqual(Object.keys(body), ["model", "state", "questions"]);
  assert.deepEqual(Object.keys(JSON.parse(body.state)).slice(0, 3), [
    "instructions",
    "routes",
    "task",
  ]);
});

test("an exhausted decision budget declines a proposal without calling Jev", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev call");
  });
  const app = autoComposition({ maxDecisions: 0 });
  await app.step();
  assert.match((await app.execute()).error.message, /decision budget/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("persistence and creation failures release the slot, and identical decisions are reused", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const app = autoComposition({ maxChildren: 1, failPut: true, failStart: true });
  await app.step();
  assert.match((await app.execute()).error.message, /storage failed/);
  assert.match((await app.execute()).error.message, /provider refused/);
  assert.equal(app.tables.get("assignments").size, 0);
  assert.equal((await app.execute()).isError, false);
  assert.equal(app.children.length, 1);
  assert.equal(fetch.mock.callCount(), 1);
});

function nativeCompaction(t) {
  const summarize = t.mock.method(BasicCompactionEngine.prototype, "summarize", async () => ({
    summary: [{ type: "text", text: "Native summary" }],
    provider: "native",
    model: "main",
  }));
  const compact = t.mock.method(
    BasicCompactionEngine.prototype,
    "compactRegion",
    async function (start, end, agent, signal) {
      const result = await this.summarize({}, agent, signal);
      agent.session.eventAt(start).data.message.content = result.summary;
      return { shadowedSeqs: [start, end] };
    },
  );
  return { summarize, compact };
}

test("the schema default is Jev selection; contextSelection summary compacts without calling Jev", async (t) => {
  const defaults = Config({});
  assert.equal(defaults.contextSelection.get(), "jev");
  assert.equal(defaults.jevModel.get(), "jev-1.13");
  const native = nativeCompaction(t),
    records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev context selection request");
  });
  const app = autoComposition({
    pressure: true,
    pressureTokens: 3000,
    contextSelection: "summary",
    recordFile: "context-decisions.jsonl",
  });
  await app.step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 2]);
  assert.equal(native.summarize.mock.callCount(), 1);
  assert.ok(
    records.some((record) => record.kind === "context_replaced" && record.reason === "summary"),
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("a budgeted selection keeps one copy of a repeated output piece and replaces the region", async (t) => {
  const native = nativeCompaction(t),
    records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const app = autoComposition({
    pressure: true,
    pressureTokens: 3000,
    recordFile: "context-decisions.jsonl",
  });
  const original = app.agent.session.snapshotEvents().map((event) => JSON.stringify(event));
  await app.step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 2]);
  assert.equal(fetch.mock.callCount(), 1);
  const scored = records.find((record) => record.kind === "context_scores");
  // 10000 chars split into six identical 1500-char pieces and a shorter tail: one copy of each stays.
  assert.equal(scored.segments, 7);
  assert.equal(scored.kept, 2);
  assert.equal(scored.dropped, 0);
  assert.ok(
    records.some((record) => record.kind === "context_replaced" && record.reason === "replacement"),
  );
  const after = app.agent.session.snapshotEvents().map((event) => JSON.stringify(event));
  assert.ok(after[2].length < original[2].length);
  assert.match(after[2], /chars of this output omitted/);
  assert.match(after[2], /assistant\/text/);
  assert.deepEqual([after[0], after[1], after[3]], [original[0], original[1], original[3]]);
});

test("a Jev HTTP failure below the ceiling uses the native summarizer", async (t) => {
  const native = nativeCompaction(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
    text: async () => "Unavailable",
  }));
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  await autoComposition({
    pressure: true,
    pressureTokens: 3000,
    recordFile: "context-decisions.jsonl",
  }).step();
  assert.ok(
    records.some(
      (record) => record.kind === "context_decision_failed" && /HTTP 503/.test(record.error),
    ),
  );
  assert.ok(
    records.some(
      (record) => record.kind === "context_replaced" && record.reason === "decision_failed",
    ),
  );
  assert.equal(native.compact.mock.callCount(), 1);
  assert.equal(native.summarize.mock.callCount(), 1);
  // One retry for a transient gateway failure, then the breaker trips.
  assert.equal(fetch.mock.callCount(), 2);
});

test("a cancelled ceiling decision does not compact", async (t) => {
  const native = nativeCompaction(t),
    controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort(new Error("cancelled"));
    throw controller.signal.reason;
  });
  await assert.rejects(autoComposition({ pressure: true }).step(controller.signal), /cancelled/);
  assert.equal(native.compact.mock.callCount(), 0);
});

test("resumed child limits are enforced by both the guard and routing", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev call");
  });
  const app = autoComposition({ maxChildren: 1 });
  app.children.push({
    id: "existing",
    kind: "child",
    mode: "continuable",
    label: "Existing investigation",
  });
  await app.step();
  assert.match((await app.execute()).error.message, /resource limit reached/);
  const routed = autoComposition({ maxChildren: 1 });
  await routed.step();
  routed.children.push(app.children[0]);
  const result = await routed.handlers.get("tools/execute")(
    {
      name: "subagent",
      arguments: { prompt: "Investigate" },
      callId: "direct",
      agent: routed.agent,
      signal: new AbortController().signal,
    },
    () => {
      throw new Error("Unexpected native dispatch");
    },
  );
  assert.match(result.error.message, /no remaining child slot/);
  assert.equal(app.children.length, 1);
  assert.equal(routed.children.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test("parallel proposals share the remaining durable child slot", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const app = autoComposition({ maxChildren: 2, maxConcurrent: 2 });
  app.children.push({
    id: "existing",
    kind: "child",
    mode: "continuable",
    label: "Existing investigation",
  });
  await app.step();
  const results = await Promise.all([app.execute("Inspect A"), app.execute("Inspect B")]);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.match(results.find((result) => result.isError).error.message, /resource limit reached/);
  assert.equal(app.children.length, 2);
  assert.equal(fetch.mock.callCount(), 1);
});

test("the ceiling reduces retention and compacts natively when no old region is eligible", async (t) => {
  const native = nativeCompaction(t),
    records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev call");
  });
  const app = autoComposition({
    pressure: true,
    retainTokens: 4096,
    recordFile: "context-decisions.jsonl",
  });
  const before = app.agent.session.snapshotEvents().map((event) => JSON.stringify(event));
  await app.step();
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 2]);
  assert.equal(native.summarize.mock.callCount(), 1);
  const after = app.agent.session.snapshotEvents().map((event) => JSON.stringify(event));
  assert.ok(after[2].length < before[2].length);
  assert.deepEqual([after[0], after[1], after[3]], [before[0], before[1], before[3]]);
  assert.ok(
    records.some(
      (record) =>
        record.kind === "context_replaced" && record.reason === "ceiling_reduced_retention",
    ),
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("a network AbortError without a cancelled signal falls back to native compaction", async (t) => {
  const native = nativeCompaction(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Connection closed", "AbortError");
  });
  await autoComposition({ pressure: true, pressureTokens: 3000 }).step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.equal(native.summarize.mock.callCount(), 1);
  // One retry for a network failure, then the breaker trips.
  assert.equal(fetch.mock.callCount(), 2);
});

test("an invalid Jev answer below the ceiling falls back to native compaction", async (t) => {
  const native = nativeCompaction(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ answers: {} }),
  }));
  await autoComposition({ pressure: true, pressureTokens: 3000 }).step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.equal(native.summarize.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 1);
});

test("the native guard counts durable children after resume", async () => {
  const app = autoComposition({ mode: "native", maxChildren: 1 });
  app.children.push({
    id: "existing",
    kind: "child",
    mode: "continuable",
    label: "Existing investigation",
  });
  await app.step();
  assert.match((await app.execute()).error.message, /resource limit reached/);
  assert.equal(app.children.length, 1);
});

test("unassigned and resumed starts cannot release another pending call", async () => {
  const app = autoComposition({ mode: "native", maxChildren: 2, maxConcurrent: 2 });
  await app.step();
  const call = (id) => ({ name: "subagent", callId: id, agent: app.agent });
  assert.equal(app.guard(call("A")), undefined);
  assert.equal(app.guard(call("B")), undefined);
  app.agents.set("B", { session: { id: "B", header: { parentSession: "root" } } });
  app.handlers.get("subagent/start")({ id: "B", runId: "B-1" });
  app.handlers.get("tools/result")(call("B"), { isError: false });
  assert.match(app.guard(call("C")), /resource limit reached/);
  app.handlers.get("subagent/end")({ id: "B", runId: "B-1", stopReason: "completed" });
  assert.match(app.guard(call("C")), /resource limit reached/);
  app.handlers.get("subagent/start")({ id: "B", runId: "B-2" });
  app.handlers.get("subagent/end")({ id: "B", runId: "B-2", stopReason: "completed" });
  assert.match(app.guard(call("C")), /resource limit reached/);
  app.handlers.get("tools/result")(call("A"), { isError: true });
  assert.equal(app.guard(call("C")), undefined);
});

function contextHistory(app, contents) {
  const events = app.agent.session.snapshotEvents();
  const tail = events.at(-1);
  events.splice(
    2,
    events.length - 2,
    ...contents.map((content) => ({
      type: "assistant/message",
      data: { message: { role: "assistant", source: { kind: "assistant" }, content } },
    })),
    tail,
  );
  events.forEach((event, seq) => {
    event.seq = seq;
  });
  app.agent.session.surface.nodes = events.map((event) => event.seq);
  const nodes = events.map((_, i) => ({ tokens: i === events.length - 1 ? 1024 : 500 }));
  app.ctx.tokenMeter.measure = () => ({
    totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
    nodes,
  });
  return events;
}

test("33 candidates: 32 are judged by preview and one decision replaces the whole region", async (t) => {
  const native = nativeCompaction(t),
    requests = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    requests.push(JSON.parse(JSON.parse(body).state));
    return jevReply(body);
  });
  const app = autoComposition({ pressure: true });
  const events = contextHistory(
    app,
    Array.from({ length: 33 }, (_, i) => [{ type: "text", text: "Source " + i }]),
  );
  const remaining = JSON.stringify(events.slice(35));
  await app.step();
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 34]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].history.length, 32);
  assert.equal(JSON.stringify(events.slice(35)), remaining);
});

test("a complete tool exchange at the region end is replaced with the region", async (t) => {
  const native = nativeCompaction(t),
    requests = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    requests.push(JSON.parse(JSON.parse(body).state));
    return jevReply(body);
  });
  const app = autoComposition({ pressure: true });
  const events = contextHistory(app, [
    ...Array.from({ length: 30 }, (_, i) => [{ type: "text", text: "Source " + i }]),
    [{ type: "tool-call", id: "read", name: "read", arguments: {} }],
    [
      { type: "text", text: "Result head" },
      { type: "text", text: "Essential result tail" },
    ],
  ]);
  events[33].type = "tool/result";
  events[33].data.message.role = "tool";
  const remaining = JSON.stringify(events.slice(34));
  await app.step();
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 33]);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(events.slice(34)), remaining);
});

test("a region whose full text exceeds the state budget is judged by bounded piece previews", async (t) => {
  const native = nativeCompaction(t),
    requests = [],
    records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  const full = "x".repeat(STATE_BYTES) + "ESSENTIAL_TAIL";
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    const state = JSON.parse(JSON.parse(body).state);
    requests.push(state);
    const answers = {};
    for (const [i] of state.history.entries())
      answers["importance_" + i] = { type: "score", score: i === 0 ? 2 : 0, confidence: 0.9 };
    for (const [i] of state.history.entries())
      answers["owner_" + i] = {
        type: "choice",
        choice: i === 0 ? "current" : "archive",
        confidence: 0.9,
      };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: "jev", answers }),
    };
  });
  const app = autoComposition({ pressure: true, keepRatio: 0.35, recordFile: "context-decisions.jsonl" });
  contextHistory(
    app,
    Array.from({ length: 4 }, () => [{ type: "text", text: full }]),
  );
  const sourceTokens = Math.ceil(full.length / 4);
  const nodes = [100, 100, ...Array(4).fill(sourceTokens), 1024].map((tokens) => ({ tokens }));
  app.ctx.tokenMeter.measure = () => ({
    totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
    nodes,
  });
  await app.step();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].history.length > 4 && requests[0].history.length <= 32);
  for (const preview of requests[0].history) assert.ok(preview.text.length <= PREVIEW_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0])) <= STATE_BYTES);
  assert.equal(records.find((record) => record.kind === "context_scores").estimatedBefore, 4 * sourceTokens);
  assert.equal(native.summarize.mock.callCount(), 0);
  const replaced = app.agent.session
    .eventAt(2)
    .data.message.content.map((block) => block.text)
    .join("\n");
  // The small tail piece of each output is unjudged and kept once; the repeated filler is not.
  assert.ok(replaced.includes("ESSENTIAL_TAIL"));
  assert.equal(replaced.includes(full), false);
});

test("the ceiling still compacts natively when Jev keeps too much context", async (t) => {
  const native = nativeCompaction(t);
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const app = autoComposition({ pressure: true, keepRatio: 1, recordFile: "context-decisions.jsonl" });
  // Non-repeating text, so no piece is a duplicate of another.
  let seed = 7;
  const full = Array.from({ length: STATE_BYTES }, () => "abcdefghijklmnopqrstuvwxyz"[(seed = (seed * 1103515245 + 12345) % 2147483648) % 26]).join("") + "ESSENTIAL_TAIL";
  contextHistory(app, [[{ type: "text", text: "Tiny" }], [{ type: "text", text: full }]]);
  const nodes = [100, 100, 1, Math.ceil(full.length / 4) + 200, 1024].map((tokens) => ({ tokens }));
  const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
  app.ctx.tokenMeter.measure = () => ({ totalTokens, nodes });
  assert.ok(totalTokens > app.config.pressureTokens * app.config.ceilingRatio);
  await app.step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 3]);
  assert.ok(
    records.some(
      (record) => record.kind === "context_replaced" && record.reason === "ceiling_native",
    ),
  );
});

test("a native failure after Jev fails records the error and continues", async (t) => {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 503,
    text: async () => "Unavailable",
  }));
  t.mock.method(BasicCompactionEngine.prototype, "compactRegion", async () => {
    throw new Error("summary is not smaller than the shadowed content");
  });
  const result = await autoComposition({
    pressure: true,
    pressureTokens: 3000,
    recordFile: "context-decisions.jsonl",
  }).step();
  assert.equal(result.kind, "continue");
  assert.ok(
    records.some(
      (record) =>
        record.kind === "context_unshrinkable" &&
        record.reason === "decision_failed" &&
        /summary is not smaller/.test(record.error),
    ),
  );
});

test("a replacement failure continues but a signal abort still propagates", async (t) => {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const compact = t.mock.method(BasicCompactionEngine.prototype, "compactRegion", async () => {
    throw new DOMException("Connection closed", "AbortError");
  });
  const app = autoComposition({ pressure: true, recordFile: "context-decisions.jsonl" });
  assert.equal((await app.step()).kind, "continue");
  assert.ok(
    records.some(
      (record) =>
        record.kind === "context_unshrinkable" &&
        record.reason === "replacement" &&
        /Connection closed/.test(record.error),
    ),
  );
  const controller = new AbortController();
  compact.mock.mockImplementation(async () => {
    controller.abort(new Error("cancelled native compaction"));
    throw controller.signal.reason;
  });
  await assert.rejects(app.step(controller.signal), /cancelled native compaction/);
  assert.equal(records.filter((record) => record.kind === "context_unshrinkable").length, 1);
});

const guidanceText = (messages = []) =>
  messages
    .filter((m) => m.source.kind === "dsh-autoctx")
    .map((m) => m.content[0].text)
    .join("\n");

function commitGuidance(app, message) {
  const events = app.agent.session.snapshotEvents();
  const seq = events.length;
  events.push({ seq, type: "user/message", data: { message } });
  app.agent.session.surface.nodes.push(seq);
}

test("resumed roots tolerate native compaction errors but propagate cancellation", async (t) => {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  const compact = t.mock.method(BasicCompactionEngine.prototype, "compactIfNeeded", async () => {
    throw new Error("compacted context remains above threshold");
  });
  const app = autoComposition({
    mode: "single",
    pressure: true,
    recordFile: "context-decisions.jsonl",
  });
  assert.equal((await app.step()).kind, "continue");
  assert.match(
    records.find((record) => record.kind === "context_unshrinkable").error,
    /above threshold/,
  );
  compact.mock.mockImplementation(async () => {
    throw new DOMException("Connection closed", "AbortError");
  });
  const native = autoComposition({
    mode: "native",
    pressure: true,
    recordFile: "context-decisions.jsonl",
  });
  assert.equal((await native.step()).kind, "continue");
  assert.match(
    records.filter((record) => record.kind === "context_unshrinkable").at(-1).error,
    /Connection closed/,
  );
  const controller = new AbortController();
  compact.mock.mockImplementation(async () => {
    controller.abort(new Error("cancelled native compaction"));
    throw controller.signal.reason;
  });
  await assert.rejects(app.step(controller.signal), /cancelled native compaction/);
  assert.equal(records.filter((record) => record.kind === "context_unshrinkable").length, 2);
});

test("the economy note is appended exactly once for a root and never for a child", async (t) => {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev call");
  });
  const app = autoComposition({ recordFile: "context-decisions.jsonl" });
  const first = await app.step();
  assert.match(guidanceText(first.messages), /Execution economy/);
  assert.ok(records.some((record) => record.kind === "economy_guidance"));
  commitGuidance(app, first.messages[0]);
  const second = await app.step();
  assert.equal(guidanceText(second.messages), "");
  assert.equal(records.filter((record) => record.kind === "economy_guidance").length, 1);
  const child = {
    session: {
      id: "child",
      header: { parentSession: "root" },
      snapshotEvents: () => [],
      requestHeader: () => undefined,
    },
  };
  app.agents.set("child", child);
  const admitted = await app.handlers.get("agent/pre-step")(
    { agent: child, messages: [], turn: "turn", signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(guidanceText(admitted.messages), "");
});

test("uncommitted guidance is retried and committed guidance survives a plugin restart", async () => {
  const app = autoComposition({ mode: "single" });
  const first = await app.step();
  const retry = await app.step();
  assert.equal(guidanceText(retry.messages), guidanceText(first.messages));
  assert.equal(retry.messages[0].role, "user");
  assert.deepEqual(retry.messages[0].source, { kind: "dsh-autoctx" });
  commitGuidance(app, retry.messages[0]);
  apply(app.ctx, app.config);
  assert.equal(guidanceText((await app.step()).messages), "");
});

test("native compaction restores guidance once despite a post-replacement error", async (t) => {
  const app = autoComposition({ mode: "native" });
  const first = await app.step();
  commitGuidance(app, first.messages[0]);
  app.agent.session.requestHeader = () => ({});
  t.mock.method(BasicCompactionEngine.prototype, "compactIfNeeded", async () => {
    app.agent.session.surface.nodes = [];
    throw new Error("compacted context remains above threshold");
  });
  const restored = await app.step();
  assert.equal(guidanceText(restored.messages), guidanceText(first.messages));
  assert.equal(restored.messages.length, 1);
  commitGuidance(app, restored.messages[0]);
  app.agent.session.requestHeader = () => undefined;
  assert.equal(guidanceText((await app.step()).messages), "");
});

test("region selection requires guidance and restores its message after replacement", async (t) => {
  const app = autoComposition();
  const first = await app.step();
  const events = contextHistory(app, [
    first.messages[0].content,
    [{ type: "text", text: "e".repeat(10000) }],
  ]);
  events[2].type = "user/message";
  events[2].data.message = first.messages[0];
  app.config.keepRatio = 0;
  app.agent.session.requestHeader = () => ({});
  const fetch = t.mock.method(globalThis, "fetch", async (url, { body }) => {
    const state = JSON.parse(JSON.parse(body).state);
    // Only the non-required output is a candidate, judged as evidence pieces.
    assert.ok(state.history.length > 0 && state.history.every((unit) => unit.id.startsWith("event_3_block_0#")));
    return jevReply(body);
  });
  const compact = t.mock.method(
    BasicCompactionEngine.prototype,
    "compactRegion",
    async function (start, end, agent, signal) {
      const result = await this.summarize({}, agent, signal);
      assert.ok(result.summary.some((block) => block.text.includes(guidanceText(first.messages))));
      const shadowedSeqs = agent.session.surface.nodes.filter((seq) => seq >= start && seq <= end);
      agent.session.surface.nodes = agent.session.surface.nodes.filter(
        (seq) => !shadowedSeqs.includes(seq),
      );
      return { shadowedSeqs };
    },
  );
  const restored = await app.step();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(compact.mock.callCount(), 1);
  assert.equal(guidanceText(restored.messages), guidanceText(first.messages));
  assert.equal(restored.messages.length, 1);
  commitGuidance(app, restored.messages[0]);
  app.agent.session.requestHeader = () => undefined;
  assert.equal(guidanceText((await app.step()).messages), "");
});

test("the economy note is not appended when the setting is disabled", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected Jev call");
  });
  const admitted = await autoComposition({ economyGuidance: false }).step();
  assert.equal(guidanceText(admitted.messages), "");
});

test("budgeted selection keeps top scores in original order and always keeps required units", () => {
  const history = [
    { id: "a", required: false },
    { id: "req", required: true },
    { id: "b", required: false },
    { id: "c", required: false },
  ];
  const judgments = [
    { source: "a", importance: { score: 0.9, confidence: 0.9 }, owner: { choice: "current" } },
    { source: "b", importance: { score: 1, confidence: 0.9 }, owner: { choice: "archive" } },
    { source: "c", importance: { score: 1.1, confidence: 0.9 }, owner: { choice: "shared" } },
  ];
  const costs = { a: 5, req: 10, b: 12, c: 8 };
  const tokensOf = (unit) => costs[unit.id];
  const result = budgetedSelection(history, judgments, 30, tokensOf);
  assert.deepEqual(result.keptIds, ["req", "b", "c"]);
  assert.deepEqual(result.droppedIds, ["a"]);
  assert.equal(result.usedTokens, 30);
});

test("the dropped index names one unit per line and never exceeds its bound", () => {
  const line = droppedUnitLine({ kind: "assistant/tool-result", tool: "read", argument: "src/x.js" });
  assert.equal(line, "assistant/tool-result read (src/x.js)");
  const long = droppedUnitLine({
    kind: "assistant/tool-call",
    tool: "bash",
    argument: "x".repeat(400),
  });
  assert.ok(long.length <= 160);
});

test("a selection under twenty percent reduction falls back to native compaction", async (t) => {
  const native = nativeCompaction(t),
    records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async (url, { body }) => jevReply(body));
  const app = autoComposition({ pressure: true, keepRatio: 0.8, recordFile: "context-decisions.jsonl" });
  const events = contextHistory(app, [
    [{ type: "text", text: "r".repeat(3000) }],
    [{ type: "text", text: "a".repeat(1000) }],
  ]);
  events[2].data.message.source = { kind: "user" };
  events[2].data.message.role = "user";
  app.ctx.tokenMeter.measure = () => ({
    totalTokens: 2224,
    nodes: [100, 100, 750, 250, 1024].map((tokens) => ({ tokens })),
  });
  await app.step();
  assert.equal(native.compact.mock.callCount(), 1);
  assert.deepEqual(native.compact.mock.calls[0].arguments.slice(0, 2), [2, 3]);
  assert.ok(
    records.some(
      (record) => record.kind === "context_replaced" && record.reason === "selection_shortfall",
    ),
  );
});

test("a gateway failure pauses Jev for a minute; a rate limit stops it for the task", async (t) => {
  nativeCompaction(t);
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  let status = 502;
  const fetch = t.mock.method(globalThis, "fetch", async () => ({ ok: false, status, text: async () => "Unavailable" }));
  const app = autoComposition({ pressure: true, pressureTokens: 3000, recordFile: "context-decisions.jsonl" });
  await app.step();
  const paused = records.find((record) => record.kind === "jev_unavailable");
  assert.equal(paused.pausedMs, 60000);
  assert.equal(fetch.mock.callCount(), 2);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 61000);
  status = 429;
  await app.step();
  assert.ok(fetch.mock.callCount() > 2);
  const stopped = records.filter((record) => record.kind === "jev_unavailable").at(-1);
  assert.equal(stopped.httpStatus, 429);
  assert.equal(stopped.pausedMs, undefined);
});
