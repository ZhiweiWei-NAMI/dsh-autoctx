import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { apply } from "../index.js";
import { createGraph, observe, digest } from "../graph.js";
import { costUSD } from "../models.js";
import { STATE_BYTES } from "../decisions.js";
import { newStats, applyStatsRecord } from "../stats.js";
// Review and advisor briefs await the workspace diff before the child starts.
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  async function registerChild(child, parent = "root") {
    const agent = {
      session: childSession(child.id, parent), steer() {},
      ctx: {
        tools: { restrict: (filter) => { child.toolFilter = filter; } },
        systemPrompt: {
          getSectionOrder: () => 0,
          section: ({ text }) => { child.persona = text; },
        },
      },
    };
    agents.set(child.id, agent);
    await handlers.get("agent/created")({ agent });
    handlers.get("subagent/start")({ id: child.id, runId: child.id + "-run" });
  }
  async function startChild(provider, request, childId) {
    if (startError) throw startError;
    started++;
    const child = {
      id: childId ?? "child-" + started,
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
    await registerChild(child);
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
      get: () => ({
        parameters: { type: "object" },
        ...(options.activationAPI ? { output: { schema: {
          type: "object", properties: { kind: { const: "activation" } },
        } } } : {}),
      }),
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
            update: async (key, fn) => {
              if (!records.has(key)) throw new Error("missing-key");
              const next = fn(records.get(key));
              records.set(key, next);
              return next;
            },
          };
        },
        close: async () => {},
      }),
    },
    subagents: {
      listChildren: async () => children.map(({ kind, ...entry }) => entry),
      getProvider: () => ({}),
      start: startChild,
      startContinuable: async ({ childId, provider, label, request }) => {
        started++;
        const child = {
          id: childId, kind: "child", mode: "continuable", provider, label,
          prompt: request.prompt[0].text,
        };
        children.push(child);
        await registerChild(child, request.parent.session.id);
        return { childId, messageId: childId + "-message" };
      },
    },
  };
  if (options.activationAPI) {
    const { startContinuable } = ctx.subagents;
    delete ctx.subagents.start;
    delete ctx.subagents.startContinuable;
    ctx.subagents.startActivation = async ({ childId, provider, label, request, signal, delivery }) => {
      assert.equal(request.toolFilter, undefined);
      assert.equal(request.persona, undefined);
      if (delivery === "parent") {
        const receipt = await startContinuable({ childId, provider, label, request });
        return { ...receipt, result: new Promise(() => {}), dispose: async () => {} };
      }
      assert.equal(delivery, "caller");
      const run = await startChild(provider, { ...request, label, signal }, childId);
      return { childId: run.id, result: run.result, dispose: run.dispose };
    };
  }
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
  const app = collab({ activationAPI: true, advisorModel: "deepseek-v4.1-flash", advisorStallSteps: 3 });
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
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.children.some((child) => child.label === "Independent review"));
  app.settle();
  await pending;
  assert.equal(app.steered.length, 0); // the review completed with LGTM, which ends the turn
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
  const app = collab({ activationAPI: true, maxChildren: 2 });
  app.children.push(
    { id: "old-advisor", kind: "child", mode: "continuable", label: "Advisor" },
    { id: "old-review", kind: "child", mode: "continuable", label: "Independent review" },
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
  assert.equal(result.value.kind, "activation");
  assert.equal(app.started, 1);
  const child = app.children.find((child) => child.id === result.value.subagentId);
  assert.equal(child.mode, "continuable");
  assert.equal(child.label, "Inspect A");
  assert.match(child.prompt, /^You are a delegated child, not the parent/);
  assert.match(child.prompt, /Your assigned subtask:\nInspect A/);
  assert.equal(child.persona, undefined);
  assert.equal(child.toolFilter, undefined);
  assert.deepEqual(app.tables.get("assignments").get(child.id).composition, {});
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
  await tick();
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
  const app = collab({ activationAPI: true, reviewBeforeFinish: true, reviewerModel: "glm-5.3-flash" });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.read(app.root, "src/a.js");
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  const review = app.children.find((child) => child.label === "Independent review");
  assert.equal(review.provider, "spawn");
  assert.deepEqual(review.agentOptions, { provider: "workbuddy", model: "glm-5.3-flash" });
  assert.match(review.prompt, /## Evidence ledger\n/);
  assert.match(review.prompt, /src\/a\.js/);
  app.settle();
  await pending;
  assert.equal(app.steered.length, 0); // the review completed with LGTM, which ends the turn
});

