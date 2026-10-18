import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { AUTOCTX_FORK, closedStepSeed, createClosedStepForkProvider, sameRequestConfig } from "../seed.js";
import { messageAppended, createMessageAudit } from "../routing.js";

function history({ completed = false, closed = true } = {}) {
  const events = [];
  const append = (type, data) => events.push({ type, data, seq: events.length, time: 1234 });
  if (completed) {
    append("turn/start", { turn: 1 });
    append("turn/end", { turn: 1, reason: { kind: "completed" } });
  }
  const turn = completed ? 2 : 1;
  append("turn/start", { turn });
  if (closed) {
    append("step/start", { turn, step: 1 });
    append("tool/call", { turn, step: 1, callId: "read", name: "read" });
    append("tool/result", { turn, step: 1, message: { toolCallId: "read" } });
    append("step/end", { turn, step: 1 });
  }
  const boundary = events.length - 1;
  append("step/start", { turn, step: closed ? 2 : 1 });
  append("tool/call", { turn, step: closed ? 2 : 1, callId: "delegate", name: "subagent" });
  return { events, boundary };
}

function nativeProvider() {
  const calls = [];
  const provider = { name: "fork", capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: true,
    async prepareContinuable(request) {
      calls.push(request);
      const events = request.parent.session.snapshotEvents();
      const end = events.findLast((event) => event.type === "turn/end");
      return end ? { seed: events.slice(0, end.seq + 1) } : {};
    } };
  return { provider, calls, subagents: { getProvider: (name) => name === "fork" ? provider : undefined } };
}

test("closed-step seed is an unchanged contiguous prefix with balanced turn/step endings", () => {
  const { events, boundary } = history();
  const before = JSON.stringify(events);
  const seed = closedStepSeed(events);
  assert.deepEqual(seed.slice(0, boundary + 1), events.slice(0, boundary + 1));
  assert.equal(seed[boundary], events[boundary]);
  assert.deepEqual(seed.map((event) => event.seq), Array.from({ length: seed.length }, (_, index) => index));
  assert.equal(seed.at(-2).type, "session/end-seed");
  assert.deepEqual(seed.at(-1).data, { turn: 1, reason: { kind: "forked" } });
  assert.equal(seed.filter((event) => event.type === "turn/start").length,
    seed.filter((event) => event.type === "turn/end").length);
  assert.equal(seed.filter((event) => event.type === "step/start").length,
    seed.filter((event) => event.type === "step/end").length);
  assert.equal(seed.some((event) => event.data.callId === "delegate"), false);
  assert.equal(JSON.stringify(events), before);
});

test("provider uses closed steps without changing native capabilities or its fallback", async () => {
  const native = nativeProvider(), facts = [];
  const provider = createClosedStepForkProvider(native.subagents, (_request, fact) => facts.push(fact));
  const { events } = history();
  const request = { parent: { session: { snapshotEvents: () => events } } };
  const prepared = await provider.prepareContinuable(request);
  assert.equal(provider.name, AUTOCTX_FORK);
  assert.equal(provider.capabilities, native.provider.capabilities);
  assert.equal(provider.inheritsParentContext, native.provider.inheritsParentContext);
  assert.equal(native.calls.length, 0);
  assert.deepEqual(facts, [{ seeded: true, seedEvents: prepared.seed.length, seedBoundary: "closed-step" }]);
});

test("no closed step in the in-flight turn delegates to native completed-turn prefix or empty seed", async () => {
  for (const completed of [false, true]) {
    const native = nativeProvider(), facts = [];
    const provider = createClosedStepForkProvider(native.subagents, (_request, fact) => facts.push(fact));
    const { events } = history({ completed, closed: false });
    const request = { parent: { session: { snapshotEvents: () => events } } };
    assert.equal(closedStepSeed(events), undefined);
    const prepared = await provider.prepareContinuable(request);
    assert.deepEqual(native.calls, [request]);
    assert.deepEqual(prepared, completed ? { seed: events.slice(0, 2) } : {});
    assert.deepEqual(facts, [{ seeded: completed, seedEvents: completed ? 2 : 0,
      seedBoundary: completed ? "completed-turn" : "empty" }]);
  }
});

test("a prior turn's closed step is not mistaken for a closed step in the current turn", () => {
  const { events } = history();
  const seed = closedStepSeed(events);
  seed.push({ type: "turn/start", seq: seed.length, time: 1234, data: { turn: 2 } });
  assert.equal(closedStepSeed(seed), undefined);
});

test("message audit hashes exact UTF-8 text blocks joined with two newlines", () => {
  const blocks = [{ type: "text", text: "Context: 中文\n" }, { type: "image", url: "unused" },
    { type: "text", text: "  Assignment\n" }];
  const text = "Context: 中文\n\n\n  Assignment\n";
  assert.deepEqual(messageAppended("child", "parent", "assignment", "AutoCTX delegation · p/high", blocks), {
    kind: "message_appended", to: "child", from: "parent", messageKind: "assignment",
    sourceLabel: "AutoCTX delegation · p/high", label: true,
    contentSha256: createHash("sha256").update(text, "utf8").digest("hex"), chars: text.length,
  });
  assert.equal(sameRequestConfig({ provider: "p", model: "m", reasoningEffort: "high" },
    { provider: "p", model: "m", reasoningEffort: "low" }), false);
});

