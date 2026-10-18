// Plugin-owned metadata only. No session log reads, message bodies or model calls.
import { createHash } from 'node:crypto';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { emptyLedger } from './ledger.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const clean = value => JSON.parse(JSON.stringify(value));
export const recordId = record => hash(JSON.stringify(clean(record)));

/** Serialized workspace updates, including crash-recoverable inline-history migration.
 * The state and its history outbox commit in ONE durable put. Per-entry puts precede clearing that
 * outbox. A failed/interrupted drain is replayed at the same sequence keys, never appended twice.
 * The host has no cross-record transaction; reads use this same queue and finish recovery first.
 */
export function createLedgerStore(storage, keyOf, mode = 'auto') {
  const queues = new Map();
  const serial = (key, fn) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(fn);
    queues.set(key, pending);
    return pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
  };
  const entryKey = (key, sequence) => key + '_' + sequence;
  async function drain(domain, key, ledger) {
    const entries = ledger.history ?? [];
    if (!entries.length) return ledger;
    const history = domain.table('ledger_history');
    let lastAuto = ledger.lastAuto, lastAutoRevert = ledger.lastAutoRevert,
      lastAutoReverted = ledger.lastAutoReverted ?? false;
    const count = ledger.historyCount ?? 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], id = entryKey(key, count + i + 1), stored = history.get(id);
      if (stored === undefined) await history.put(id, clean(entry));
      else if (JSON.stringify(stored) !== JSON.stringify(clean(entry))) throw new Error('ledger history sequence conflict');
      if (entry.via === 'auto') { lastAuto = entry; lastAutoRevert = undefined; lastAutoReverted = false; }
      if (entry.via === 'revert' && entry.of === lastAuto?.version) { lastAutoRevert = entry; lastAutoReverted = true; }
    }
    const compact = clean({ ...ledger, history: [], historyCount: count + entries.length, lastAuto, lastAutoRevert, lastAutoReverted });
    await domain.table('ledger').put(key, compact);
    return compact;
  }
  function* entries(domain, key, ledger) {
    for (let sequence = 1; sequence <= (ledger.historyCount ?? 0); sequence++) {
      const entry = domain.table('ledger_history').get(entryKey(key, sequence));
      if (entry === undefined) throw new Error('ledger history entry is missing');
      yield { ...entry, id: key + ':' + sequence };
    }
  }
  return {
    read(cwd) {
      const key = keyOf(cwd);
      return serial(key, async () => {
        const domain = await storage();
        return drain(domain, key, domain.table('ledger').get(key) ?? emptyLedger(mode));
      });
    },
    update(cwd, fn) {
      const key = keyOf(cwd);
      return serial(key, async () => {
        const domain = await storage(), table = domain.table('ledger');
        const current = await drain(domain, key, table.get(key) ?? emptyLedger(mode));
        const findApplied = version => {
          for (const entry of entries(domain, key, current))
            if (entry.version === version && ['auto', 'approved'].includes(entry.via)) return entry;
        };
        const result = fn(current, findApplied);
        if (result.ledger !== current) {
          await table.put(key, clean(result.ledger));
          result.ledger = await drain(domain, key, result.ledger);
        }
        return result;
      });
    },
    async history(cwd) {
      const ledger = await this.read(cwd), domain = await storage();
      // Capture the committed count; later writes cannot alter these append-only entries.
      return entries(domain, keyOf(cwd), ledger);
    },
  };
}

const UI_DOMAIN = defineDomain({
  name: 'dsh_auto_ui', version: 1, layout: 'per-record',
  tables: { records: domainTable(z.json()), stats: domainTable(z.json()) },
});

/** Writes are detached from agent execution, drained by UI reads and plugin disposal. Failures are
 * retained and surfaced to readers; a failed write must never become a successful empty response.
 */
export function createUiStore(ctx) {
  let domainPromise, chain = Promise.resolve(), failure;
  const domain = () => (domainPromise ??= ctx.storageDomain.open(UI_DOMAIN));
  const enqueue = fn => {
    chain = chain.then(async () => fn(await domain())).catch(error => {
      failure ??= error;
      ctx.logger?.warn('AutoCTX UI metadata could not be persisted');
    });
  };
  const flush = async () => { await chain; if (failure) throw failure; };
  ctx.on('dispose', async () => {
    try { await flush(); } finally { if (domainPromise) await (await domainPromise).close(); }
  });
  return {
    append(record) {
      const session = record.kind === 'message_appended' ? record.to : record.session;
      if (typeof session !== 'string' || !session) throw new TypeError('UI record needs a session');
      const item = clean(record), key = 's_' + hash(session) + '_' + recordId(item);
      enqueue(async store => {
        const table = store.table('records');
        if (table.get(key) === undefined) await table.put(key, { session, record: item });
      });
    },
    saveStats(session, stats) {
      const snapshot = clean(stats);
      enqueue(store => store.table('stats').put('s_' + hash(session), snapshot));
    },
    async stats(session) {
      await flush();
      return (await domain()).table('stats').get('s_' + hash(session));
    },
    async records(session, kind) {
      await flush();
      const table = (await domain()).table('records');
      return (function* () {
        for (const [, value] of table.entries())
          if (value.session === session && value.record.kind === kind) yield value.record;
      })();
    },
    flush,
  };
}
