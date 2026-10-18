// Model knowledge from models.json: prices, routes, short priors and dsh-bench
// measurements. The catalog is static data; callers only read and rank it.
import fs from 'node:fs';

export const CATALOG = JSON.parse(fs.readFileSync(new URL('./models.json', import.meta.url), 'utf8'));

const entries = () => (Array.isArray(CATALOG?.models) ? CATALOG.models : []);
const known = id => typeof id === 'string' && id.length > 0;
const withId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// A usable entry needs a price to rank.
const valid = entry => !!entry && known(entry.id)
  && !!entry.price && typeof entry.price.input === 'number' && typeof entry.price.output === 'number';

export function modelInfo(id) {
  if (!known(id)) return undefined;
  const models = entries();
  const exact = models.find(entry => entry?.id === id);
  if (exact) return exact;
  const suffix = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  if (!suffix) return undefined;
  return models.find(entry => typeof entry?.id === 'string' && entry.id.toLowerCase() === suffix);
}

// Host usage is disjoint (dsh-llm TokenUsage): input is uncached input only; cache reads and writes are
// separate. The bench relay's {input, output, cacheRead, cacheWrite} spelling is accepted too.
export function costUSD(id, usage) {
  const entry = modelInfo(id);
  if (!entry || !entry.price) return undefined;
  const used = usage ?? {};
  const input = used.inputTokens ?? used.input, output = used.outputTokens ?? used.output;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const cacheRead = used.cacheReadTokens ?? used.cacheRead ?? 0, cacheWrite = used.cacheWriteTokens ?? used.cacheWrite ?? 0;
  const price = entry.price, above = price.above;
  // A long-prompt tier scales every input-side price by its input ratio (assumption where the tier lists only input/output).
  const long = above && input + cacheRead + cacheWrite > above.tokens;
  const scale = long ? above.input / price.input : 1;
  return (
    input * price.input * scale
    + output * (long ? above.output : price.output)
    + cacheRead * (price.cacheRead ?? price.input) * scale
    + cacheWrite * (price.cacheWrite ?? price.input) * scale
  ) / 1e6;
}

// Jev's own price (models.json `jev`); usage uses the Jev response's input_tokens/output_tokens.
export function jevCostUSD(model, usage) {
  const price = CATALOG?.jev?.[model];
  if (!price || !usage) return undefined;
  const input = usage.input_tokens ?? usage.inputTokens, output = usage.output_tokens ?? usage.outputTokens;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return (input * price.input + output * price.output) / 1e6;
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

// Route policy: when a model on a preferred or allowed provider meets the role's hard requirements, models on
// other providers step aside. Preferred marks the default choice; allowed routes stay valid alternatives.
export function routePolicy(items, providerOf, { preferred = [], allowed = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
  const top = new Set(Array.isArray(preferred) ? preferred : []);
  const eligible = new Set([...top, ...(Array.isArray(allowed) ? allowed : [])]);
  const kept = list.filter(item => eligible.has(providerOf(item)));
  const isPreferred = item => top.has(providerOf(item));
  if (!eligible.size || !kept.length) return { kept: list, dropped: [], preferredOnly: list.filter(isPreferred), isPreferred };
  return { kept, dropped: list.filter(item => !eligible.has(providerOf(item))), preferredOnly: kept.filter(isPreferred), isPreferred };
}

// Fallback without a Jev answer: the highest effective ledger weight for this role, then the cheapest brief.
// Family is information for Jev, not a ranking rule.
export function pickModel(role, { available, exclude = [], weightOf } = {}) {
  const blocked = new Set(Array.isArray(exclude) ? exclude : []);
  const candidates = (Array.isArray(available) ? available : []).filter(entry => valid(entry) && !blocked.has(entry.id));
  if (candidates.length === 0) return undefined;
  const weight = entry => (typeof weightOf === 'function' ? weightOf(entry.id, role) : 0.5);
  return candidates.sort((a, b) => weight(b) - weight(a) || briefCost(a) - briefCost(b) || withId(a, b))[0];
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
  if (Number.isFinite(entry.context)) parts.push('context ' + entry.context);
  const prior = clip(entry.prior, cap);
  if (prior) parts.push('prior: ' + prior);
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
  if (measurements.length) parts.push('measured as ' + (measured.role ?? 'executor') + ': ' + measurements.join(', '));
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
  let hi = Math.max(0, ...sorted.map(entry => (typeof entry.prior === 'string' ? entry.prior.length : 0)));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(sorted.map(entry => line(entry, mid))) <= 4000) lo = mid;
    else hi = mid - 1;
  }
  return sorted.map(entry => line(entry, lo)).join('\n');
}
