import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apply } from "../index.js";
import { fakePlan, task, completed, tick, resultText } from "./plan-fixture.js";

test("delegation concludes the tool turn and queues a notice synchronously at turn/end", async () => {
  const app = fakePlan();
  const result = await app.accept([task("a"), task("b")]);
  assert.equal(result.concludesTurn, true);
  assert.equal(app.followups.length, 0);
  assert.equal(app.starts.length, 0);
  const returned = app.end();
  assert.equal(returned, undefined);
  assert.equal(app.followups.length, 1);
  assert.equal(app.starts.length, 0);
  const notice = app.followups[0];
  assert.equal(notice.source.kind, "dsh-autoctx");
  assert.match(notice.content[0].text, /^\[dsh-autoctx dispatcher\] Plan accepted\./);
  const queued = app.records.find((record) => record.kind === "dispatch_queued");
  assert.equal(queued.children.length, 2);
  assert.notEqual(queued.children[0], queued.children[1]);
  for (const child of queued.children) assert.ok(notice.content[0].text.includes(child));
  assert.match(notice.content[0].text, /Continue only your own subtasks/);
});

test("the next pre-step awaits establishment with reserved fork ids and unchanged composition", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = fakePlan({ establish: () => gate });
  await app.accept([task()]);
  app.end();
  const child = app.records.find((record) => record.kind === "dispatch_queued").children[0];
  let admitted = false;
  const preStep = app.start().then(() => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  assert.equal(app.starts.length, 1);
  const spec = app.starts[0];
  assert.equal(spec.childId, child);
  assert.equal(spec.provider, "fork");
  assert.equal(spec.delivery, "parent");
  assert.equal(spec.label, "Plan work");
  assert.equal(spec.request.maxDepth, 1);
  for (const key of ["agentOptions", "persona", "toolFilter", "outputSchema"]) assert.equal(Object.hasOwn(spec.request, key), false);
  release();
  await preStep;
  assert.equal(admitted, true);
  spec.settle();
  await tick();
});

test("dependent children start after settlement with the dependency's actual structured result", async () => {
  const app = fakePlan({ maxConcurrent: 1 });
  await app.accept([task("locate", { kind: "locate" }), task("fix", { dependsOn: ["locate"] })]);
  app.end();
  await app.start();
  assert.equal(app.starts.length, 1);
  const outcome = completed({ output: [{ type: "text", text: resultText({ summary: "Defect is in the missing branch", filesChanged: [], testsRun: [], openIssues: [] }) }] });
  app.starts[0].settle(outcome);
  await tick();
  assert.equal(app.starts.length, 1);
  assert.equal(app.followups.length, 2);
  await app.start();
  assert.equal(app.starts.length, 2);
  assert.equal(app.starts[1].label, "Plan fix");
  assert.match(app.starts[1].request.prompt[0].text, /Defect is in the missing branch/);
  assert.equal(app.records.filter((record) => record.kind === "child_settled").length, 1);
  app.starts[1].settle();
  await tick();
});

test("settlement queues a parent followup before awaiting dependent startup", async () => {
  const app = fakePlan({ maxConcurrent: 1 });
  await app.accept([task("a"), task("b", { dependsOn: ["a"] })]);
  app.end();
  await app.start();
  app.root.status = "idle";
  app.starts[0].settle();
  await Promise.resolve();
  assert.equal(app.followups.length, 2);
  assert.equal(app.starts.length, 1);
  await app.start();
  assert.equal(app.starts.length, 2);
  app.starts[1].settle();
  await tick();
});

test("Jev uses one suitability and one context call for the full delegated batch", async () => {
  const app = fakePlan({ planRouting: "jev", apiKey: "fake" });
  const result = await app.accept([task("a"), task("b")]);
  assert.equal(result.isError, false);
  assert.deepEqual(app.decisions.map((request) => request.trigger), ["plan_route", "plan_context"]);
  assert.equal(Object.keys(app.decisions[0].questions).length, 2);
  assert.equal(Object.keys(app.decisions[1].questions).length, 2);
});

test("mediation appends a labelled summary to each running sibling", async () => {
  const app = fakePlan({ planRouting: "jev", apiKey: "fake" });
  await app.accept([task("a"), task("b")]);
  app.end();
  await app.start();
  app.starts[0].settle(completed({ output: [{ type: "text", text: resultText({ summary: "Observed a shared interface mismatch", filesChanged: [], testsRun: [], openIssues: [] }) }] }));
  await tick();
  assert.equal(app.decisions.filter((request) => request.trigger === "plan_mediation").length, 1);
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].sender, app.root);
  assert.equal(app.messages[0].targetId, app.starts[1].childId);
  assert.equal(app.messages[0].content[0].text.split("\n")[0],
    `[from child ${app.starts[0].childId} · deepseek-v4.1-flash/high · subtask a · via dsh-autoctx]`);
  assert.match(app.messages[0].content[0].text, /Observed a shared interface mismatch/);
  const record = app.records.find((record) => record.kind === "message_appended" && record.messageKind === "relay");
  assert.equal(record.label, true);
  assert.equal(record.chars, app.messages[0].content[0].text.length);
  app.starts[1].settle();
  await tick();
});

