import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';

export const name = 'bench-observation';
export const inject = ['agents', 'llm', 'subagents'];

export function apply(ctx, config) {
  const record = value => appendFileSync(config.recordFile, JSON.stringify(value) + '\n');
  const calls = new AsyncLocalStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const call = calls.getStore();
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (call && url.startsWith(config.relay + '/')) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('x-bench-role', call.role);
      if (call.session) headers.set('x-wb-session-id', call.session);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
  ctx.on('dispose', () => { globalThis.fetch = originalFetch; });
  record({ kind: 'observer_start' });
  const children = new Set();
  const active = new Set();
  ctx.on('subagent/start', info => {
    children.add(info.id);
    active.add(info.id);
    record({ kind: 'child_start', id: info.id, runId: info.runId });
  });
  ctx.on('subagent/end', info => {
    active.delete(info.id);
    record({ kind: 'child_end', id: info.id, runId: info.runId, stopReason: info.stopReason });
  });
  if (config.arm === 'C') {
    const start = ctx.subagents.start;
    let starting = 0;
    ctx.subagents.start = async function (provider, request) {
      if (children.size + starting >= config.maxChildren || active.size + starting >= config.maxConcurrent)
        throw new Error('Task subagent resource limit reached.');
      starting++;
      try {
        return await start.call(this, provider, { ...request, maxDepth: 1 });
      } finally {
        starting--;
      }
    };
    ctx.on('dispose', () => { ctx.subagents.start = start; });
  }
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
    const role = options.purpose === 'compaction' ? 'compaction'
      : agent?.session.header.parentSession !== undefined ? 'child' : 'main';
    const call = { role, session: options.sessionId };
    const iterator = calls.run(call, () => next()[Symbol.asyncIterator]());
    try {
      while (true) {
        const item = await calls.run(call, () => iterator.next());
        if (item.done) return;
        yield item.value;
      }
    } finally {
      if (iterator.return) await calls.run(call, () => iterator.return());
    }
  });
}
