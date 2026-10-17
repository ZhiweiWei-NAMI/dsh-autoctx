import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { apply } from "../index.js";
import { createGraph, observe, digest } from "../graph.js";
import { costUSD } from "../models.js";
import { STATE_BYTES } from "../decisions.js";
import { newStats, applyStatsRecord } from "../stats.js";

function childSession(id, parent = "root") {
  return {
    id,
    header: { parentSession: parent },
    requestHeader: () => undefined,
    snapshotEvents: () => [],
    surface: { nodes: [] },
    eventAt: () => ({ data: { message: { content: [], source: { kind: "user" } } } }),
    deriveEventMessage: () => ({ content: [], source: { kind: "user" } }),
  };
}

function collab(options = {}) {
  const handlers = new Map(),
    agents = new Map(),
    children = [],
    steered = [],
    tables = new Map();
  let started = 0,
    settlement = null,
    startError = null;
  const signal = new AbortController().signal;
  const config = {
    mode: "auto",
    apiKey: "test-key",
    jevModel: "jev-test",
    jevEndpoint: "https://jev.invalid",
    recordFile: "collab.jsonl",
    routes: [],
    modelRoutes: {
      "glm-5.3-flash": "workbuddy",
      "deepseek-v4.1-flash": "workbuddy",
    },
    allowPaidModels: false,
    reviewerModel: "same",
    advisorModel: "off",
    advisorMaxConsults: 2,
    advisorStallSteps: 3,
    maxChildren: 2,
    maxConcurrent: 2,
    maxChildRequests: 16,
    maxChildTurnRequests: 8,
    maxDecisions: 10,
    pressureTokens: 2000,
    ceilingRatio: 1.5,
    retainTokens: 1024,
    economyGuidance: false,
    keepRatio: 0.35,
    reviewBeforeFinish: false,
    reviewMaxRequests: 10,
    ...options,
  };
  const events = [];
  const root = {
    options: { provider: "native", model: "deepseek-v4.1-flash" },
    session: {
      id: "root",
      header: {},
      requestHeader: () => undefined,
      snapshotEvents: () => events,
      surface: { nodes: [] },
      eventAt: () => ({ data: { message: { content: [], source: { kind: "user" } } } }),
      deriveEventMessage: () => ({ content: [], source: { kind: "user" } }),
    },
    steer: (message) => steered.push(message),
  };
  agents.set("root", root);
  async function startChild(provider, request) {
    if (startError) throw startError;
    started++;
    const child = {
      id: "child-" + started,
      kind: "child",
      mode: "one-shot",
      provider,
      label: request.label,
      prompt: request.prompt[0].text,
      agentOptions: request.agentOptions,
      toolFilter: request.toolFilter,
      maxDepth: request.maxDepth,
    };
    children.push(child);
    agents.set(child.id, { session: childSession(child.id), steer() {} });
    handlers.get("subagent/start")({ id: child.id, runId: child.id + "-run" });
    const result = new Promise((resolve) => {
      const finish = async (reason = "completed", output) => {
        const blocks =
          output ??
          [{ type: "text", text: request.label === "Advisor" ? "Try the import path." : "LGTM" }];
        await handlers.get("subagent/end")({
          id: child.id,
          runId: child.id + "-run",
          stopReason: reason,
          lastAssistantMessage: blocks,
        });
        resolve({ stopReason: reason, output: blocks });
      };
      settlement = finish;
      if (request.label === "Advisor") queueMicrotask(() => finish());
    });
    return { id: child.id, result, dispose: async () => (child.disposed = true) };
  }
  const ctx = {
    tools: {
      guard: (fn) => handlers.set("tools/guard", fn),
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
      measure: () => ({ totalTokens: 100, nodes: [] }),
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
            put: async (key, value) => records.set(key, value),
          };
        },
        close: async () => {},
      }),
    },
    subagents: {
      listChildren: async () => children,
      getProvider: () => ({}),
      start: startChild,
      startContinuable: async ({ childId, provider, label, request }) => {
        started++;
        children.push({
          id: childId, kind: "child", mode: "continuable", provider, label,
          prompt: request.prompt[0].text,
        });
        agents.set(childId, { session: childSession(childId, request.parent.session.id), steer() {} });
        handlers.get("subagent/start")({ id: childId, runId: childId + "-run" });
      },
    },
  };
  apply(ctx, config);
  return {
    config,
    ctx,
    root,
    agents,
    children,
    handlers,
    steered,
    events,
    tables,
    setStartError: (error) => (startError = error),
    get started() {
      return started;
    },
    preStep: (agent = root, messages = [], turn = "turn", next = async () => ({ kind: "continue" })) =>
      handlers.get("agent/pre-step")(
        { agent, messages, turn, signal },
        next,
      ),
    edit: (agent = root, path = "src/a.js") =>
      handlers.get("tools/result")(
        { name: "edit", agent, arguments: { file_path: path }, callId: "edit-" + path },
        { isError: false, content: [] },
      ),
    read: (agent = root, path = "src/a.js") =>
      handlers.get("tools/result")(
        { name: "read", agent, arguments: { file_path: path, limit: 10 }, callId: "read-" + path },
        { isError: false, content: [] },
      ),
    settle: (reason, output) => settlement?.(reason, output),
    stop: (turn = "turn", agent = root) =>
      handlers.get("agent/turn-stopping")({ agent, turn, signal }),
    guidance: (messages = []) =>
      messages
        .filter((message) => message.source.kind === "dsh-autoctx")
        .map((message) => message.content[0].text)
        .join("\n"),
    stored: (id) => tables.get("graphs")?.get(id),
  };
}