test("D0 never calls Jev, including settlements with running siblings", async () => {
  const app = fakePlan({ apiKey: "fake", decide() { throw new Error("D0 called Jev"); } });
  await app.accept([task("a"), task("b")]);
  app.end();
  await app.start();
  app.starts[0].settle();
  await tick();
  assert.equal(app.decisions.length, 0);
  assert.equal(app.messages.length, 0);
  app.starts[1].settle();
  await tick();
});

test("a changed route gets agentOptions and the brief context starts a fresh spawn", async () => {
  const app = fakePlan({ planRouting: "jev", apiKey: "fake", decide(_agent, request) {
    return { answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, {
      type: "choice", confidence: 1, choice: key.startsWith("route_") ? "p1" : "brief",
    }])) };
  } });
  const result = await app.accept([task("a", { context: ["src/a.js"] })]);
  assert.equal(result.isError, false);
  app.end();
  await app.start();
  assert.equal(app.starts[0].provider, "spawn");
  assert.equal(app.starts[0].request.agentOptions.model, "glm-5.3-flash");
  assert.match(app.starts[0].request.prompt[0].text, /^\[from parent root · brief · via dsh-autoctx\]/);
  app.starts[0].settle();
  await tick();
});

test("a settled sibling is reused by append-only delivery in the same route", async () => {
  const app = fakePlan({ planRouting: "jev", apiKey: "fake", decide(_agent, request) {
    return { answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, {
      type: "choice", confidence: 1, choice: key.startsWith("route_") ? "p0" :
        Object.keys(question.criteria).find((option) => option.startsWith("sibling-reuse:")) ?? "parent-prefix",
    }])) };
  } });
  await app.accept([task("a", { context: ["a.js"] })]);
  app.end();
  await app.start();
  app.starts[0].settle();
  await tick();
  const child = app.starts[0].childId;
  const result = await app.accept([task("b", { context: ["b.js"] })], 2);
  assert.equal(result.value.assignments[0].contextOption, "sibling-reuse:" + child);
  app.end(2);
  await app.start();
  assert.equal(app.starts.length, 1);
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].targetId, child);
  assert.match(app.messages[0].content[0].text, /^\[from parent root · brief · via dsh-autoctx\]/);
  await app.dispatcher.onChildEnd({ id: child, stopReason: "completed", lastAssistantMessage: completed().output });
  assert.equal(app.records.filter((record) => record.kind === "child_settled").length, 2);
});

test("main-owned dependency results release a waiting child during the parent's running turn", async () => {
  const app = fakePlan();
  await app.accept([task("inspect", { owner: "main" }), task("fix", { dependsOn: ["inspect"] })]);
  app.end();
  await app.start();
  assert.equal(app.starts.length, 0);
  const child = app.records.find((record) => record.kind === "dispatch_queued").children[0];
  const result = await app.dispatcher.mainDependency(app.exec("send_message", { agent_id: child, message: "Inspection located the faulty guard" }));
  assert.equal(result, undefined);
  assert.equal(app.starts.length, 1);
  assert.match(app.starts[0].request.prompt[0].text, /Inspection located the faulty guard/);
  app.starts[0].settle();
  await tick();
});

