import test from "node:test";
import assert from "node:assert/strict";
import { createOwnershipTracker, ownershipContract, appendOwnershipResult, OWNERSHIP_LABEL } from "../ownership.js";

function setup() {
  const records = [];
  const tracker = createOwnershipTracker((record) => records.push(record), () => "2026-10-18T00:00:00.000Z");
  const assign = (child = "child", assignment = "Investigate src/widget.js and src/records.js.") => {
    const reservation = tracker.reserve({ child, parent: "parent", description: "Investigate widget", assignment, cwd: "/repo" });
    reservation.accept();
    return tracker.entries.get(child);
  };
  const message = (id = "reply", child = "child", kind = "agent-message") => ({
    id, role: "user", source: { kind, senderSessionId: child }, content: [{ type: "text", text: "Concrete finding" }],
  });
  const deliver = (reply) => tracker.onEvent({ id: "parent" }, {
    type: "agent/inbox/spliced", data: { inserted: [reply] },
  });
  return { tracker, records, assign, message, deliver };
}

test("delegation tool result contains a two-sentence ownership contract and the native collection mechanism", () => {
  const value = { kind: "activation", subagentId: "worker" };
  const native = { isError: false, value, content: [{ type: "text", text: "started subagent worker" }] };
  const result = appendOwnershipResult(native, [ownershipContract("worker", "Investigate widget")]);
  const contract = result.content.at(-1).text;
  assert.equal(result.value, value);
  assert.match(contract, /Child worker now owns this subtask/);
  assert.match(contract, /disjoint work but must not redo its assigned work/);
  assert.match(contract, /send_message reply or native subagent-settled inbox notice before integrating/);
  assert.match(contract, /agent_id: "worker"/);
  assert.match(contract, /yield the turn/);
  assert.doesNotMatch(contract, /job_output/);
});

test("finish-time notes only name owned outstanding results and are bounded per assignment", () => {
  const { tracker, records, assign, message, deliver } = setup();
  assert.equal(tracker.dependencyNote("parent"), undefined);
  assign();
  assign("independent");
  const first = tracker.dependencyNote("parent");
  assert.match(first, /^\[AutoCTX ownership\] Outstanding child results:/);
  assert.match(first, /child .*running/);
  assert.match(first, /independent/);
  for (let index = 0; index < 5; index++) assert.equal(tracker.dependencyNote("parent"), undefined);
  assert.equal(tracker.dependencyNote("other-parent"), undefined);
  tracker.end("child");
  tracker.end("independent");
  const child = message(), independent = message("independent-result", "independent", "subagent-settled");
  deliver(child);
  deliver(independent);
  tracker.onRequest("parent", [child, independent]);
  assert.equal(tracker.dependencyNote("parent"), undefined);
  assert.equal(records.filter((record) => record.kind === "message_appended").length, 1);
  assert.equal(records.find((record) => record.kind === "message_appended").sourceLabel, OWNERSHIP_LABEL);
});

test("settlement without delivered output remains outstanding; consumed results do not prompt a finish note", () => {
  const { tracker, assign, message, deliver } = setup();
  assign();
  tracker.end("child");
  assert.equal(tracker.entries.get("child").state, "awaiting-delivery");
  assert.match(tracker.dependencyNote("parent"), /awaiting-delivery/);
  assign("completed");
  tracker.end("completed");
  const reply = message("completed-reply", "completed", "subagent-settled");
  deliver(reply);
  tracker.onRequest("parent", [reply]);
  assert.equal(tracker.entries.get("completed").state, "consumed");
  assert.equal(tracker.dependencyNote("parent"), undefined);
});

test("parent overlap notes are soft, conservative and once per child/path", () => {
  const { tracker, records, assign } = setup();
  const entry = assign();
  assert.equal(entry.assignment, "Investigate src/widget.js and src/records.js.");
  assert.equal(entry.parent, "parent");
  assert.equal(entry.state, "running");
  assert.equal(entry.startedAt, "2026-10-18T00:00:00.000Z");
  assert.deepEqual(tracker.toolNotes("parent", "read", { file_path: "src/disjoint.js" }, "/repo"), []);
  assert.deepEqual(tracker.toolNotes("other-parent", "read", { file_path: "src/widget.js" }, "/repo"), []);
  const first = tracker.toolNotes("parent", "read", { file_path: "./src/widget.js" }, "/repo");
  assert.equal(first.length, 1);
  assert.match(first[0], /Child child owns investigation of \/repo\/src\/widget.js/);
  assert.deepEqual(tracker.toolNotes("parent", "read", { path: "/repo/src/widget.js" }, "/repo"), []);
  const edit = tracker.toolNotes("parent", "edit", { path: "src/widget.js" }, "/repo");
  assert.equal(edit.length, 1); // one separate dependency reminder when integrating
  assert.equal(tracker.dependencyNote("parent"), undefined);
  const second = tracker.toolNotes("parent", "bash", { command: "sed -n '1,30p' src/records.js" }, "/repo");
  assert.equal(second.length, 1);
  assert.deepEqual(records.filter((record) => record.kind === "ownership_overlap"), [
    { kind: "ownership_overlap", parent: "parent", child: "child", tool: "read", path: "/repo/src/widget.js" },
    { kind: "ownership_overlap", parent: "parent", child: "child", tool: "bash", path: "/repo/src/records.js" },
  ]);
  assert.ok(records.filter((record) => record.kind === "message_appended").every((record) => record.sourceLabel === OWNERSHIP_LABEL));
});

