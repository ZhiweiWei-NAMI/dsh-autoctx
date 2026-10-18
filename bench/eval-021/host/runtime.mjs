import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';

export const name = 'bench-observation';
export const inject = ['agents', 'llm', 'subagents'];

// Sort recursively and serialize directly, including integer-looking object keys.
// No prompt, tool definition, request header or credential value is persisted.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item) ?? 'null').join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const codeOf = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'DSH_REQUEST_ERROR';

function requestCost(model, usage, prices) {
  const price = prices[model];
  if (!price || !usage || !numeric(price.input) || !numeric(price.output)) return null;
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = usage;
  if (![inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens].every(numeric)) return null;
  const read = price.cacheRead === undefined ? price.input : price.cacheRead;
  const write = price.cacheWrite === undefined ? price.input : price.cacheWrite;
  if (![read, write].every(numeric)) return null;
  return (inputTokens * price.input + cacheReadTokens * read + cacheWriteTokens * write
    + outputTokens * price.output) / 1e6;
}

export function apply(ctx, config) {
  const append = (file, value) => appendFileSync(file, JSON.stringify(value) + '\n');
  const record = value => append(config.recordFile, value);
  const calls = new AsyncLocalStorage();
  const originalFetch = globalThis.fetch;
  // Observe status and retain the WorkBuddy session hint. Authentication,
  // routing and body stay with DSH; Codex headers are never inspected.
  // Other transports may expose a failure status in finish.reason; otherwise
  // httpStatus remains null, never a manufactured success status.
  globalThis.fetch = async function (...args) {
    const call = calls.getStore();
    const input = args[0];
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    const workbuddy = call?.provider === 'workbuddy' && url.startsWith(config.workbuddyBaseURL + '/');
    if (workbuddy && call.session) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(args[1]?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('x-wb-session-id', call.session);
      args[1] = { ...args[1], headers };
    }
    const execution = call && (workbuddy || call.provider === 'openai-codex');
    try {
      const response = await originalFetch.apply(this, args);
      if (execution) {
        call.httpStatus = response.status;
        delete call.transportError;
      }
      return response;
    } catch (error) {
      if (execution) call.transportError = 'FETCH_TRANSPORT';
      throw error;
    }
  };
  ctx.on('dispose', () => { globalThis.fetch = originalFetch; });
  record({ kind: 'observer_start', observation: 'in-process' });
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
  if (config.arm === 'C' || config.arm === 'H') {
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

  let admitted = 0;
  let spend = 0;
  // agent/request returns only call controls. llm/stream includes the assembled
  // system/messages/tools, retries and native compaction, plus settled usage.
  // Read the frozen request as-is; do not replace any native credential path.
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
    const role = options.purpose === 'compaction' ? 'compaction'
      : agent?.session.header.parentSession !== undefined ? 'child' : 'main';
    const refusal = existsSync(config.stopFile) ? 'solver stopped'
      : admitted >= config.requestLimit ? 'execution request limit reached (Jev excluded)'
      : spend >= config.maxUsd ? 'theoretical API USD guard reached' : null;
    if (refusal) {
      record({ kind: 'request_refused', role, session: options.sessionId ?? null,
        httpStatus: 429, reason: refusal, admitted, measuredCostUSD: spend });
      throw new Error('Bench refuses model request: ' + refusal);
    }
    if (!['workbuddy', 'openai-codex'].includes(options.provider))
      throw new Error('Bench refuses execution provider outside WorkBuddy/openai-codex');
    // Synchronous admission before the first await: shared across main/children.
    admitted++;
    const effort = options.reasoningEffort ?? config.providerDefaults[options.provider] ?? null;
    const messages = options.system === undefined ? options.messages
      : [{ role: 'system', content: options.system }, ...options.messages];
    const row = {
      kind: 'execution', observation: 'in-process', requestId: randomUUID(),
      role, session: options.sessionId ?? null, provider: options.provider,
      upstream: options.provider, model: options.model, actualModel: options.model, effort,
      configHash: digest({ provider: options.provider, model: options.model, effort,
        ...Object.fromEntries(['thinking', 'reasoning', 'thinkingBudget', 'thinkingEnabled']
          .filter(key => options[key] !== undefined).map(key => [key, options[key]])) }),
      toolsHash: digest(options.tools ?? []), messageHashes: messages.map(digest),
      hashScheme: 'canonical-json-per-message-sha256-12',
      inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
      startedUnix: Date.now() / 1000, elapsedSeconds: null, httpStatus: null,
      error: null, costUSD: null, state: 'started',
    };
    append(config.startedFile, row);
    const start = performance.now();
    let usage;
    let iterator;
    let exhausted = false;
    let finished = false;
    try {
      iterator = calls.run(row, () => next()[Symbol.asyncIterator]());
      while (true) {
        const item = await calls.run(row, () => iterator.next());
        if (item.done) {
          exhausted = true;
          break;
        }
        const chunk = item.value;
        if (chunk.type === 'usage') {
          // TokenUsage is disjoint. dsh-llm-pi-ai.mapUsage deliberately omits
          // cacheRead/cacheWrite exactly when pi-ai reports zero; an absent
          // entire usage chunk is NOT interpreted as zero usage.
          usage = { inputTokens: numeric(chunk.usage.inputTokens) ? chunk.usage.inputTokens : null,
            outputTokens: numeric(chunk.usage.outputTokens) ? chunk.usage.outputTokens : null,
            cacheReadTokens: chunk.usage.cacheReadTokens === undefined ? 0
              : numeric(chunk.usage.cacheReadTokens) ? chunk.usage.cacheReadTokens : null,
            cacheWriteTokens: chunk.usage.cacheWriteTokens === undefined ? 0
              : numeric(chunk.usage.cacheWriteTokens) ? chunk.usage.cacheWriteTokens : null };
          Object.assign(row, usage);
        } else if (chunk.type === 'finish') {
          finished = true;
          row.finishReason = chunk.reason.kind;
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            row.error = codeOf(chunk.reason.failure);
            if (numeric(chunk.reason.failure?.status)) row.httpStatus = chunk.reason.failure.status;
            if (['NETWORK', 'CONNECTION', 'TRANSPORT', 'TIMEOUT', 'LLM_STREAM_IDLE_TIMEOUT'].includes(row.error))
              row.transportError = row.error;
            // pi-ai initializes an all-zero usage object even before a request
            // fails. Such an error provides no proof of reported zero tokens.
            if (usage && Object.values(usage).every(value => value === 0)) {
              row.nativeErrorUsage = usage;
              row.usageMeasurement = 'native-error-zero-unverified';
              usage = undefined;
              Object.assign(row, { inputTokens: null, cacheReadTokens: null,
                cacheWriteTokens: null, outputTokens: null });
            }
          }
        }
        yield chunk;
      }
    } catch (error) {
      row.error = codeOf(error);
      throw error;
    } finally {
      try {
        if (!exhausted && iterator?.return) await calls.run(row, () => iterator.return());
      } finally {
        row.state = 'settled';
        row.interrupted = !finished;
        row.elapsedSeconds = (performance.now() - start) / 1000;
        row.costUSD = requestCost(options.model, usage, config.prices);
        if (row.costUSD !== null) spend += row.costUSD;
        row.measuredCaseCostUSD = spend;
        append(config.requestFile, row);
      }
    }
  });
}