function composition(t, overrides = {}) {
  const handlers = new Map(), tools = new Map(), guards = [], agents = new Map(), tables = new Map(), records = [];
  t.mock.method(fs, "appendFileSync", (_path, line) => records.push(JSON.parse(line)));
  const events = [], notices = [], starts = [];
  const signal = new AbortController().signal;
  const root = { options: { provider: "native", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
    session: { id: "root", header: { cwd: "/repo" }, snapshotEvents: () => events, requestHeader: () => undefined,
      deriveEventMessage: (event) => event.data?.message }, followup: (message) => notices.push(message) };
  agents.set("root", root);
  const ctx = {
    on: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); }, inject() {},
    tools: { register: (tool) => tools.set(tool.name, tool), guard: (guard) => guards.push(guard), get: (name) => tools.get(name) },
    agents: { get: (id) => agents.get(id) },
    llm: { prepareCall() { throw new Error("Fixed plan mode must not prepare alternative model routes"); } },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }), estimateMessage: (message) => JSON.stringify(message).length / 4 },
    storageDomain: { open: async (domain) => ({
      table(name) {
        const key = domain.name + ":" + name;
        if (!tables.has(key)) tables.set(key, new Map());
        return { get: (id) => tables.get(key).get(id), put: async (id, value) => tables.get(key).set(id, value) };
      }, close: async () => {},
    }) },
    subagents: { async startActivation(spec) {
      starts.push(spec);
      await overrides.establish?.();
      const child = { options: root.options, session: { id: spec.childId,
        header: { cwd: "/repo", parentSession: "root" }, snapshotEvents: () => [], requestHeader: () => undefined } };
      agents.set(spec.childId, child);
      for (const listener of handlers.get("subagent/start")) listener({ id: spec.childId });
      return { childId: spec.childId, result: new Promise(() => {}), dispose: async () => {} };
    } },
  };
  apply(ctx, { mode: "plan", planRouting: "fixed", planMaxChildren: 3, planMaxJevCalls: 6, planChildRequests: 2,
    maxConcurrent: 2, maxDecisions: 0, apiKey: "", adaptiveEffort: "high", reviewerModel: "auto",
    reviewBeforeFinish: true, advisorModel: "auto", economyGuidance: true, recordFile: "fake.jsonl", ...overrides });
  const preStep = (agent = root, turn = 1, next = async () => ({ kind: "continue", messages: [] })) =>
    handlers.get("agent/pre-step")[0]({ agent, turn, messages: [], signal }, next);
  return { root, ctx, tools, guards, notices, starts, handlers, preStep, records, agents, signal,
    async invoke(name, args, agent = root) {
      let concluded = false;
      const exec = { name, arguments: args, agent, signal, callId: "call", concludeTurn() { concluded = true; } };
      const denied = guards.map((guard) => guard(exec)).find(Boolean);
      if (denied) return { isError: true, error: { message: denied } };
      const result = await handlers.get("tools/execute")[0](exec, async () => {
        const value = await tools.get(name).execute(args, exec);
        return { isError: false, value, content: [], ...(concluded ? { concludesTurn: true } : {}) };
      });
      for (const listener of handlers.get("tools/result")) listener(exec, result);
      return result;
    },
    end(turn = 1) {
      const event = { seq: events.length, type: "turn/end", data: { turn, reason: { kind: "completed" } } };
      events.push(event);
      for (const listener of handlers.get("session/event")) listener(root.session, event);
    },
  };
}

test("plugin wiring registers the same plan tool for every agent and awaits starts before next", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = composition(t, { establish: () => gate });
  const admission = await app.preStep();
  assert.match(admission.messages[0].content[0].text, /Call plan before/);
  assert.equal(admission.messages.some((message) => /Execution economy/.test(message.content[0].text)), false);
  const result = await app.invoke("plan", { subtasks: [task()] });
  assert.equal(result.concludesTurn, true);
  assert.equal(app.notices.length, 0);
  app.end();
  assert.equal(app.notices.length, 1);
  let admitted = false;
  const pending = app.preStep(app.root, 2, async () => { admitted = true; return { kind: "continue", messages: [] }; });
  await tick();
  assert.equal(admitted, false);
  release();
  await pending;
  assert.equal(admitted, true);
  const spec = app.starts[0];
  assert.equal(spec.provider, "fork");
  assert.equal(Object.hasOwn(spec.request, "agentOptions"), false);
  assert.equal(Object.hasOwn(spec.request, "persona"), false);
  assert.equal(Object.hasOwn(spec.request, "toolFilter"), false);
  const child = app.agents.get(spec.childId);
  assert.equal(app.ctx.tools.get("plan", child), app.ctx.tools.get("plan", app.root));
  assert.match((await app.invoke("plan", { subtasks: [task()] }, child)).error.message, /cannot plan/);
  const blocked = app.guards[0]({ agent: app.root, name: "edit", arguments: { file_path: "work.js" } });
  assert.match(blocked, new RegExp(spec.childId));
});

test("plan child requests have their own cap and receive the final-request note", async (t) => {
  const app = composition(t);
  await app.preStep();
  await app.invoke("plan", { subtasks: [task()] });
  app.end();
  await app.preStep(app.root, 2);
  const child = app.agents.get(app.starts[0].childId);
  const stream = app.handlers.get("llm/stream")[0];
  const consume = async () => {
    for await (const _chunk of stream({ sessionId: child.session.id, model: child.options.model }, async function* () {})) {}
  };
  await consume();
  const admitted = await app.preStep(child, 1);
  assert.match(admitted.messages[0].content[0].text, /final model request under the plan child budget/);
  await consume();
  await assert.rejects(() => app.preStep(child, 2), /Plan child request budget exhausted/);
  await assert.rejects(consume, /Plan child model-call budget exhausted/);
});
