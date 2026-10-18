// Deployment-wide capability text overrides. These describe models, not workspace outcomes.
// Pure state transitions are also used by the durable store and can be used without a host.
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

export const emptyPriors = () => ({ overrides: {}, history: [] });
export const priorOf = (state, model) => Object.hasOwn(state.overrides, model) ? state.overrides[model] : undefined;

export function setPrior(state, model, value, at, reason) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model must be a nonempty id');
  if (value !== null && (typeof value !== 'string' || !value.trim()))
    throw new TypeError('prior must be nonempty text or null to clear');
  if (reason !== undefined && typeof reason !== 'string') throw new TypeError('reason must be text');
  const before = priorOf(state, model) ?? null;
  if (before === value) return state;
  const overrides = { ...state.overrides };
  if (value === null) delete overrides[model];
  else Object.defineProperty(overrides, model, { value, enumerable: true, writable: true, configurable: true });
  return { overrides, history: [...state.history, {
    at, model, before, after: value, source: 'user', ...(reason === undefined ? {} : { reason }),
  }] };
}

const DOMAIN = defineDomain({
  name: 'dsh_auto_priors', version: 1, layout: 'per-record',
  tables: { priors: domainTable(z.object({
    overrides: z.record(z.string(), z.string()),
    history: z.array(z.object({ at: z.number(), model: z.string(), before: z.string().nullable(),
      after: z.string().nullable(), source: z.literal('user'), reason: z.string().optional() })),
  })) },
});
const KEY = 'catalog';
let activeStore;

/** Table must implement synchronous get and durable put/update. Await initialization before model use. */
export async function createPriorsStore(table) {
  if (table.get(KEY) === undefined) await table.put(KEY, emptyPriors());
  const store = {
    snapshot: () => table.get(KEY),
    priorTextOf: model => priorOf(table.get(KEY), model),
    async set(model, value, reason, at = Date.now()) {
      await table.update(KEY, state => setPrior(state, model, value, at, reason));
      return table.get(KEY);
    },
  };
  activeStore = store;
  return store;
}

/** Synchronous override only; the knowledge builder retains the catalog prior when undefined. */
export function priorTextOf(modelId) {
  if (!activeStore) throw new Error('AutoCTX priors have not been opened; await openPriors(ctx) first');
  return activeStore.priorTextOf(modelId);
}

/** Call once at plugin startup. This module owns the domain lifecycle. */
export async function openPriors(ctx) {
  const domain = await ctx.storageDomain.open(DOMAIN);
  let store;
  ctx.on('dispose', async () => {
    if (activeStore === store) activeStore = undefined;
    await domain.close();
  });
  store = await createPriorsStore(domain.table('priors'));
  return store;
}
