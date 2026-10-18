// Read-only session facts and UI persistence projections; no model calls or session mutations.
import { approve, reject, revert, setMode, setUser, effective, MODES } from './ledger.js';
import { recordId } from './uistore.js';
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
class InputError extends Error {}
class SessionError extends Error {}
const bad = message => { throw new InputError(message); };
const idsOf = ids => new Set(Array.isArray(ids) ? ids : [ids]);
const stamp = value => typeof value === 'number' ? value : Date.parse(value);

/** Resolve headers only, using the native query's exact metadata filter for non-agent sessions.
 * Do not read raw logs or cache cold headers: live agents always win, including after reattachment.
 */
export function createSessionResolver(agents, sessionQuery) {
  const headerOf = async id => {
    const live = agents.get(id)?.session.header;
    if (live) return live;
    const query = sessionQuery();
    if (!query) throw new SessionError('session is unavailable: sessionQuery is not mounted');
    let records;
    try { records = await query.filterSessions([{ kind: 'id', values: [id] }]); }
    catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw new SessionError('session is unavailable');
      throw error;
    }
    // Prefer an agent that attached while the query was pending.
    const header = agents.get(id)?.session.header ?? records.find(record => record.header.id === id)?.header;
    if (!header) throw new SessionError('session is unavailable');
    return header;
  };
  return async session => {
    if (typeof session !== 'string' || !session.trim()) bad('session is required');
    let id = session, header, rootHeader;
    const seen = new Set();
    while (!seen.has(id)) {
      seen.add(id);
      rootHeader = await headerOf(id);
      header ??= rootHeader;
      if (rootHeader.parentSession === undefined) return { session, header, root: id, rootHeader, cwd: rootHeader.cwd };
      id = rootHeader.parentSession;
    }
    bad('cyclic session lineage');
  };
}

const workspace = resolved => {
  if (typeof resolved.cwd !== 'string' || !resolved.cwd.trim()) bad('workspace is unavailable for this session');
  return resolved.cwd;
};

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
      return structuredClone(item);
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
      id: 'ledger:' + (entry.id ?? entry.version + ':' + entry.at) + ':' + index,
      kind: 'ledger', at: entry.at, key: change.key, version: entry.version, via: entry.via,
      source: change.source, before: Object.hasOwn(change, 'from') ? change.from : change.kept,
      after: Object.hasOwn(change, 'to') ? change.to : change.kept,
      reason: change.reason ?? change.basis, basis: change.basis, evidence: change.evidence,
    }))),
    ...priors.history.map((entry, index) => ({ ...entry, id: 'prior:' + index, kind: 'prior', via: 'prior' })),
  ].sort((a, b) => stamp(b.at) - stamp(a.at));
}

