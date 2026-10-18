// Read-only session facts and UI persistence projections; no model calls or session mutations.
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
class InputError extends Error {}
const bad = message => { throw new InputError(message); };
const idsOf = ids => new Set(Array.isArray(ids) ? ids : [ids]);
const stamp = value => typeof value === 'number' ? value : Date.parse(value);

/** Bounded metadata projection of the agreed backend records; unrelated record kinds are ignored. */
export function createRecordTap(limit = 1000) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('tap limit must be a positive integer');
  const records = [];
  return {
    push(record) {
      let item;
      if (record.kind === 'message_appended' && record.label === true) {
        const { at, to, from, messageKind, sourceLabel, contentSha256, chars } = record;
        item = { kind: record.kind, at, to, from, messageKind, sourceLabel, label: true, contentSha256, chars };
      } else if (record.kind === 'candidate_pool') {
        const { at, session, role, candidates, unavailable, filtered, memoized, basis } = record;
        item = { kind: record.kind, at, session, role,
          candidates: candidates?.map(({ id, model, provider, efforts }) => ({ id, model, provider, efforts: efforts?.slice() })),
          unavailable: unavailable?.map(({ id, reason }) => ({ id, reason })),
          filtered: filtered?.map(({ model, reason }) => ({ model, reason })), memoized, basis };
      } else return;
      records.push(item);
      if (records.length > limit) records.splice(0, records.length - limit);
    },
    injections(sessionIds) {
      const ids = idsOf(sessionIds);
      return structuredClone(records.filter(record => record.kind === 'message_appended' && ids.has(record.to)));
    },
    candidates(sessionIds) {
      const ids = idsOf(sessionIds), latest = new Map();
      for (const record of records) if (record.kind === 'candidate_pool' && ids.has(record.session)) {
        const previous = latest.get(record.role);
        if (!previous || stamp(record.at) >= stamp(previous.at)) latest.set(record.role, record);
      }
      return structuredClone([...latest.values()]);
    },
  };
}

/** Catalog + configured routes, retaining priors-only ids after a route is removed. */
export function priorModels(catalog, config, state) {
  const models = new Map(catalog.map(entry => [entry.id, { id: entry.id, catalog: entry.prior, routes: [] }]));
  const add = (model, route) => {
    if (!models.has(model)) models.set(model, { id: model, routes: [] });
    if (route) models.get(model).routes.push(route);
  };
  for (const route of config.routes ?? []) add(route.model, { id: route.id, provider: route.provider, efforts: route.efforts });
  for (const [model, provider] of Object.entries(config.modelRoutes ?? {})) add(model, { provider });
  for (const model of Object.keys(state.overrides)) add(model);
  return [...models.values()].map(model => ({ ...model,
    ...(Object.hasOwn(state.overrides, model.id) ? { override: state.overrides[model.id] } : {}) }));
}

export function historyEntries(ledger, priors) {
  return [
    ...ledger.history.flatMap(entry => (entry.changes ?? []).map((change, index) => ({
      id: 'ledger:' + entry.version + ':' + entry.at + ':' + index,
      kind: 'ledger', at: entry.at, key: change.key, version: entry.version, via: entry.via,
      source: change.source, before: Object.hasOwn(change, 'from') ? change.from : change.kept,
      after: Object.hasOwn(change, 'to') ? change.to : change.kept,
      reason: change.reason ?? change.basis, basis: change.basis, evidence: change.evidence,
    }))),
    ...priors.history.map((entry, index) => ({ ...entry, id: 'prior:' + index, kind: 'prior', via: 'prior' })),
  ].sort((a, b) => stamp(b.at) - stamp(a.at));
}

function page(url, entries) {
  const integer = (key, fallback, max) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) bad('invalid ' + key);
    return Number(raw);
  };
  const offset = integer('offset', 0, Number.MAX_SAFE_INTEGER), limit = integer('limit', 25, 100);
  if (!limit) bad('limit must be positive');
  return { entries: entries.slice(offset, offset + limit), total: entries.length, offset, limit,
    nextOffset: offset + limit < entries.length ? offset + limit : null };
}

