import test from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, propose, approve, reject, setMode, revert, setUser, withdraw, effective } from "../ledger.js";
import { createLedgerStore } from "../uistore.js";

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

test("user reason and actual stored value are retained, including clearing an override", () => {
  let ledger = setUser(emptyLedger(), "t|m|worker", 0.23456, 10, "Prefer this route");
  assert.deepEqual(ledger.history.at(-1).changes, [
    { key: "t|m|worker", from: null, to: 0.235, source: "user", reason: "Prefer this route" },
  ]);
  ledger = setUser(ledger, "t|m|worker", null, 20, "Use learned weight");
  assert.deepEqual(ledger.history.at(-1).changes, [
    { key: "t|m|worker", from: 0.235, to: null, source: "user", reason: "Use learned weight" },
  ]);
  assert.equal(ledger.weights["t|m|worker"].user, undefined);
});

test("auto and approved changes preserve full basis, evidence ids and proposal source", () => {
  const item = { ...proposal("t|m|worker", 1, "turn:real"), basis: "Jev basis ".repeat(60), source: "jev" };
  for (const mode of ["auto", "manual"]) {
    let ledger = propose(emptyLedger(mode), [item], 1).ledger;
    if (mode === "manual") ledger = approve(ledger, ledger.pending.version, 2).ledger;
    const change = ledger.history.at(-1).changes[0];
    assert.equal(change.basis, item.basis);
    assert.equal(change.source, "jev");
    assert.deepEqual(change.evidence, ["turn:real"]);
    const restored = revert(ledger, ledger.version, 3).ledger.history.at(-1).changes[0];
    assert.equal(restored.basis, item.basis);
    assert.deepEqual(restored.evidence, ["turn:real"]);
  }
});

test("old histories and pending items without provenance remain usable", () => {
  const old = JSON.parse(JSON.stringify({ ...emptyLedger("manual"), version: 1,
    weights: { "t|m|worker": { learned: 0.75, n: 1 } },
    history: [{ version: 1, at: 1, via: "auto", changes: [{ key: "t|m|worker", from: 0.5, to: 0.75 }] }],
    pending: { version: 1, baseVersion: 1, items: { "t|m|worker": { current: 0.75, target: 1, proposed: 0.833, evidence: ["e2"] } } },
  }));
  const approved = approve(old, 1, 2).ledger;
  assert.equal(approved.weights["t|m|worker"].learned, 0.833);
  assert.equal(approved.history.at(-1).changes[0].source, undefined);
  assert.equal(revert(old, 1, 3).ledger.weights["t|m|worker"].learned, 0.5);
  assert.equal(setUser(old, "t|m|worker", 0, 4).weights["t|m|worker"].user, 0);
});

test("user edits refuse invalid values rather than clipping or coercing them", () => {
  for (const value of [-0.1, 1.1, NaN, Infinity, false, "0.5", undefined])
    assert.throws(() => setUser(emptyLedger(), "t|m|worker", value, 1), TypeError);
  assert.throws(() => setUser(emptyLedger(), "t|m|worker", 0.5, 1, {}), TypeError);
});

function storedLedger() {
  const states = new Map(), history = new Map();
  let failAt;
  const domain = { table: name => {
    const values = name === 'ledger' ? states : history;
    return { get: key => values.get(key), put: async (key, value) => {
      if (name === 'ledger_history' && key === failAt) throw new Error('interrupted history write');
      values.set(key, structuredClone(value));
    } };
  } };
  const reopen = () => createLedgerStore(async () => domain, cwd => cwd);
  return { states, history, reopen, store: reopen(), fail: key => { failAt = key; } };
}

test('pure ledger transitions do not truncate their append outbox at 20 changes', () => {
  let ledger = emptyLedger();
  for (let i = 1; i <= 50; i++) ledger = propose(ledger, [proposal('t|m|worker', i % 2, 'e' + i)], i).ledger;
  assert.deepEqual(ledger.history.map(entry => entry.version), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(revert(ledger, 1, 51).ledger.weights['t|m|worker'].learned, 0.5);
});

test('50 changes retain their order without growing the workspace record; oldest version reverts', async () => {
  const { store, states, history } = storedLedger();
  for (let i = 1; i <= 50; i++)
    await store.update('ws', ledger => propose(ledger, [proposal('t|m|worker', i % 2, 'e' + i)], i));
  assert.equal(history.size, 50);
  assert.deepEqual(states.get('ws').history, []);
  assert.equal(states.get('ws').historyCount, 50);
  assert.deepEqual([...await store.history('ws')].map(entry => entry.version), Array.from({ length: 50 }, (_, i) => i + 1));
  const result = await store.update('ws', (ledger, findApplied) => revert(ledger, 1, 51, findApplied(1)));
  assert.equal(result.error, undefined);
  assert.equal(result.ledger.weights['t|m|worker'].learned, 0.5);
  assert.equal(history.get('ws_51').of, 1);
  assert.equal(result.ledger.lastAutoReverted, false);
});

test('old inline history imports once, including equal-time rejected entries; interrupted import is idempotent', async () => {
  const fixture = storedLedger();
  let old = propose(emptyLedger(), [proposal('t|m|worker', 1, 'e1')], 1).ledger;
  old = setMode(old, 'manual');
  for (const id of ['e2', 'e3']) {
    old = propose(old, [proposal('t|m|worker', 0, id)], 2).ledger;
    old = reject(old, old.pending.version, 2).ledger;
  }
  fixture.states.set('ws', old);
  fixture.fail('ws_2');
  await assert.rejects(fixture.store.read('ws'), /interrupted/);
  assert.equal(fixture.states.get('ws').history.length, 3);
  fixture.fail(undefined);
  const reopened = fixture.reopen();
  await reopened.read('ws'); await reopened.read('ws');
  assert.equal(fixture.history.size, 3);
  assert.deepEqual([...await reopened.history('ws')].map(({ id, ...entry }) => entry), old.history);
  assert.deepEqual(fixture.states.get('ws').history, []);
  const result = await reopened.update('ws', (ledger, findApplied) => revert(ledger, 1, 3, findApplied(1)));
  assert.equal(result.ledger.lastAutoReverted, true);
});

test('a committed change outbox recovers after interruption; approved, user and revert changes persist', async () => {
  const fixture = storedLedger();
  fixture.fail('ws_1');
  await assert.rejects(fixture.store.update('ws', ledger => propose(ledger, [proposal('t|m|worker', 1, 'e1')], 1)));
  assert.equal(fixture.states.get('ws').version, 1);
  fixture.fail(undefined);
  const store = fixture.reopen();
  await store.read('ws');
  await store.update('ws', ledger => ({ ledger: setMode(ledger, 'manual') }));
  await store.update('ws', ledger => propose(ledger, [proposal('t|m|worker', 0, 'e2')], 2));
  await store.update('ws', ledger => approve(ledger, ledger.pending.version, 3));
  await store.update('ws', ledger => ({ ledger: setUser(ledger, 't|m|worker', 0.2, 4) }));
  await store.update('ws', (ledger, findApplied) => revert(ledger, 2, 5, findApplied(2)));
  assert.deepEqual([...await store.history('ws')].map(entry => entry.via), ['auto', 'approved', 'user', 'revert']);
  assert.equal((await store.read('ws')).weights['t|m|worker'].user, 0.2);
});