export function page(url, entries) {
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

const latestPools = entries => {
  const latest = new Map();
  for (const record of entries) {
    const previous = latest.get(record.role);
    if (!previous || stamp(record.at) >= stamp(previous.at)) latest.set(record.role, record);
  }
  return [...latest.values()];
};
function mergedRecords(stored, live) {
  const records = new Map();
  for (const record of stored) records.set(recordId(record), record);
  for (const record of live) records.set(recordId(record), record);
  return [...records.values()];
}

// Inline history preserves the scheduling card's latest automatic batch and its actual revert, if any.
// This is a summary, not the archive; full history is paged separately.
export const ledgerView = ledger => ({
  mode: ledger.mode, version: ledger.version,
  weights: Object.entries(ledger.weights).map(([key, entry]) => ({ key, ...effective(ledger, key),
    ...(entry.learned === undefined ? {} : { learned: entry.learned }),
    ...(entry.user === undefined ? {} : { user: entry.user }), updatedAt: entry.updatedAt })),
  pending: ledger.pending, history: [ledger.lastAuto, ledger.lastAutoRevert].filter(Boolean),
  historyCount: ledger.historyCount ?? 0, lastAuto: ledger.lastAuto, lastAutoReverted: ledger.lastAutoReverted ?? false,
});

/** Plugin UI routes share cold-session resolution and preserve the existing ledger mutations. */
export function registerUiRoutes(ctx, deps) {
  const { config, readLedger, updateLedger, readHistory, resolveSession, readStats, uiStore, record, catalog, tap, priors } = deps;
  const sessionOf = url => {
    const session = url.searchParams.get('session');
    if (!session?.trim()) bad('session is required');
    return session;
  };
  const handlers = {
    stats: async (request, url) => {
      const resolved = await resolveSession(sessionOf(url)), entry = await readStats(resolved.root);
      const { pendingSaved, ...stats } = entry ?? {};
      return { stats: entry ? stats : null, apiKeyConfigured: !!config.apiKey };
    },
    ledger: async (request, url) => {
      let body = {};
      if (request.method === 'POST') {
        try { body = await request.json(); } catch { bad('invalid JSON body'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be an object');
      }
      // A supplied session is always resolved, even when an explicit cwd was also supplied.
      const session = body.session ?? url.searchParams.get('session');
      const explicit = body.cwd ?? url.searchParams.get('cwd');
      const cwd = session != null ? workspace(await resolveSession(session)) : explicit;
      if (typeof cwd !== 'string' || !cwd.trim()) bad('session or cwd is required');
      if (session != null && explicit != null && explicit !== cwd) bad('cwd does not match session workspace');
      if (request.method === 'GET') return { cwd, ledger: ledgerView(await readLedger(cwd)) };
      const now = Date.now();
      const actions = {
        approve: ledger => approve(ledger, body.version, now),
        reject: ledger => reject(ledger, body.version, now),
        revert: (ledger, findApplied) => revert(ledger, body.version, now, findApplied(body.version)),
        mode: ledger => ({ ledger: setMode(ledger, body.mode) }),
        user: ledger => ({ ledger: setUser(ledger, body.key, body.value ?? null, now, body.reason) }),
      };
      if (!Object.hasOwn(actions, body.action) || (body.action === 'mode' && !MODES.includes(body.mode))) bad('unknown action');
      if (body.action === 'user' && (typeof body.key !== 'string' || !body.key.trim() ||
        (body.value != null && (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0 || body.value > 1)) ||
        (body.reason !== undefined && typeof body.reason !== 'string'))) bad('user weight needs a key and a value in [0, 1] or null');
      const result = await updateLedger(cwd, actions[body.action]);
      record({ kind: 'ledger_action', cwd, action: body.action, version: body.version, error: result.error });
      return json({ cwd, ledger: ledgerView(result.ledger), ...(result.error ? { error: result.error } : {}) },
        result.error === 'stale' ? 409 : result.error ? 404 : 200);
    },
    injections: async (request, url) => {
      const { session } = await resolveSession(sessionOf(url));
      const time = name => {
        const raw = url.searchParams.get(name);
        if (raw === null) return undefined;
        if (!raw.trim() || !Number.isFinite(Number(raw))) bad('invalid ' + name);
        return Number(raw);
      };
      const start = time('start'), end = time('end');
      if (start !== undefined && end !== undefined && start > end) bad('invalid time range');
      const entries = mergedRecords(await uiStore.records(session, 'message_appended'), tap.injections([session]))
        .filter(entry => (start === undefined || stamp(entry.at) >= start) && (end === undefined || stamp(entry.at) <= end))
        .sort((a, b) => stamp(a.at) - stamp(b.at));
      const { entries: injections, ...paging } = page(url, entries);
      return { session, injections, ...paging };
    },
    candidates: async (request, url) => {
      const { root: session } = await resolveSession(sessionOf(url));
      const pools = latestPools(mergedRecords(await uiStore.records(session, 'candidate_pool'), tap.candidates([session])));
      const { entries, ...paging } = page(url, pools);
      if (pools.length) return { session, computed: true, pools: entries, ...paging };
      return { session, computed: false, status: 'not computed yet', pools: [], ...paging,
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
      let cwd, ledger = { history: [] };
      // Validate a supplied session even for a prior-only filter; deployment settings need no session.
      if (kind !== 'prior' || url.searchParams.has('session')) {
        cwd = workspace(await resolveSession(sessionOf(url)));
        if (kind !== 'prior') ledger = { history: [...await readHistory(cwd)] };
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
      path: '/api/dsh-autoctx/' + name, methods: ['priors', 'ledger'].includes(name) ? ['GET', 'POST'] : ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const result = await handler(request, new URL(request.url));
          return result instanceof Response ? result : json(result);
        }
        catch (error) {
          // Only input validation is exposed. Storage/internal errors must not leak paths or credentials.
          if (error instanceof InputError) return json({ error: error.message }, 400);
          if (error instanceof SessionError) return json({ error: error.message }, 404);
          return json({ error: 'AutoCTX UI data could not be read or saved' }, 500);
        }
      },
    }), 'dsh-autoctx: ' + name + ' route');
  });
}