function recordAll(t) {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  return records;
}

const userMessage = (text) => ({
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

test("graphs are fed from tool results per session and persisted for restore", async (t) => {
  recordAll(t);
  const app = collab();
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.read(app.root, "src/a.js");
  app.edit(app.root, "src/a.js");
  const child = { session: childSession("child"), steer() {} };
  app.agents.set("child", child);
  await app.preStep(child, [], "turn-2");
  app.read(child, "src/child.js");
  await app.preStep(child, [], "turn-2");
  await app.preStep(child, [], "turn-2");
  app.read(child, "src/child.js");
  await app.stop("turn", child);
  await app.preStep(app.root, [{
    source: { kind: "subagent-settled", senderSessionId: "child" }, content: [],
  }]);
  await app.stop("turn");
  const rootGraph = app.stored("root");
  assert.match(digest(rootGraph), /^edit src\/a\.js/m);
  assert.match(digest(rootGraph), /read L1-10 src\/a\.js/);
  assert.match(digest(app.stored("child")), /read L1-10 src\/child\.js/);
  assert.equal(rootGraph.requests, 2);
  assert.equal(app.stored("child").requests, 3);
});

test("a continued child restores its own graph from storage", async (t) => {
  recordAll(t);
  const app = collab();
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  const child = { session: childSession("child"), steer() {} };
  app.agents.set("child", child);
  await app.preStep(child, [], "turn-2");
  app.read(child, "src/child.js");
  await app.preStep(child, [], "turn-2");
  await app.stop("turn", child);
  const saved = structuredClone(app.stored("child"));
  assert.ok(saved, "child graph was persisted");

  const resumed = collab();
  resumed.tables.set("graphs", new Map([["child", saved]]));
  const resumedChild = { session: childSession("child"), steer() {} };
  resumed.agents.set("child", resumedChild);
  await resumed.preStep(resumedChild, [], "turn-3");
  resumed.edit(resumedChild, "src/child.js");
  await resumed.stop("turn", resumedChild);
  assert.match(digest(resumed.stored("child")), /^edit src\/child\.js/m);
  assert.equal(resumed.stored("child").requests, 3);
  assert.equal(resumed.stored("child").files["src/child.js"].edits[0].step, 3);
});

test("the ledger note is appended once after a compaction", async (t) => {
  recordAll(t);
  const app = collab({ mode: "native" });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.read(app.root, "src/a.js");
  app.handlers.get("session/event")(app.root.session, { type: "compaction/summary" });
  await app.preStep(app.root, [], "turn", async () => ({ kind: "reject" }));
  const first = await app.preStep(app.root, []);
  assert.match(app.guidance(first.messages), /^Evidence ledger of this session/);
  assert.match(app.guidance(first.messages), /src\/a\.js/);
  assert.equal(app.guidance((await app.preStep(app.root, [])).messages), "");
});

test("sync notes only cover paths this session read, edited by another session, at the tail", async (t) => {
  const records = recordAll(t);
  const app = collab();
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.read(app.root, "src/a.js");
  app.read(app.root, "src/b.js");
  const child = { session: childSession("child"), steer() {} };
  app.agents.set("child", child);
  await app.preStep(child, [], "turn-2");
  app.edit(child, "src/a.js");
  app.edit(child, "src/b.js");
  app.edit(child, "src/c.js");
  await app.preStep(app.root, [], "turn", async () => ({ kind: "reject" }));
  assert.equal(records.filter((record) => record.kind === "sync_note").length, 0);
  const admitted = await app.preStep(app.root, []);
  const note = app.guidance(admitted.messages);
  assert.match(note, /^Collaborator changes since your last step:/);
  assert.match(note, /- src\/a\.js edited by child/);
  assert.match(note, /- src\/b\.js edited by child/);
  assert.doesNotMatch(note, /src\/c\.js/);
  assert.equal(admitted.messages.at(-1).content[0].text, note);
  assert.deepEqual(records.find((record) => record.kind === "sync_note").paths, ["src/a.js", "src/b.js"]);
  assert.equal(app.guidance((await app.preStep(app.root, [])).messages), "");
  app.read(child, "src/a.js");
  await app.preStep(app.root, [{
    source: { kind: "subagent-settled", senderSessionId: "child" }, content: [],
  }]);
  app.read(app.root, "src/b.js");
  assert.equal(app.guidance((await app.preStep(child, [])).messages), "");
  for (let i = 0; i < 9; i++) {
    app.read(app.root, "src/extra-" + i);
    app.edit(child, "src/extra-" + i);
  }
  const first = app.guidance((await app.preStep()).messages);
  const second = app.guidance((await app.preStep()).messages);
  assert.equal(first.split("\n").length, 8);
  assert.equal(second.split("\n").length, 5);
  assert.match(second, /src\/extra-8/);
  assert.equal(app.guidance((await app.preStep()).messages), "");
});

test("auto advice waits for a slot and falls back when the Jev budget is exhausted", async (t) => {
  const records = recordAll(t);
  const app = collab({
    advisorModel: "auto",
    maxDecisions: 0,
    maxConcurrent: 1,
    modelRoutes: { "deepseek-v4.1-flash": "workbuddy", "deepseek-v4-pro": "workbuddy" },
  });
  await app.preStep();
  app.agents.set("busy", { session: childSession("busy") });
  app.handlers.get("subagent/start")({ id: "busy", runId: "busy-1" });
  for (let i = 0; i < 4; i++) await app.preStep();
  assert.equal(app.started, 0);
  await app.handlers.get("subagent/end")({ id: "busy", runId: "busy-1", stopReason: "completed" });
  const admitted = await app.preStep();
  assert.match(app.guidance(admitted.messages), /^Advisor /);
  assert.equal(records.find((record) => record.kind === "model_choice").via, "fallback");
  assert.equal(app.started, 1);
});

test("repeated failure uses own event order and resets the stall baseline", async (t) => {
  const records = recordAll(t);
  const app = collab({ advisorModel: "deepseek-v4.1-flash", maxConcurrent: 1, maxChildren: 3 });
  await app.preStep();
  const fail = () => app.handlers.get("tools/result")(
    { name: "bash", agent: app.root, arguments: { command: "npm test" } },
    { isError: true, content: [{ type: "text", text: "1 failed" }] },
  );
  fail();
  app.edit();
  fail();
  fail();
  app.edit();
  fail();
  const child = { session: childSession("other") };
  app.agents.set("other", child);
  app.handlers.get("subagent/start")({ id: "other", runId: "other-1" });
  for (let i = 0; i < 2; i++) await app.preStep();
  await app.handlers.get("subagent/end")({ id: "other", runId: "other-1", stopReason: "completed" });
  const admitted = await app.preStep();
  assert.match(app.guidance(admitted.messages), /on repeated failure: npm test:/);
  fail();
  await app.preStep();
  assert.equal(records.filter((record) => record.kind === "advisor_start").length, 1);
});

test("the advisor fires once on a stall and passes the chosen model", async (t) => {
  const records = recordAll(t);
  const app = collab({ advisorModel: "deepseek-v4.1-flash", advisorStallSteps: 3 });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  let consulted = "";
  for (let i = 0; i < 6; i++) {
    const admitted = await app.preStep(app.root, []);
    const text = app.guidance(admitted.messages);
    if (text.includes("Advisor (")) consulted = text;
  }
  assert.match(consulted, /^Advisor \(deepseek-v4\.1-flash, independent, no tool access\) on stall:/);
  assert.match(consulted, /Try the import path\./);
  assert.match(consulted, /Treat this as a hypothesis/);
  const advisor = app.children.find((child) => child.label === "Advisor");
  assert.equal(advisor.provider, "spawn");
  assert.deepEqual(advisor.agentOptions, { provider: "native", model: "deepseek-v4.1-flash" });
  assert.deepEqual(advisor.toolFilter, { allow: [] });
  assert.equal(advisor.maxDepth, 1);
  assert.equal(records.filter((record) => record.kind === "advisor_start").length, 1);
  assert.equal(
    records.find((record) => record.kind === "advisor_end").chars,
    "Try the import path.".length,
  );
});

test("mismatched test summaries leave earlier segments unknown", () => {
  const graph = createGraph();
  observe(graph, 1, {
    name: "bash",
    arguments: { command: "pytest a.py -q && pytest --bad-flag b.py" },
  }, {
    isError: true,
    text: "5 passed\nERROR: usage: pytest [options] unrecognized arguments: --bad-flag",
  });
  assert.deepEqual(Object.values(graph.tests).map(({ runs }) => [runs.at(-1).outcome, runs.at(-1).summary]), [
    ["unknown", ""],
    ["pass", "5 passed"],
  ]);
});

test("cost requires finite input and output counts but defaults absent cache to zero", () => {
  const model = "deepseek-v4.1-flash";
  assert.equal(costUSD(model), undefined);
  assert.equal(costUSD(model, { output: 1e6 }), undefined);
  assert.equal(costUSD(model, { input: 1e6 }), undefined);
  assert.equal(costUSD(model, { input: "1e6", output: 1e6 }), undefined);
  assert.equal(costUSD(model, { input: NaN, output: 1e6 }), undefined);
  assert.equal(costUSD(model, { input: 1e6, output: Infinity }), undefined);
  assert.equal(costUSD(model, { input: 1e6, output: 1e6 }), 0.75);
  assert.equal(costUSD(model, { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), 0.75);
});

test("advisor respects the consult cap and failure records advice_failed", async (t) => {
  const records = recordAll(t);
  const capped = collab({
    advisorModel: "deepseek-v4.1-flash",
    advisorStallSteps: 3,
    advisorMaxConsults: 1,
  });
  await capped.preStep(capped.root, [userMessage("Fix the widget.")]);
  for (let i = 0; i < 8; i++) await capped.preStep(capped.root, []);
  assert.equal(records.filter((record) => record.kind === "advisor_start").length, 1);

  const failed = collab({ advisorModel: "deepseek-v4.1-flash", advisorStallSteps: 3 });
  failed.setStartError(new Error("provider refused"));
  await failed.preStep(failed.root, [userMessage("Fix the widget.")]);
  let admitted;
  for (let i = 0; i < 5; i++) admitted = await failed.preStep(failed.root, []);
  assert.equal(admitted.kind, "continue");
  assert.equal(records.filter((record) => record.kind === "advisor_failed").length, 1);
  assert.match(records.find((record) => record.kind === "advisor_failed").error, /provider refused/);
});

test("advisor consults do not use up the review child slot", async (t) => {
  recordAll(t);
  const app = collab({
    advisorModel: "deepseek-v4.1-flash",
    advisorStallSteps: 3,
    reviewBeforeFinish: true,
    maxChildren: 2,
    advisorMaxConsults: 2,
  });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  const fail = (command) => app.handlers.get("tools/result")(
    { name: "bash", agent: app.root, arguments: { command } },
    { isError: true, content: [{ type: "text", text: "1 failed" }] },
  );
  fail("npm test");
  app.edit(app.root, "src/a.js");
  fail("npm test");
  app.edit(app.root, "src/a.js");
  fail("npm test");
  fail("pytest");
  app.edit(app.root, "src/a.js");
  fail("pytest");
  app.edit(app.root, "src/a.js");
  fail("pytest");
  await app.preStep(app.root, []);
  await app.preStep(app.root, []);
  assert.equal(app.children.filter((child) => child.label === "Advisor").length, 2);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.children.some((child) => child.label === "Independent review"));
  app.settle();
  await pending;
  assert.equal(app.steered.length, 1);
});

test("helpers from a resumed listing do not consume delegation slots", async (t) => {
  const records = recordAll(t);
  const states = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    const request = JSON.parse(body);
    states.push(JSON.parse(request.state));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev",
          answers: {
            independent: { type: "noul", noul: 0.95 },
            useful: { type: "score", score: 2, confidence: 0.9 },
            fit_0: { type: "score", score: 1.8, confidence: 0.8 },
          },
        }),
    };
  });
  const app = collab({ maxChildren: 2 });
  app.children.push(
    { id: "old-advisor", kind: "child", mode: "one-shot", label: "Advisor" },
    { id: "old-review", kind: "child", mode: "one-shot", label: "Independent review" },
  );
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  const exec = {
    name: "subagent",
    arguments: { prompt: "Inspect A", description: "Inspect A" },
    callId: "call-1",
    agent: app.root,
    signal: new AbortController().signal,
  };
  assert.equal(app.handlers.get("tools/guard")(exec), undefined);
  const result = await app.handlers.get("tools/execute")(
    exec,
    () => {
      throw new Error("unexpected native dispatch");
    },
  );
  assert.equal(result.isError, false);
  assert.equal(result.value.kind, "continuable");
  assert.equal(app.started, 1);
  const child = app.children.find((child) => child.id === result.value.subagentId);
  assert.equal(child.mode, "continuable");
  assert.equal(child.label, "Inspect A");
  assert.match(child.prompt, /Your assigned subtask:\nInspect A/);
  assert.ok(records.some((record) => record.kind === "child_start" && record.id === child.id));
  assert.equal(states.length, 1);
  assert.equal(states[0].observation.childrenRemaining, 2);
});

