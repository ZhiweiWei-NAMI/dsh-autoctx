// Workspace adaptation ledger: per task tag × model × role, a learned weight (from Jev proposals over
// observed evidence) and an optional user weight (explicit preference, never changed by learning), one
// pending batch for manual approval, consumed evidence ids and a bounded change history. Pure functions:
// the caller loads one storage record, applies one of these and stores the result in the same update.
export const DEFAULT_WEIGHT = 0.5;
export const MODES = ['auto', 'manual', 'frozen'];
const HISTORY = 20, CONSUMED = 1000;
// Jev answers a weight proposal as a score over these levels; weight = score / 4.
export const FIT_LEVELS = [
  'Poor fit: avoid this model in this role for this kind of task.',
  'Weak fit: use only when better candidates are unavailable.',
  'Neutral, or the evidence is insufficient to move the weight.',
  'Good fit for this role and kind of task.',
  'Strong fit: prefer this model in this role for this kind of task.',
];

export const emptyLedger = (mode = 'auto') =>
  ({ version: 0, mode, modeGeneration: 0, weights: {}, pending: null, consumed: [], history: [] });
export const weightKey = (tag, model, role) => tag + '|' + model + '|' + role;
export const parseKey = key => { const [tag, model, role] = key.split('|'); return { tag, model, role }; };

export function effective(ledger, key) {
  const entry = ledger.weights[key];
  if (entry?.user !== undefined) return { weight: entry.user, source: 'user', n: entry.n ?? 0, summary: entry.summary };
  if (entry?.learned !== undefined) return { weight: entry.learned, source: 'learned', n: entry.n ?? 0, summary: entry.summary };
  return { weight: DEFAULT_WEIGHT, source: 'none', n: 0 };
}

// Bounded step: one task moves the weight by 1/(n+2) of the gap, so it never replaces the history; the
// first observation moves half way from the neutral prior.
const step = (entry, target) => {
  const learned = entry?.learned ?? DEFAULT_WEIGHT, n = entry?.n ?? 0;
  return round(learned + (target - learned) / (n + 2));
};
const round = value => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const clip = (text, cap) => (typeof text === 'string' ? Array.from(text).slice(0, cap).join('') : '');

function applied(ledger, items, via, at) {
  const weights = { ...ledger.weights }, changes = [], consumed = new Set(ledger.consumed);
  for (const item of items) {
    const before = weights[item.key];
    weights[item.key] = { ...before, learned: item.proposed, n: (before?.n ?? 0) + 1,
      summary: clip(item.basis, 160), updatedAt: at };
    changes.push({ key: item.key, from: before?.learned ?? DEFAULT_WEIGHT, to: item.proposed, target: item.target });
    for (const id of item.evidence) consumed.add(id);
  }
  if (!changes.length) return ledger;
  const version = ledger.version + 1;
  return rebase({ ...ledger, version, weights, consumed: [...consumed].slice(-CONSUMED),
    history: [...ledger.history, { version, at, via, changes }].slice(-HISTORY) });
}

// A pending batch always shows values against the current ledger: after any applied change it is
// recomputed and re-versioned, so an approval can only apply what the user saw.
function rebase(ledger) {
  const pending = ledger.pending;
  if (!pending || pending.baseVersion === ledger.version) return ledger;
  const items = Object.fromEntries(Object.entries(pending.items).map(([key, item]) =>
    [key, { ...item, current: effective(ledger, key).weight, proposed: step(ledger.weights[key], item.target) }]));
  return { ...ledger, pending: { version: pending.version + 1, baseVersion: ledger.version, items } };
}

/**
 * Turn Jev proposals into ledger changes according to the mode.
 * @param proposals - [{key, target (0..1 from Jev), basis, uncertainty, evidence: [ids]}]
 * @returns {ledger, applied: [...], pending: boolean, skipped: [...]}
 */
