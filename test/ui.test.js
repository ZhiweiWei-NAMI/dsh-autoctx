import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordTap, registerUiRoutes } from '../uiapi.js';
import { emptyPriors, setPrior } from '../priors.js';

function fixture(overrides = {}) {
  const routes = new Map(), tap = createRecordTap(100);
  let priorState = emptyPriors();
  const priors = { snapshot: () => priorState,
    set: async (model, value, reason) => { priorState = setPrior(priorState, model, value, 100, reason); } };
  const ctx = { inject: (_services, fn) => fn(ctx), effect: fn => fn(),
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => {}; } } } };
  const deps = { tap, priors, config: { routes: [{ id: 'r', model: 'custom', provider: 'p', efforts: ['high'] }], modelRoutes: { m: 'p' } },
    catalog: [{ id: 'm', prior: 'catalog text', routes: ['p'] }], statsRoot: id => id === 'child' ? 'root' : id === 'grandchild' ? 'child' : id,
    cwdOf: id => id === 'root' ? '/workspace' : undefined,
    readLedger: async () => ({ history: Array.from({ length: 12 }, (_, i) => ({
      version: i + 1, at: i + 1, via: 'auto', changes: [{ key: 't|m|worker', from: 0.5, to: 0.6,
        basis: 'Jev basis', evidence: ['turn:' + i], source: 'jev' }],
    })) }), ...overrides };
  registerUiRoutes(ctx, deps);
  const request = async (path, body) => {
    const url = new URL('http://localhost/api/dsh-autoctx/' + path), route = routes.get(url.pathname);
    const response = await route.fetch(new Request(url, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { request, tap, priors, routes };
}
const injection = (to, at = 1) => ({ kind: 'message_appended', at, to, from: 'root', messageKind: 'context',
  sourceLabel: 'Task context', label: true, contentSha256: 'a'.repeat(64), chars: 30 });
const pool = (role, at = 1, session = 'root') => ({ kind: 'candidate_pool', at, session, role,
  candidates: [{ id: 'r', model: 'm', provider: 'p', efforts: ['high'] }], unavailable: [{ id: 'u', reason: 'not installed' }],
  filtered: [{ model: 'f', reason: 'policy' }], memoized: false, basis: 'Exact\nbasis from backend' });

test('injections use recipient session, retain metadata only, and have a bounded buffer', async () => {
  const { tap, request } = fixture();
  tap.push({ ...injection('child'), content: 'must not be copied', apiKey: 'excluded-field' });
  tap.push(injection('root', 2));
  const result = await request('injections?session=child');
  assert.deepEqual(result.body.injections, [injection('child')]);
  assert.equal((await request('injections?session=unknown')).body.injections.length, 0);
  assert.equal((await request('injections')).status, 400);
  const bounded = createRecordTap(1);
  bounded.push(injection('child')); bounded.push(injection('child', 2));
  assert.deepEqual(bounded.injections(['child']), [injection('child', 2)]);
  assert.throws(() => createRecordTap(0), TypeError);
});

test('candidate pools are latest per root role; fallback describes uncomputed configured data', async () => {
  const { tap, request } = fixture();
  const uncomputed = (await request('candidates?session=child')).body;
  assert.equal(uncomputed.computed, false);
  assert.equal(uncomputed.status, 'not computed yet');
  assert.equal(uncomputed.configured.routes[0].model, 'custom');
  assert.deepEqual(uncomputed.configured.catalog, [{ id: 'm', providers: ['p'] }]);
  tap.push(pool('worker', 20)); tap.push(pool('worker', 10));
  tap.push({ ...pool('advisor', 30), memoized: true }); tap.push(pool('worker', 40, 'unrelated'));
  const result = (await request('candidates?session=grandchild')).body;
  assert.equal(result.session, 'root');
  assert.deepEqual(result.pools.map(entry => [entry.role, entry.at]), [['worker', 20], ['advisor', 30]]);
  assert.equal(result.pools[0].basis, 'Exact\nbasis from backend');
  assert.deepEqual(result.pools[0].unavailable, [{ id: 'u', reason: 'not installed' }]);
  assert.equal(result.pools[1].memoized, true);
});

test('history pages all retained ledger entries and prior edits; filters include evidence ids', async () => {
  const { request, priors } = fixture();
  await priors.set('m', 'override', 'User rationale');
  let result = await request('history?session=child&limit=5');
  assert.equal(result.body.total, 13);
  assert.equal(result.body.entries[0].kind, 'prior');
  assert.equal(result.body.nextOffset, 5);
  result = await request('history?session=root&limit=5&offset=10');
  assert.equal(result.body.entries.length, 3);
  assert.equal(result.body.nextOffset, null);
  result = await request('history?session=root&q=turn%3A0');
  assert.equal(result.body.total, 1);
  assert.equal(result.body.entries[0].reason, 'Jev basis');
  result = await request('history?kind=prior');
  assert.equal(result.body.total, 1);
  result = await request('history?session=root&via=auto');
  assert.equal(result.body.total, 12);
});

test('old history without provenance projects missing fields without fabricated evidence counts', async () => {
  const { request } = fixture({ readLedger: async () => ({ history: [{ at: 1, version: 1, via: 'rejected', changes: [{ key: 't|m|worker', kept: 0.5 }] }] }) });
  const entry = (await request('history?session=root')).body.entries[0];
  assert.equal(entry.before, 0.5); assert.equal(entry.after, 0.5);
  assert.equal(entry.evidence, undefined); assert.equal(entry.reason, undefined); assert.equal(entry.source, undefined);
});

test('priors list catalog and configured models; edits and clearing preserve reasons', async () => {
  const { request, priors } = fixture();
  let result = await request('priors');
  assert.deepEqual(result.body.models.map(model => model.id), ['m', 'custom']);
  assert.equal(result.body.models[0].catalog, 'catalog text');
  result = await request('priors', { model: 'custom', value: 'Private capability note', reason: 'Observed behavior' });
  assert.equal(result.body.models[1].override, 'Private capability note');
  assert.equal(priors.snapshot().history[0].reason, 'Observed behavior');
  await request('priors', { model: 'custom', value: null });
  assert.equal(priors.snapshot().overrides.custom, undefined);
});

test('invalid input returns 400; failed persistence returns 500 without exposing error text', async () => {
  const { request } = fixture();
  for (const path of ['history?session=root&limit=0', 'history?session=root&offset=-1', 'history?session=root&limit=101',
    'history?session=root&kind=unknown', 'history?session=root&via=unknown', 'history?session=missing'])
    assert.equal((await request(path)).status, 400, path);
  for (const body of ['{', [], { model: 'missing', value: 'text' }, { model: 'm', value: '' },
    { model: 'm', value: false }, { model: 'm', value: null, reason: 1 }])
    assert.equal((await request('priors', body)).status, 400);
  const broken = fixture({ priors: { snapshot: emptyPriors, set: async () => { throw new TypeError('private storage detail'); } } });
  const result = await broken.request('priors', { model: 'm', value: 'new text' });
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes('private storage detail'), false);
});