test("maxConcurrent still counts a running helper", async (t) => {
  recordAll(t);
  const app = collab({
    advisorModel: "deepseek-v4.1-flash",
    advisorStallSteps: 3,
    reviewBeforeFinish: true,
    maxConcurrent: 1,
    maxChildren: 2,
  });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.children.some((child) => child.label === "Independent review"));
  const fail = () => app.handlers.get("tools/result")(
    { name: "bash", agent: app.root, arguments: { command: "npm test" } },
    { isError: true, content: [{ type: "text", text: "1 failed" }] },
  );
  fail();
  app.edit(app.root, "src/a.js");
  fail();
  app.edit(app.root, "src/a.js");
  fail();
  for (let i = 0; i < 2; i++) await app.preStep(app.root, []);
  assert.equal(app.children.filter((child) => child.label === "Advisor").length, 0);
  app.settle();
  await pending;
  await app.preStep(app.root, []);
  assert.equal(app.children.filter((child) => child.label === "Advisor").length, 1);
});

test("a configured cross-model reviewer uses spawn, agentOptions and the ledger", async (t) => {
  recordAll(t);
  const app = collab({ reviewBeforeFinish: true, reviewerModel: "glm-5.3-flash" });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.read(app.root, "src/a.js");
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const review = app.children.find((child) => child.label === "Independent review");
  assert.equal(review.provider, "spawn");
  assert.deepEqual(review.agentOptions, { provider: "workbuddy", model: "glm-5.3-flash" });
  assert.match(review.prompt, /Parent evidence ledger:\n/);
  assert.match(review.prompt, /src\/a\.js/);
  app.settle();
  await pending;
  assert.equal(app.steered.length, 1);
});

