import test from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, propose, approve, reject, setMode, revert, setUser, withdraw, effective } from "../ledger.js";

const proposal = (key, target, evidence) => ({ key, target, basis: "b", uncertainty: 0.3, evidence: [evidence] });

test("auto applies one bounded step per new evidence and skips repeated evidence", () => {
  let ledger = emptyLedger("auto");
  ledger = propose(ledger, [proposal("t|m|reviewer", 1, "e1")], 1).ledger;
  assert.deepEqual(effective(ledger, "t|m|reviewer"), { weight: 0.75, source: "learned", n: 1, summary: "b" });
  const again = propose(ledger, [proposal("t|m|reviewer", 1, "e1")], 2);
  assert.deepEqual(again.skipped, ["t|m|reviewer"]);
  assert.equal(again.ledger.version, 1);
});

test("manual: one card, later proposals override, versions never repeat, approval binds to the shown version", () => {
  let ledger = emptyLedger("manual");
  ledger = propose(ledger, [proposal("t|m|reviewer", 1, "e1")], 1).ledger;
  ledger = propose(ledger, [proposal("t|m|reviewer", 0, "e2")], 2).ledger;
  assert.equal(ledger.pending.version, 2);
  assert.equal(ledger.pending.items["t|m|reviewer"].proposed, 0.25);
  assert.deepEqual(ledger.pending.items["t|m|reviewer"].evidence, ["e1", "e2"]);
  assert.equal(approve(ledger, 1, 3).error, "stale");
  ledger = reject(ledger, 2, 3).ledger;
  // Rejected evidence is not proposed again; a new batch gets a new version number.
  assert.deepEqual(propose(ledger, [proposal("t|m|reviewer", 0, "e2")], 4).skipped, ["t|m|reviewer"]);
  ledger = propose(ledger, [proposal("t|m|reviewer", 1, "e3")], 4).ledger;
  assert.equal(ledger.pending.version, 3);
  assert.equal(approve(ledger, 2, 5).error, "stale");
  ledger = approve(ledger, 3, 5).ledger;
  assert.equal(effective(ledger, "t|m|reviewer").weight, 0.75);
});

test("mode switches never apply the pending card; revert covers learned changes only; user weights win", () => {
  let ledger = emptyLedger("manual");
  ledger = propose(ledger, [proposal("t|m|reviewer", 1, "e1")], 1).ledger;
  ledger = setMode(ledger, "auto");
  assert.equal(ledger.version, 0);
  assert.ok(ledger.pending);
  ledger = approve(ledger, ledger.pending.version, 2).ledger;
  ledger = setUser(ledger, "t|m|reviewer", 0.2, 3);
  assert.equal(effective(ledger, "t|m|reviewer").weight, 0.2);
  assert.equal(revert(ledger, ledger.version, 4).error, "unknown");
  ledger = revert(ledger, 1, 4).ledger;
  ledger = setUser(ledger, "t|m|reviewer", null, 5);
  assert.deepEqual(effective(ledger, "t|m|reviewer").weight, 0.5);
});

test("withdrawn feedback leaves the pending card under a new version", () => {
  let ledger = emptyLedger("manual");
  ledger = propose(ledger, [proposal("t|m|reviewer", 1, "turn:x"), proposal("t|g|advisor", 0, "feedback:msg:1:advisor")], 1).ledger;
  ledger = withdraw(ledger, "feedback:msg:", 2).ledger;
  assert.deepEqual(Object.keys(ledger.pending.items), ["t|m|reviewer"]);
  assert.equal(ledger.pending.version, 2);
});