/** Register only the additional UI routes. Keep the existing /ledger route and its mutation semantics. */
export function registerUiRoutes(ctx, deps) {
  const { config, readLedger, statsRoot, cwdOf, catalog, tap, priors } = deps;
  const sessionOf = url => {
    const session = url.searchParams.get('session');
    if (!session?.trim()) bad('session is required');
    return session;
  };
  const root = session => {
    const seen = new Set();
    let id = session;
    while (!seen.has(id)) {
      seen.add(id);
      const parent = statsRoot(id);
      if (parent === id) return id;
      id = parent;
    }
    throw new Error('cyclic session lineage');
  };
  const handlers = {
    injections: async (request, url) => {
      const session = sessionOf(url);
      return { session, injections: tap.injections([session]) };
    },
    candidates: async (request, url) => {
      const session = root(sessionOf(url)), pools = tap.candidates([session]);
      if (pools.length) return { session, computed: true, pools };
      return { session, computed: false, status: 'not computed yet', pools: [],
        configured: {
          routes: (config.routes ?? []).map(({ id, model, provider, efforts }) => ({ id, model, provider, efforts })),
          modelRoutes: Object.entries(config.modelRoutes ?? {}).map(([model, provider]) => ({ model, provider })),
          catalog: catalog.map(({ id, routes }) => ({ id, providers: routes })),
        } };
    },
    priors: async (request) => {
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { bad('invalid JSON body'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be an object');
        if (typeof body.model !== 'string' || !priorModels(catalog, config, priors.snapshot()).some(model => model.id === body.model))
          bad('unknown model');
        if (body.value !== null && (typeof body.value !== 'string' || !body.value.trim())) bad('prior must be text or null');
        if (body.reason !== undefined && typeof body.reason !== 'string') bad('reason must be text');
        await priors.set(body.model, body.value, body.reason);
      }
      return { scope: 'deployment', models: priorModels(catalog, config, priors.snapshot()) };
    },
    history: async (request, url) => {
      const kind = url.searchParams.get('kind'), via = url.searchParams.get('via');
      if (kind && !['ledger', 'prior'].includes(kind)) bad('invalid history kind');
      if (via && !['auto', 'approved', 'rejected', 'revert', 'user', 'prior'].includes(via)) bad('invalid history via');
      let cwd, ledger;
      if (kind === 'prior') ledger = { history: [] };
      else {
        const session = sessionOf(url);
        cwd = await cwdOf(root(session));
        if (typeof cwd !== 'string') bad('workspace is unavailable for this session');
        ledger = await readLedger(cwd);
      }
      let entries = historyEntries(ledger, priors.snapshot());
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      entries = entries.filter(entry => (!kind || entry.kind === kind) && (!via || entry.via === via || entry.source === via) &&
        (!query || [entry.key, entry.model, entry.reason, entry.source, ...(entry.evidence ?? [])].some(value =>
          typeof value === 'string' && value.toLowerCase().includes(query))));
      return { cwd, ...page(url, entries) };
    },
  };
  ctx.inject(['connection'], c => {
    for (const [name, handler] of Object.entries(handlers)) c.effect(() => c.connection.fetch.register({
      path: '/api/dsh-autoctx/' + name, methods: name === 'priors' ? ['GET', 'POST'] : ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try { return json(await handler(request, new URL(request.url))); }
        catch (error) {
          // Only input validation is exposed. Storage/internal errors must not leak paths or credentials.
          if (error instanceof InputError) return json({ error: error.message }, 400);
          return json({ error: 'AutoCTX UI data could not be read or saved' }, 500);
        }
      },
    }), 'dsh-autoctx: ' + name + ' route');
  });
}
