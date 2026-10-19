import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, uiInject } from '../index.js';
import { createRecordTap, createSessionResolver, registerUiRoutes } from '../uiapi.js';
import { createLedgerStore, createUiStore } from '../uistore.js';
import { emptyPriors } from '../priors.js';
import { propose } from '../ledger.js';

// Durable maps are shared by separate plugin instances; agents and taps are not.
function backend() {
  const domains = new Map();
  return { domains, async open(spec) {
    if (!domains.has(spec.name)) domains.set(spec.name, new Map());
    const tables = domains.get(spec.name);
    return { table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const values = tables.get(name);
      return { get: key => values.get(key), entries: () => values.entries(),
        put: async (key, value) => { values.set(key, structuredClone(value)); },
        update: async (key, fn) => { const value = fn(values.get(key)); values.set(key, structuredClone(value)); return value; } };
    }, close: async () => {} };
  } };
}
const headers = () => new Map([
  ['root', { id: 'root', cwd: '/workspace' }],
  ['child', { id: 'child', cwd: '/child', parentSession: 'root' }],
  ['finished', { id: 'finished', cwd: '/child', parentSession: 'child' }],
]);

function context(storageDomain, known = headers(), live = new Map(), queryAvailable = true) {
  const routes = new Map(), handlers = new Map(), disposals = [], queries = [];
  const ctx = {
    reflect: { provide: (name, service) => { ctx[name] = service; } },
    storageDomain, agents: { get: id => live.get(id) }, subagents: {}, tools: { guard() {} },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    effect(fn) { const disposal = fn(); if (typeof disposal === 'function') disposals.push(disposal); },
    inject(services, fn) { if (services.every(name => ctx[name] !== undefined)) fn(ctx); },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  if (queryAvailable) ctx.sessionQuery = { async filterSessions(filters) {
    queries.push(filters);
    assert.equal(filters.length, 1);
    assert.equal(filters[0].kind, 'id');
    return filters[0].values.filter(id => known.has(id)).map(id => ({ header: known.get(id), live: false, persisted: true }));
  } };
  const request = async (path, body) => {
    const url = new URL('http://localhost/api/dsh-autoctx/' + path);
    const response = await routes.get(url.pathname).fetch(new Request(url, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { ctx, queries, request, routes, async dispose() {
    for (const handler of handlers.get('dispose') ?? []) await handler();
    for (const dispose of disposals.reverse()) await dispose();
  } };
}

async function fixture(storageDomain = backend(), live = new Map(), queryAvailable = true) {
  const app = context(storageDomain, headers(), live, queryAvailable), tap = createRecordTap(2);
  const uiStore = createUiStore(app.ctx);
  const domain = await storageDomain.open({ name: 'dsh_auto' });
  const ledger = createLedgerStore(async () => domain, cwd => cwd === '/workspace' ? 'workspace' : 'other');
  const stats = new Map();
  registerUiRoutes(app.ctx, {
    config: {}, catalog: [], tap, uiStore, record() {},
    priors: { snapshot: emptyPriors },
    resolveSession: createSessionResolver(app.ctx.agents, () => app.ctx.sessionQuery),
    readStats: async id => stats.get(id) ?? await uiStore.stats(id),
    readLedger: cwd => ledger.read(cwd), readHistory: cwd => ledger.history(cwd),
    updateLedger: (cwd, fn) => ledger.update(cwd, fn),
  });
  return { ...app, tap, uiStore, ledger, stats, persist(record) {
    const projection = tap.push(record);
    if (projection) uiStore.append(projection);
  } };
}

const injection = at => ({ kind: 'message_appended', at, to: 'finished', from: 'root',
  messageKind: 'context', sourceLabel: 'AutoCTX context', label: true, contentSha256: 'digest-' + at, chars: 12 });
const pool = (role, at) => ({ kind: 'candidate_pool', session: 'root', role, at,
  candidates: [{ id: 'profile', model: 'model', provider: 'provider', efforts: ['high'] }],
  unavailable: [], filtered: [], memoized: false, basis: 'Observed configured pool' });

test('cold child resolves exact headers, recursive root and workspace for every session route', async () => {
  const app = await fixture();
  app.uiStore.saveStats('root', { mode: 'auto', decisions: 3, pendingSaved: { child: 20 } });
  await app.ledger.update('/workspace', ledger => propose(ledger, [{ key: 't|m|worker', target: 1, evidence: ['e1'] }], 1));
  for (const route of ['stats', 'ledger', 'history', 'injections', 'candidates']) {
    const result = await app.request(route + '?session=finished');
    assert.equal(result.status, 200, route);
    if (route === 'stats') { assert.equal(result.body.stats.decisions, 3); assert.equal(result.body.stats.pendingSaved, undefined); }
    if (route === 'ledger' || route === 'history') assert.equal(result.body.cwd, '/workspace');
    if (route === 'candidates') assert.equal(result.body.session, 'root');
  }
  const reverted = await app.request('ledger', { session: 'finished', action: 'revert', version: 1 });
  assert.equal(reverted.status, 200);
  assert.equal(reverted.body.ledger.weights[0].weight, 0.5);
  assert.equal(reverted.body.ledger.lastAutoReverted, true);
  assert.deepEqual(reverted.body.ledger.history.map(entry => entry.via), ['auto', 'revert']);
  assert.deepEqual(app.queries[0], [{ kind: 'id', values: ['finished'] }]);
  await app.dispose();
});

test('unknown session returns 404 on all routes, including mutations and explicit cwd overrides', async () => {
  const app = await fixture();
  for (const route of ['stats', 'ledger', 'history', 'injections', 'candidates']) {
    const result = await app.request(route + '?session=unknown');
    assert.equal(result.status, 404, route);
    assert.match(result.body.error, /session.*unavailable/);
  }
  assert.equal((await app.request('ledger?session=unknown&cwd=%2Fworkspace')).status, 404);
  assert.equal((await app.request('ledger', { session: 'unknown', cwd: '/workspace', action: 'mode', mode: 'manual' })).status, 404);
  assert.equal((await app.request('ledger?session=finished&cwd=%2Fother')).status, 400);
  assert.equal((await app.request('ledger')).status, 400);
  await app.dispose();
});

test('live headers and stats win over cold copies; agent attachment during a query also wins', async () => {
  const live = new Map([['root', { session: { header: { id: 'root', cwd: '/live' } } }]]);
  const app = await fixture(undefined, live);
  app.uiStore.saveStats('root', { decisions: 1 }); app.stats.set('root', { decisions: 9 });
  assert.equal((await app.request('ledger?session=root')).body.cwd, '/live');
  assert.equal((await app.request('stats?session=root')).body.stats.decisions, 9);
  assert.equal(app.queries.length, 0);
  const resolve = createSessionResolver({ get: id => live.get(id) }, () => ({ async filterSessions() {
    live.set('reattached', { session: { header: { id: 'reattached', cwd: '/new' } } });
    return [{ header: { id: 'reattached', cwd: '/old' } }];
  } }));
  assert.equal((await resolve('reattached')).cwd, '/new');
  await app.dispose();
});

test('metadata and summary stats survive restart and tap eviction, merge without duplicates, and page by turn', async () => {
  const storageDomain = backend(), first = await fixture(storageDomain);
  for (let at = 1; at <= 60; at++) first.persist({ ...injection(at), content: 'excluded body', privateField: 'excluded field' });
  first.persist(pool('worker', 20)); first.persist(pool('worker', 10));
  first.persist(pool('advisor', 30));
  first.uiStore.saveStats('root', { mode: 'auto', decisions: 4, cost: { jev: 0.12 } });
  await first.dispose();
  const next = await fixture(storageDomain);
  assert.deepEqual(next.tap.injections('finished'), []);
  next.tap.push(injection(1)); next.tap.push(injection(61));
  let result = await next.request('injections?session=finished&limit=7');
  assert.equal(result.body.total, 61); // persisted injection(1) is counted once, and the live-only entry is included.
  assert.equal(result.body.injections.length, 7);
  assert.equal(result.body.nextOffset, 7);
  next.tap.push(injection(1)); next.tap.push(injection(61));
  result = await next.request('injections?session=finished&start=55&end=61&limit=3');
  assert.equal(result.body.total, 7);
  assert.deepEqual(result.body.injections.map(record => record.at), [55, 56, 57]);
  assert.equal(JSON.stringify(result.body).includes('excluded'), false);
  result = await next.request('injections?session=finished&start=55&end=61&limit=3&offset=6');
  assert.deepEqual(result.body.injections.map(record => record.at), [61]);
  assert.equal(result.body.nextOffset, null);
  next.tap.push(pool('worker', 20));
  const candidates = (await next.request('candidates?session=finished')).body;
  assert.equal(candidates.total, 2);
  assert.deepEqual(candidates.pools.map(record => [record.role, record.at]), [['worker', 20], ['advisor', 30]]);
  assert.equal((await next.request('stats?session=finished')).body.stats.decisions, 4);
  const stored = [...storageDomain.domains.get('dsh_auto_ui').get('records').values()];
  assert.equal(stored.length, 63);
  assert.equal(JSON.stringify(stored).includes('excluded'), false);
  await next.dispose();
});

test('candidate role pages use true totals while retaining the latest pool for each role', async () => {
  const app = await fixture();
  for (let i = 0; i < 35; i++) app.persist(pool('role-' + i, i + 1));
  app.tap.push(pool('role-0', 100));
  const first = (await app.request('candidates?session=finished&limit=25')).body;
  const second = (await app.request('candidates?session=finished&limit=25&offset=25')).body;
  assert.equal(first.total, 35); assert.equal(first.pools[0].at, 100);
  assert.equal(first.nextOffset, 25); assert.equal(second.pools.length, 10); assert.equal(second.nextOffset, null);
  await app.dispose();
});

test('plugin loads without sessionQuery; live UI works and cold UI reports unavailable', async () => {
  assert.equal(inject.includes('sessionQuery'), false);
  assert.deepEqual(uiInject, ['sessionQuery']);
  const live = new Map([['root', { session: { header: { id: 'root', cwd: '/workspace' } } }]]);
  const app = context(backend(), headers(), live, false);
  assert.doesNotThrow(() => apply(app.ctx, { mode: 'native', learning: 'auto', maxDecisions: 0 }));
  assert.equal((await app.request('ledger?session=root')).status, 200);
  assert.equal((await app.request('stats?session=root')).status, 200);
  for (const route of ['stats', 'ledger', 'history', 'injections', 'candidates'])
    assert.equal((await app.request(route + '?session=finished')).status, 404, route);
  await app.dispose();
});
