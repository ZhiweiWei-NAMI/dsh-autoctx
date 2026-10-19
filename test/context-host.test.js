import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  LlmAdapter, CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, createAssistantMessage,
} from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { apply } from "../index.js";

// Resolve the installed native packages used by index.js, not source aliases or
// a second BasicCompactionEngine copy. No compaction method or token measurement
// is mocked. The model, metadata persistence and unrelated delegation catalogs
// are fixtures; this exercises Cordis + Session, not the complete AgentLoop.
class SummaryAdapter extends LlmAdapter {
  summaries = [];
  resolved = [];
  async resolveModel(provider, model) {
    this.resolved.push(model);
    return { provider, id: model, name: model,
      context: { contextWindow: model === "routed-small" ? 100000 : 200000 } };
  }
  async *stream(options) {
    assert.equal(options.purpose, "compaction");
    this.summaries.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "Prior work checked. Keep the user's required final answer: RESULT 42." } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function memoryStorage() {
  const domains = new Map();
  return { async open(definition) {
    if (!domains.has(definition.name)) domains.set(definition.name, new Map());
    const tables = domains.get(definition.name);
    return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const values = tables.get(name);
      return { get: key => values.get(key), entries: () => values.entries(),
        put: async (key, value) => { values.set(key, value); },
        update: async (key, fn) => { values.set(key, fn(values.get(key))); },
        delete: async key => { values.delete(key); } };
    }, async close() {} };
  } };
}

function composition(session) {
  const ctx = new Context();
  new LlmRuntime(ctx);
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  const adapter = new SummaryAdapter();
  ctx.llm.registerAdapter(["native-test"], adapter);
  const agent = { session, options: { provider: "native-test", model: "fallback-large" } };
  ctx.provide("agents", { get: id => id === session.id ? agent : undefined });
  ctx.provide("tools", { guard() {}, get: () => ({ parameters: { type: "object" } }) });
  ctx.provide("subagents", { listChildren: async () => [], getProvider: () => undefined });
  ctx.provide("storageDomain", memoryStorage());
  apply(ctx, { mode: "auto", apiKey: "test-only-not-a-credential", routes: [],
    adaptiveEffort: "off", economyGuidance: false, pressureTokens: 64000,
    ceilingRatio: 1.5, retainTokens: 8000, nativeThresholdRatio: 0.8, maxDecisions: 12 });
  const signal = new AbortController().signal;
  return { ctx, agent, adapter, signal,
    preStep: (messages = []) => ctx.waterfall("agent/pre-step", {
      agent, messages, turn: 3, step: 1, signal,
    }, async () => ({ kind: "enter", messages })),
    recover: (failure = { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: "too much context" }, abort = signal) =>
      ctx.waterfall("agent/request-error", { agent, failure, turn: 3, step: 1, signal: abort }, () => undefined),
  };
}

function history({ routed = false, repeats = 200 } = {}) {
  const session = Session.create("context-native");
  for (let turn = 1; turn <= 2; turn++) {
    session.append("turn/start", { turn });
    session.append("step/start", { turn, step: 1 });
    if (routed && turn === 1) session.append("request/header", {
      reason: "initial", header: { config: { provider: "native-test", model: "routed-small", maxTokens: 10000 } },
    });
    session.append("user/message", createUserMessage({ source: { kind: "user" },
      content: [{ type: "text", text: "OLD HISTORY SENTINEL " + "old noise ".repeat(repeats) }] }), { surfaceOp: "append" });
    session.append("assistant/message", { turn, step: 1, stream: [],
      message: createAssistantMessage({ source: { provider: "native-test", model: "routed-small" },
        content: [{ type: "text", text: "prior evidence ".repeat(repeats) }] }) }, { surfaceOp: "append" });
    session.append("step/end", { turn, step: 1 });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  }
  session.append("turn/start", { turn: 3 });
  return session;
}