test('the "same" reviewer keeps the fork review without a model brief', async (t) => {
  recordAll(t);
  const app = collab({ reviewBeforeFinish: true });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const review = app.children.find((child) => child.label === "Independent review");
  assert.equal(review.provider, "fork");
  assert.equal(review.agentOptions, undefined);
  assert.doesNotMatch(review.prompt, /Parent evidence ledger:/);
  app.settle();
  await pending;
});

test("the Jev state starts with identical models knowledge across calls in one root task", async (t) => {
  recordAll(t);
  const states = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    const request = JSON.parse(body);
    states.push(JSON.parse(request.state));
    assert.ok(Buffer.byteLength(request.state) <= STATE_BYTES);
    const answers = states.at(-1).trigger === "selection"
      ? Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key,
        question.type === "score"
          ? { type: "score", score: 0, confidence: 0.9 }
          : { type: "choice", choice: "archive", confidence: 0.9 },
      ]))
      : {
        independent: { type: "noul", noul: 0.95 },
        useful: { type: "score", score: 2, confidence: 0.9 },
        fit_0: { type: "score", score: 1.8, confidence: 0.8 },
      };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev",
          answers,
        }),
    };
  });
  const app = collab();
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  const execute = (prompt, callId) =>
    app.handlers.get("tools/execute")(
      {
        name: "subagent",
        arguments: { prompt, description: prompt },
        callId,
        agent: app.root,
        signal: new AbortController().signal,
      },
      () => {
        throw new Error("unexpected native dispatch");
      },
    );
  await execute("Inspect A", "call-1");
  await execute("Inspect B", "call-2");
  const events = Array.from({ length: 35 }, (_, seq) => ({
    seq,
    type: "assistant/message",
    data: { message: {
      role: "assistant", source: { kind: "assistant" },
      content: [{ type: "text", text: "e".repeat(800) }],
    } },
  }));
  Object.assign(app.root.session, {
    requestHeader: () => ({}),
    snapshotEvents: () => events,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => event.data.message,
  });
  app.ctx.tokenMeter.measure = () => ({
    totalTokens: 35000, nodes: events.map(() => ({ tokens: 1000 })),
  });
  t.mock.method(BasicCompactionEngine.prototype, "compactRegion", async () => ({ shadowedSeqs: [2] }));
  await app.preStep(app.root, [userMessage("Constraints: " + "x".repeat(9000))]);
  assert.equal(states.length, 3);
  assert.equal(states[2].trigger, "selection");
  assert.ok(states[2].history.length < 32);
  for (const state of states) assert.equal(Object.keys(state)[0], "models");
  assert.equal(states[0].models, states[1].models);
  assert.equal(states[0].models, states[2].models);
  assert.match(states[0].models, /glm-5\.3-flash/);
});

test("stats count advisor, sync, ledger and model-choice records", () => {
  let stats = newStats("auto", 12, 64000);
  stats = applyStatsRecord(stats, { kind: "advisor_end" });
  stats = applyStatsRecord(stats, { kind: "sync_note" });
  stats = applyStatsRecord(stats, { kind: "ledger_note" });
  stats = applyStatsRecord(stats, { kind: "model_choice", via: "config" });
  assert.equal(stats.advisors, 1);
  assert.equal(stats.syncNotes, 1);
  assert.equal(stats.ledgerNotes, 1);
  assert.equal(stats.modelChoices, 1);
});

test("one failed fix attempt does not consult the advisor", async (t) => {
  const records = recordAll(t);
  const app = collab({ advisorModel: "deepseek-v4.1-flash", advisorStallSteps: 50 });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  const fail = () => app.handlers.get("tools/result")(
    { name: "bash", agent: app.root, arguments: { command: "npm test" } },
    { isError: true, content: [{ type: "text", text: "1 failed" }] },
  );
  fail();
  app.edit(app.root, "src/a.js");
  fail();
  await app.preStep(app.root, []);
  assert.equal(records.filter((record) => record.kind === "advisor_start").length, 0);
});
