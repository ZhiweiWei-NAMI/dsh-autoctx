import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPriors, setPrior, priorOf, createPriorsStore, priorTextOf } from '../priors.js';

// Minimal in-memory table matching the host synchronous read/durable write contract.
const tableOf = initial => {
  let record = initial;
  return { get: () => record, put: async (_key, value) => { record = value; },
    update: async (_key, fn) => { record = fn(record); } };
};

test('set, replace and clear a prior retain exact text and a user history', () => {
  const empty = emptyPriors();
  let state = setPrior(empty, 'm', 'First\nprior', 10, 'public capability');
  assert.equal(priorOf(empty, 'm'), undefined);
  assert.equal(priorOf(state, 'm'), 'First\nprior');
  state = setPrior(state, 'm', 'Second prior', 20);
  state = setPrior(state, 'm', null, 30, 'restore catalog');
  assert.equal(priorOf(state, 'm'), undefined);
  assert.deepEqual(state.history, [
    { at: 10, model: 'm', before: null, after: 'First\nprior', source: 'user', reason: 'public capability' },
    { at: 20, model: 'm', before: 'First\nprior', after: 'Second prior', source: 'user' },
    { at: 30, model: 'm', before: 'Second prior', after: null, source: 'user', reason: 'restore catalog' },
  ]);
  assert.equal(setPrior(state, 'm', null, 40), state);
});

test('synchronous getter observes durable set/clear and reloads saved overrides', async () => {
  const table = tableOf(undefined), store = await createPriorsStore(table);
  assert.equal(priorTextOf('m'), undefined);
  await store.set('m', 'Actual override', 'reason', 100);
  assert.equal(priorTextOf('m'), 'Actual override');
  await createPriorsStore(table);
  assert.equal(priorTextOf('m'), 'Actual override');
  await store.set('m', null, undefined, 200);
  assert.equal(priorTextOf('m'), undefined);
  assert.equal(store.snapshot().history.length, 2);
});

test('invalid edits are refused and prototype-like ids remain ordinary data', () => {
  for (const value of ['', '  ', 0, false, undefined])
    assert.throws(() => setPrior(emptyPriors(), 'm', value, 1), TypeError);
  assert.throws(() => setPrior(emptyPriors(), '', 'prior', 1), TypeError);
  assert.throws(() => setPrior(emptyPriors(), 'm', 'prior', 1, {}), TypeError);
  const state = setPrior(emptyPriors(), '__proto__', 'text', 1);
  assert.equal(priorOf(state, '__proto__'), 'text');
  assert.equal(priorOf(emptyPriors(), 'constructor'), undefined);
});

test('storage failure never creates a successful edit in the getter', async () => {
  const initial = emptyPriors();
  const store = await createPriorsStore({ get: () => initial, update: async () => { throw new Error('write failed'); } });
  await assert.rejects(store.set('m', 'prior'));
  assert.equal(priorTextOf('m'), undefined);
});