export function propose(ledger, proposals, at) {
  const consumed = new Set(ledger.consumed), fresh = [], skipped = [];
  for (const proposal of proposals) {
    const evidence = proposal.evidence.filter(id => !consumed.has(id));
    // The same evidence never counts twice, including evidence a rejected batch already carried.
    if (!evidence.length) { skipped.push(proposal.key); continue; }
    fresh.push({ ...proposal, evidence, target: round(proposal.target),
      current: effective(ledger, proposal.key).weight, proposed: step(ledger.weights[proposal.key], proposal.target) });
  }
  if (ledger.mode === 'frozen' || !fresh.length) return { ledger, applied: [], pending: false, skipped, recorded: fresh };
  if (ledger.mode === 'auto') return { ledger: applied(ledger, fresh, 'auto', at), applied: fresh, pending: false, skipped };
  const before = ledger.pending?.items ?? {}, items = { ...before };
  for (const item of fresh) {
    // A later proposal for the same weight replaces the displayed target; its evidence joins the earlier one.
    const evidence = [...new Set([...(before[item.key]?.evidence ?? []), ...item.evidence])];
    items[item.key] = { current: item.current, proposed: item.proposed, target: item.target,
      basis: clip(item.basis, 240), uncertainty: item.uncertainty, evidence, updatedAt: at };
  }
  const pending = { version: (ledger.pending?.version ?? 0) + 1, baseVersion: ledger.version, items, updatedAt: at };
  return { ledger: { ...ledger, pending }, applied: [], pending: true, skipped };
}

/** Apply exactly the pending batch the user saw; a newer version is refused with the current batch. */
export function approve(ledger, version, at) {
  if (!ledger.pending || ledger.pending.version !== version) return { ledger, error: 'stale' };
  const items = Object.entries(ledger.pending.items).map(([key, item]) => ({ key, ...item }));
  const next = applied({ ...ledger, pending: null }, items, 'approved', at);
  return { ledger: next, applied: items };
}

/** Keep the current weights; the batch's evidence is consumed so the same evidence is not proposed again. */
export function reject(ledger, version, at) {
  if (!ledger.pending || ledger.pending.version !== version) return { ledger, error: 'stale' };
  const evidence = Object.values(ledger.pending.items).flatMap(item => item.evidence);
  const consumed = [...new Set([...ledger.consumed, ...evidence])].slice(-CONSUMED);
  const history = [...ledger.history, { version: ledger.version, at, via: 'rejected',
    changes: Object.keys(ledger.pending.items).map(key => ({ key, kept: effective(ledger, key).weight })) }].slice(-HISTORY);
  return { ledger: { ...ledger, pending: null, consumed, history } };
}

/** Switching mode never applies a pending batch: it stays pending until approved or rejected. */
export function setMode(ledger, mode) {
  if (!MODES.includes(mode) || mode === ledger.mode) return ledger;
  return { ...ledger, mode, modeGeneration: ledger.modeGeneration + 1 };
}

/** Undo one applied change set (learned weights only); finished calls and consumed evidence stay. */
export function revert(ledger, version, at) {
  const entry = ledger.history.find(item => item.version === version && item.via !== 'rejected' && item.via !== 'revert');
  if (!entry) return { ledger, error: 'unknown' };
  const weights = { ...ledger.weights }, changes = [];
  for (const change of entry.changes) {
    const now = weights[change.key];
    weights[change.key] = { ...now, learned: change.from, updatedAt: at };
    changes.push({ key: change.key, from: now?.learned ?? DEFAULT_WEIGHT, to: change.from });
  }
  const next = ledger.version + 1;
  return { ledger: rebase({ ...ledger, version: next, weights,
    history: [...ledger.history, { version: next, at, via: 'revert', of: version, changes }].slice(-HISTORY) }) };
}

/** Explicit user preference for one weight (null clears it); learning never writes this field. */
export function setUser(ledger, key, value, at) {
  const now = ledger.weights[key] ?? {};
  const entry = value === null ? (({ user: _user, ...rest }) => rest)(now) : { ...now, user: round(value) };
  const version = ledger.version + 1;
  return rebase({ ...ledger, version, weights: { ...ledger.weights, [key]: { ...entry, updatedAt: at } },
    history: [...ledger.history, { version, at, via: 'user', changes: [{ key, from: now.user ?? null, to: value }] }].slice(-HISTORY) });
}

/** Compact rows for Jev and the UI: weight, its source and evidence count, never a fabricated rate. */
export function experienceRows(ledger, keys) {
  return keys.map(key => ({ key, ...parseKey(key), ...effective(ledger, key) }));
}