function visible(session) {
  return session.surface.nodes.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean);
}

function admit(session, messages) {
  session.append("step/start", { turn: 3, step: 1 });
  for (const message of messages) session.append("user/message", message, { surfaceOp: "append" });
  session.append("request/header", { reason: "initial",
    header: { config: { provider: "native-test", model: "routed-small", maxTokens: 10000 } } });
}

const assignment = () => createUserMessage({ source: { kind: "user" },
  content: [{ type: "text", text: "Continue the checked work; the required final answer is RESULT 42." }] });

test("the first routed request can recover native overflow and rebuild a smaller visible request only once", async () => {
  const session = history();
  const { ctx, adapter, preStep, recover } = composition(session);
  try {
    assert.equal(session.requestHeader(), undefined);
    const admitted = await preStep([assignment()]);
    assert.equal(admitted.kind, "enter");
    assert.equal(adapter.summaries.length, 0);
    // The real loop commits PreStepDecision.messages only after pre-step returns.
    admit(session, admitted.messages);
    const before = JSON.stringify(visible(session));
    const measured = ctx.tokenMeter.measure(session).totalTokens;
    assert.ok(before.includes("OLD HISTORY SENTINEL"));
    assert.deepEqual(await recover(), { kind: "retry" });
    const rebuilt = JSON.stringify(visible(session));
    assert.ok(!rebuilt.includes("OLD HISTORY SENTINEL"));
    assert.ok(rebuilt.includes("required final answer is RESULT 42"));
    assert.ok(rebuilt.length < before.length / 2);
    assert.ok(ctx.tokenMeter.measure(session).totalTokens < measured / 2);
    assert.equal(adapter.summaries.length, 1);
    assert.equal(adapter.summaries[0].model, "routed-small");
    assert.equal(session.snapshotEvents().filter(event => event.type === "compaction/summary").length, 1);
    assert.equal(await recover(), undefined, "a second overflow preserves the provider failure, not an infinite retry");
    assert.equal(adapter.summaries.length, 1);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("native model capacity and reserved output guard the AutoCTX surface before its unchanged 64k selection trigger", async () => {
  const session = history({ routed: true, repeats: 3200 });
  const { ctx, adapter, preStep } = composition(session);
  try {
    const before = ctx.tokenMeter.measure(session).totalTokens;
    // Native threshold: min(100000 * .8, 100000 - 10000 - 65536) = 24464.
    assert.ok(before > 24464 && before < 64000);
    const admitted = await preStep([assignment()]);
    assert.equal(admitted.kind, "enter");
    assert.equal(adapter.summaries.length, 1, "capacity pressure must not wait for Jev's 64k trigger or double-compact");
    assert.equal(adapter.summaries[0].model, "routed-small", "use the durable route, not the larger agent fallback");
    assert.ok(adapter.resolved.includes("routed-small"));
    assert.ok(ctx.tokenMeter.measure(session).totalTokens < 24464);
    assert.equal(session.surface.replaceGeneration, 1);
    const replay = Session.create("context-native-replay", session.snapshotEvents());
    assert.deepEqual(visible(replay), visible(session));
    assert.equal(ctx.tokenMeter.measure(replay).totalTokens, ctx.tokenMeter.measure(session).totalTokens);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("native recovery leaves cancellation and non-context provider errors untouched", async () => {
  const session = history();
  const { ctx, adapter, preStep, recover } = composition(session);
  try {
    const admitted = await preStep([assignment()]);
    admit(session, admitted.messages);
    const generation = session.surface.replaceGeneration;
    assert.equal(await recover({ code: "SERVER", message: "service unavailable" }), undefined);
    assert.equal(await recover(undefined, AbortSignal.abort()), undefined);
    assert.equal(adapter.summaries.length, 0);
    assert.equal(session.surface.replaceGeneration, generation);
  } finally {
    await ctx.fiber.dispose();
  }
});
