// Model knowledge from models.json: prices, routes, roles and dsh-bench
// measurements. The catalog is static data; callers only read and rank it.
import fs from 'node:fs';

export const CATALOG = JSON.parse(fs.readFileSync(new URL('./models.json', import.meta.url), 'utf8'));

const entries = () => (Array.isArray(CATALOG?.models) ? CATALOG.models : []);
const known = id => typeof id === 'string' && id.length > 0;
const withId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// A usable entry needs a price to rank and roles to match a route.
const valid = entry => !!entry && known(entry.id)
  && !!entry.price && typeof entry.price.input === 'number' && typeof entry.price.output === 'number'
  && Array.isArray(entry.roles);

export function modelInfo(id) {
  if (!known(id)) return undefined;
  const models = entries();
  const exact = models.find(entry => entry?.id === id);
  if (exact) return exact;
  const suffix = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  if (!suffix) return undefined;
  return models.find(entry => typeof entry?.id === 'string' && entry.id.toLowerCase() === suffix);
}

export function costUSD(id, usage) {
  const entry = modelInfo(id);
  if (!entry || !entry.price) return undefined;
  const price = entry.price;
  const used = usage ?? {};
  return (
    (used.input ?? 0) * price.input
    + (used.output ?? 0) * price.output
    + (used.cacheRead ?? 0) * price.cacheRead
    + (used.cacheWrite ?? 0) * (price.cacheWrite ?? 0)
  ) / 1e6;
}

export function availableModels(modelRoutes, { allowPaid = false } = {}) {
  const routes = modelRoutes && typeof modelRoutes === 'object' ? modelRoutes : {};
  return entries().filter(entry => {
    if (!valid(entry) || !Object.hasOwn(routes, entry.id)) return false;
    const provider = routes[entry.id];
    const paid = typeof provider === 'string' && provider.toLowerCase().startsWith('opencode');
    return allowPaid || !paid;
  });
}

export function pickModel(role, { executor, available, exclude = [] } = {}) {
  const blocked = new Set(Array.isArray(exclude) ? exclude : []);
  const candidates = (Array.isArray(available) ? available : [])
    .filter(entry => valid(entry) && entry.roles.includes(role) && !blocked.has(entry.id));
  if (candidates.length === 0) return undefined;
  const own = typeof executor === 'string' ? modelInfo(executor) : executor;
  const ownId = own?.id ?? (typeof executor === 'string' ? executor : undefined);
  const family = own?.family;
  const different = entry => (family && entry.family === family ? 1 : 0);
  const reuse = entry => (entry.id === ownId ? 0 : 1);
  const pro = entry => (entry.tier === 'pro' ? 0 : 1);
  return candidates.sort((a, b) => {
    if (role === 'advisor' && pro(a) !== pro(b)) return pro(a) - pro(b);
    if ((role === 'reviewer' || role === 'advisor') && different(a) !== different(b)) return different(a) - different(b);
    if (role === 'worker' && reuse(a) !== reuse(b)) return reuse(a) - reuse(b);
    return briefCost(a) - briefCost(b) || withId(a, b);
  })[0];
}

export function briefCost(entry) {
  const price = entry?.price;
  if (!price || typeof price.input !== 'number' || typeof price.output !== 'number') return Infinity;
  return (20000 * price.input + 2000 * price.output) / 1e6;
}

const clip = (text, cap) => {
  if (typeof text !== 'string') return '';
  return Array.from(text.trim()).slice(0, cap).join('');
};

const line = (entry, cap) => {
  const price = entry.price;
  const parts = [entry.id];
  const family = [entry.family, entry.tier].filter(value => typeof value === 'string').join('/');
  if (family) parts.push(family);
  parts.push(`$${price.input}/${price.output}${Number.isFinite(price.cacheRead) ? '/' + price.cacheRead : ''} per 1M`);
  const roles = entry.roles.filter(role => typeof role === 'string');
  if (roles.length) parts.push('roles: ' + roles.join(','));
  const strengths = clip(entry.strengths, cap);
  if (strengths) parts.push('+ ' + strengths);
  const weaknesses = clip(entry.weaknesses, cap);
  if (weaknesses) parts.push('- ' + weaknesses);
  const measured = entry.measured ?? {};
  const measurements = [];
  if (Number.isFinite(measured.resolved) && Number.isFinite(measured.cases)) {
    measurements.push(`${measured.resolved}/${measured.cases}`);
  } else {
    if (Number.isFinite(measured.resolved)) measurements.push(`${measured.resolved} resolved`);
    if (Number.isFinite(measured.cases)) measurements.push(`${measured.cases} cases`);
  }
  if (Number.isFinite(measured.callsPerCase)) measurements.push(`${measured.callsPerCase} calls/task`);
  if (Number.isFinite(measured.callCapped)) measurements.push(`${measured.callCapped} hit call cap`);
  if (measurements.length) parts.push('measured ' + measurements.join(', '));
  return parts.join(' | ');
};

const bytes = lines => Buffer.byteLength(lines.join('\n'), 'utf8');

export function knowledge(list) {
  const sorted = (Array.isArray(list) ? list : []).filter(valid).sort(withId);
  if (sorted.length === 0) return '';
  const full = sorted.map(entry => line(entry, Infinity));
  if (bytes(full) <= 4000) return full.join('\n');
  const bare = sorted.map(entry => line(entry, 0));
  if (bytes(bare) > 4000) {
    // Preserve every model ID when even the fixed metadata cannot fit.
    const ids = sorted.map(entry => entry.id);
    if (bytes(ids) > 4000) throw new RangeError('Model IDs alone exceed the 4000-byte knowledge budget');
    return ids.join('\n');
  }
  let lo = 0;
  let hi = Math.max(0, ...sorted.flatMap(entry => [entry.strengths, entry.weaknesses].map(text => (typeof text === 'string' ? text.length : 0))));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(sorted.map(entry => line(entry, mid))) <= 4000) lo = mid;
    else hi = mid - 1;
  }
  return sorted.map(entry => line(entry, lo)).join('\n');
}