test('the "same" reviewer forks; inside the first turn the fork has no seed, so the brief carries the ledger', async (t) => {
  recordAll(t);
  const app = collab({ reviewBeforeFinish: true });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  const review = app.children.find((child) => child.label === "Independent review");
  assert.equal(review.provider, "fork");
  assert.equal(review.agentOptions, undefined);
  // No tool filter: the fork keeps the parent's tool block and the guard enforces the reviewer's limits.
  assert.equal(review.toolFilter, undefined);
  assert.match(review.prompt, /## Evidence ledger/);
  app.settle();
  await pending;
});

test("delegation Jev states start with identical models knowledge; selection states carry none", async (t) => {
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
  // Context selection spends the whole state on history; model knowledge serves the delegation calls.
  assert.equal(states[2].models, undefined);
  for (const state of states.slice(0, 2)) assert.equal(Object.keys(state)[0], "models");
  assert.equal(states[0].models, states[1].models);
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

test("a forked reviewer keeps the tool block; the guard stops its edits and delegation", async (t) => {
  recordAll(t);
  const app = collab({ reviewBeforeFinish: true });
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  const reviewer = app.agents.get(app.children[0].id);
  const guard = app.handlers.get("tools/guard");
  assert.match(guard({ name: "edit", agent: reviewer, arguments: { file_path: "src/a.js" } }), /does not edit/);
  assert.match(guard({ name: "str_replace_editor", agent: reviewer, arguments: { command: "str_replace" } }), /does not edit/);
  assert.equal(guard({ name: "str_replace_editor", agent: reviewer, arguments: { command: "view" } }), undefined);
  assert.equal(guard({ name: "bash", agent: reviewer, arguments: { command: "git diff" } }), undefined);
  assert.match(guard({ name: "subagent", agent: reviewer, arguments: {}, callId: "x" }), /Nested delegation/);
  app.settle();
  await pending;
});

// Jev mock for the learning flow: role choice, then one batched fit score per used role at turn end.
function learningJev(t, { score = 4, choice = "glm-5.3-flash" } = {}) {
  const states = [];
  t.mock.method(globalThis, "fetch", async (url, { body }) => {
    const request = JSON.parse(body);
    const state = JSON.parse(request.state);
    states.push({ state, questions: request.questions });
    const answers = {};
    for (const [id, question] of Object.entries(request.questions))
      answers[id] = question.type === "choice"
        ? { type: "choice", choice: id === "task_tag" ? "debugging" : choice, confidence: 0.8,
            probabilities: { [choice]: 0.7 } }
        : question.type === "score"
          ? { type: "score", score, confidence: 0.6 }
          : { type: "noul", noul: 0.9 };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "jev", answers, usage: { input_tokens: 1000, output_tokens: 10 } }) };
  });
  return states;
}
async function reviewedTurn(app) {
  await app.preStep(app.root, [userMessage("Fix the widget.")]);
  app.edit(app.root, "src/a.js");
  const pending = app.stop();
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  app.settle();
  await pending;
  app.handlers.get("session/event")(app.root.session, { type: "turn/end", data: { turn: "turn", reason: { kind: "completed" } } });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("auto learning: the turn's reviewer gets one bounded weight step; candidates are not role-filtered", async (t) => {
  const records = recordAll(t);
  const states = learningJev(t);
  const app = collab({ reviewBeforeFinish: true, reviewerModel: "auto", learning: "auto", jevModel: "jev-1.13" });
  await reviewedTurn(app);
  const choice = states.find((x) => x.questions.model);
  // The executor's own model is a candidate and the tag is asked with the same call.
  assert.deepEqual(Object.keys(choice.questions.model.criteria).sort(), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
  assert.ok(choice.questions.task_tag);
  assert.doesNotMatch(choice.questions.model.instructions, /independence/);
  const learning = states.find((x) => x.state.trigger === "learning");
  assert.ok(learning.questions.fit_0);
  const ledger = [...app.tables.get("ledger").values()][0];
  assert.equal(ledger.mode, "auto");
  assert.equal(ledger.version, 1);
  assert.deepEqual(ledger.weights["debugging|glm-5.3-flash|reviewer"].learned, 0.75);
  assert.equal(ledger.weights["debugging|glm-5.3-flash|reviewer"].n, 1);
  // The unused candidate is untouched: not being chosen never lowers a weight.
  assert.equal(ledger.weights["debugging|deepseek-v4.1-flash|reviewer"], undefined);
  const use = records.find((r) => r.kind === "turn_use");
  assert.equal(use.roles[0].model, "glm-5.3-flash");
  assert.ok(use.cost.jev > 0);
  // A turn reopened after settling settles only what happened since: here nothing new.
  await app.preStep(app.root, [], "turn");
  await app.stop();
  assert.ok(records.some((r) => r.kind === "turn_reopened"));
  assert.equal([...app.tables.get("ledger").values()][0].version, 1);
  // The same turn ending again is not counted twice.
  app.handlers.get("session/event")(app.root.session, { type: "turn/end", data: { turn: "turn", reason: { kind: "completed" } } });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal([...app.tables.get("ledger").values()][0].version, 1);
});

test("manual learning queues one pending card; frozen only records", async (t) => {
  recordAll(t);
  learningJev(t, { score: 0 });
  const manual = collab({ reviewBeforeFinish: true, reviewerModel: "auto", learning: "manual" });
  await reviewedTurn(manual);
  const ledger = [...manual.tables.get("ledger").values()][0];
  assert.equal(ledger.version, 0);
  assert.equal(ledger.pending.version, 1);
  assert.deepEqual(ledger.pending.items["debugging|glm-5.3-flash|reviewer"].current, 0.5);
  assert.deepEqual(ledger.pending.items["debugging|glm-5.3-flash|reviewer"].proposed, 0.25);
  const frozen = collab({ reviewBeforeFinish: true, reviewerModel: "auto", learning: "frozen" });
  await reviewedTurn(frozen);
  assert.equal(frozen.tables.get("ledger")?.size ?? 0, 0);
  // Storage keys must be path-safe like the real per-record backend requires.
  for (const app of [manual, frozen])
    for (const name of ["ledger", "uses"])
      for (const key of app.tables.get(name)?.keys() ?? []) assert.match(key, /^[a-zA-Z0-9_-]+$/);
});