test("remote message audit includes native attribution and return guidance only after actual append", async () => {
  const records = [], audit = createMessageAudit((record) => records.push(record));
  const content = [{ type: "text", text: "Inspect the real finding\n" }];
  const session = { id: "child" };
  audit.expect("child", "parent", "assignment", "AutoCTX delegation · p/high", content);
  assert.equal(records.length, 0);
  const committed = [{ type: "text", text: "Native sender attribution" }, ...content,
    { type: "text", text: "Native return guidance" }];
  audit.onEvent(session, { type: "user/message", data: { content: committed } });
  assert.deepEqual(records, [messageAppended("child", "parent", "assignment", "AutoCTX delegation · p/high", committed)]);
  audit.onEvent(session, { type: "user/message", data: { content: committed } });
  assert.equal(records.length, 1);
  await assert.rejects(audit.deliver("child", "parent", "assignment", "label", content,
    async () => { throw new Error("delivery failed"); }), /delivery failed/);
  audit.onEvent(session, { type: "user/message", data: { content: committed } });
  assert.equal(records.length, 1);
});

test("host accepts closed-step seed and projects byte-identical inherited messages before child messages", {
  skip: !process.env.DSH_HOST_MODULES,
}, async () => {
  const host = (name) => import(pathToFileURL(resolve(process.env.DSH_HOST_MODULES, name, "lib/index.js")).href);
  const [{ Session, buildForkSeed, canonicalHeader, deriveEventMessage }, llm] = await Promise.all([
    host("dsh-session"), host("dsh-llm"),
  ]);
  const parent = Session.create("seed-parent");
  const config = { provider: "native", model: "main", reasoningEffort: "high" };
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
  parent.append("turn/start", { turn: 1 });
  parent.append("step/start", { turn: 1, step: 1 });
  parent.append("system/message", { turn: 1, step: 1, message: llm.createSystemMessage("Shared system\n") }, { surfaceOp: "append" });
  parent.append("user/message", llm.createUserMessage({ source: { kind: "user" },
    content: [{ type: "text", text: "Inspect the defect" }] }), { surfaceOp: "append" });
  parent.append("request/header", { header: canonicalHeader({ config, tools }), reason: "initial" });
  const call = { type: "tool-call", id: "read-1", name: "read", arguments: "{}" };
  parent.append("assistant/message", { turn: 1, step: 1, stream: [],
    message: llm.createAssistantMessage({ source: { provider: "native", model: "main" }, content: [call] }) }, { surfaceOp: "append" });
  parent.append("tool/call", { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments });
  parent.append("tool/result", { turn: 1, step: 1, message: llm.createToolResultMessage({ callId: call.id,
    isError: false, content: [{ type: "text", text: "Actual inspection result\n" }] }) }, { surfaceOp: "append" });
  const boundary = parent.append("step/end", { turn: 1, step: 1 });
  const prefix = parent.deriveMessages();
  const requestHeader = parent.requestHeader();
  parent.append("step/start", { turn: 1, step: 2 });
  const delegate = { type: "tool-call", id: "delegate", name: "subagent", arguments: "{}" };
  parent.append("assistant/message", { turn: 1, step: 2, stream: [],
    message: llm.createAssistantMessage({ source: { provider: "native", model: "main" }, content: [delegate] }) }, { surfaceOp: "append" });
  parent.append("tool/call", { turn: 1, step: 2, callId: delegate.id, name: delegate.name, arguments: delegate.arguments });
  const events = parent.snapshotEvents(), seed = closedStepSeed(events);
  assert.deepEqual(seed, buildForkSeed(events, boundary.seq));
  assert.equal(seed.some((event) => event.type === "tool/call" && event.data.callId === delegate.id), false);
  for (const closer of seed.slice(boundary.seq + 1)) assert.equal(deriveEventMessage(closer), null);
  // Match startLocal's inheritedEventCount = prepared.seed.length, including
  // closers; Session adds its own final inherited marker as the host requires.
  const child = Session.create("seed-child", seed, { ...parent.header, id: "seed-child",
    isSeeded: true, parentSession: parent.id }, seed.length);
  assert.equal(child.header.isSeeded, true);
  assert.equal(child.inheritedEventCount, seed.length);
  assert.equal(JSON.stringify(child.deriveMessages()), JSON.stringify(prefix));
  assert.equal(JSON.stringify(child.requestHeader()), JSON.stringify(requestHeader));
  child.append("turn/start", { turn: 2 });
  child.append("step/start", { turn: 2, step: 1 });
  for (const text of ["Child assignment", "Child runtime context"]) child.append("user/message",
    llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }), { surfaceOp: "append" });
  assert.equal(JSON.stringify(child.deriveMessages().slice(0, prefix.length)), JSON.stringify(prefix));
  assert.deepEqual(child.deriveMessages().slice(prefix.length).map((message) => message.content[0].text),
    ["Child assignment", "Child runtime context"]);
});
