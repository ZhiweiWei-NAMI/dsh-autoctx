import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("the host fork seeds only the completed plan turn and Session accepts it", {
  skip: !process.env.DSH_HOST_MODULES,
}, async () => {
  const host = (name) => import(pathToFileURL(resolve(process.env.DSH_HOST_MODULES, name, "lib/index.js")).href);
  const [{ apply }, { Session }, { createUserMessage, createAssistantMessage, createToolResultMessage }] = await Promise.all([
    host("dsh-subagent-fork-in-process"), host("dsh-session"), host("dsh-llm"),
  ]);
  const parent = Session.create("plan-parent");
  parent.append("turn/start", { turn: 1 });
  parent.append("step/start", { turn: 1, step: 1 });
  parent.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Fix the issue" }] }), { surfaceOp: "append" });
  const call = { type: "tool-call", id: "call-plan", name: "plan", arguments: JSON.stringify({ subtasks: [{
    id: "inspect", kind: "locate", owner: "delegate", goal: "Locate the defect", acceptance: "Name the cause", context: ["parent-history"],
  }] }) };
  parent.append("assistant/message", { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: "native", model: "main" }, content: [call],
  }) }, { surfaceOp: "append" });
  parent.append("tool/call", { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments });
  parent.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId: call.id,
    isError: false, content: [{ type: "text", text: "Plan accepted" }],
  }) }, { surfaceOp: "append" });
  parent.append("step/end", { turn: 1, step: 1 });
  const end = parent.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  parent.append("turn/start", { turn: 2 });
  const notice = parent.append("user/message", createUserMessage({ source: { kind: "dsh-autoctx" },
    content: [{ type: "text", text: "[dsh-autoctx dispatcher] Plan accepted." }],
  }), { surfaceOp: "append" });
  let provider;
  apply({ subagents: { registerProvider: (value) => { provider = value; } } }, { providerName: "fork" });
  const { seed } = await provider.prepareContinuable({ parent: { session: parent } });
  assert.equal(seed.at(-1).type, "turn/end");
  assert.equal(seed.at(-1).seq, end.seq);
  assert.equal(seed.some((event) => event.seq === notice.seq), false);
  assert.equal(seed.some((event) => event.type === "tool/call" && event.data.name === "plan"), true);
  const child = Session.create("plan-child", seed);
  assert.equal(child.snapshotEvents().filter((event) => event.type === "tool/result").length, 1);
});