test("assignment references, shell patterns and file contents alone are not evidence of investigation overlap", () => {
  const { tracker, records, assign } = setup();
  assign("reference", "Investigate the failure. Parent background: src/widget.js.");
  assert.deepEqual(tracker.toolNotes("parent", "read", { path: "src/widget.js" }, "/repo"), []);
  assign();
  assert.deepEqual(tracker.toolNotes("parent", "bash", { command: "rg 'src/widget.js' src/disjoint.js" }, "/repo"), []);
  assert.deepEqual(tracker.toolNotes("parent", "write", { path: "src/disjoint.js", content: "Inspect src/widget.js" }, "/repo"), []);
  assert.equal(records.filter((record) => record.kind === "ownership_overlap").length, 0);
});

test("editing an owned investigation produces one combined overlap/dependency note", () => {
  const { tracker, records, assign } = setup();
  assign();
  const notes = tracker.toolNotes("parent", "apply_patch", { patch: "*** Update File: src/widget.js\n@@\n-old\n+new" }, "/repo");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /owns investigation/);
  assert.match(notes[0], /Outstanding results/);
  assert.equal(tracker.dependencyNote("parent"), undefined);
  assert.equal(records.filter((record) => record.kind === "message_appended").length, 1);
});

test("inbox delivery and consumption are distinct, deduplicated and use actual projected request IDs", () => {
  const { tracker, records, assign, message, deliver } = setup();
  assign();
  const reply = message();
  deliver(reply);
  tracker.onEvent({ id: "parent" }, { type: "user/message", data: reply });
  tracker.onRequest("parent", []); // admission rejected or result omitted
  tracker.onRequest("other-parent", [reply]);
  assert.equal(records.filter((record) => record.kind === "child_result_delivered").length, 1);
  assert.equal(records.filter((record) => record.kind === "child_result_consumed").length, 0);
  assert.deepEqual(tracker.toolNotes("parent", "read", { path: "src/widget.js" }, "/repo"), []);
  tracker.onRequest("parent", [{ ...reply }]);
  tracker.onRequest("parent", [reply]);
  assert.deepEqual(records.filter((record) => record.kind.startsWith("child_result_")), [
    { kind: "child_result_delivered", parent: "parent", child: "child", at: "2026-10-18T00:00:00.000Z", via: "send_message" },
    { kind: "child_result_consumed", parent: "parent", child: "child", at: "2026-10-18T00:00:00.000Z", parentRequestAfter: true },
  ]);
  assert.match(tracker.dependencyNote("parent"), /running/); // a progress reply does not settle the child
  tracker.end("child");
  const settlement = message("settlement", "child", "subagent-settled");
  deliver(settlement);
  assert.equal(tracker.entries.get("child").state, "delivered");
  tracker.onRequest("parent", [settlement]);
  assert.equal(tracker.entries.get("child").state, "consumed");
  assert.equal(records.filter((record) => record.kind === "child_result_delivered").at(-1).via, "settlement-inbox");
});

test("delivered unread results prompt integration even after the child stops", () => {
  const { tracker, assign, message, deliver } = setup();
  assign("child", "Draft the change to src/widget.js.");
  tracker.end("child");
  deliver(message());
  assert.deepEqual(tracker.toolNotes("parent", "edit", { path: "src/disjoint.js" }, "/repo"), []);
  assert.match(tracker.toolNotes("parent", "edit", { path: "src/widget.js" }, "/repo")[0], /delivered/);
  assert.equal(tracker.dependencyNote("parent"), undefined);
});

test("reuse retains unread prior results, refreshes the assignment and rolls back rejected acceptance", () => {
  const { tracker, records, assign, message, deliver } = setup();
  const original = assign();
  const rejected = tracker.reserve({ child: "child", parent: "parent", description: "Rejected", assignment: "Inspect other.js", cwd: "/repo" });
  rejected.cancel();
  assert.equal(tracker.entries.get("child"), original);
  const reply = message();
  deliver(reply);
  tracker.end("child");
  assign("child", "Investigate src/new.js.");
  tracker.onRequest("parent", [reply]);
  assert.equal(records.filter((record) => record.kind === "child_result_consumed").length, 1);
  assert.equal(tracker.toolNotes("parent", "read", { path: "src/new.js" }, "/repo").length, 1);
  assert.deepEqual(tracker.toolNotes("parent", "read", { path: "src/widget.js" }, "/repo"), []);
  assert.equal(records.filter((record) => record.kind === "ownership_assigned").length, 2);
});

test("unrouted native child messages do not create ownership or consumption facts", () => {
  const { tracker, records, message, deliver } = setup();
  const reply = message("native", "native-child");
  deliver(reply);
  tracker.end("native-child");
  tracker.onRequest("parent", [reply]);
  assert.equal(tracker.dependencyNote("parent"), undefined);
  assert.deepEqual(records, []);
});
