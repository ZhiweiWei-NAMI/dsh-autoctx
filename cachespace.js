import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const nonnegative = (value) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Expected a finite nonnegative token count");
  return value;
};

// Retain digests and counts only. The second chain lets sharedPrefix ignore effort while
// hashes still fingerprint the complete configuration, including effort, as sent.
export function fingerprint({ provider, model, reasoningEffort, tools, messages }, tokensOf) {
  const effort = reasoningEffort ?? null;
  const config = hash(JSON.stringify({ provider, model, effort, tools }));
  const toolsHash = hash(JSON.stringify({ tools }));
  const hashes = [], prefixes = [], tokens = [];
  let previous = config, prefix = toolsHash;
  for (const message of messages) {
    const serialized = JSON.stringify(message);
    previous = hash(previous + serialized);
    prefix = hash(prefix + serialized);
    hashes.push(previous);
    prefixes.push(prefix);
    tokens.push(nonnegative(tokensOf(message)));
  }
  return { space: `${provider}|${model}|${effort ?? "default"}`, config, toolsHash, hashes, prefixes, tokens };
}

export function sharedPrefix(a, b) {
  if (!a || !b || a.toolsHash !== b.toolsHash) return 0;
  let k = 0;
  while (k < Math.min(a.prefixes.length, b.prefixes.length) && a.prefixes[k] === b.prefixes[k]) k++;
  return k;
}

export function reusableTokens(target, latest, { now, at, ttlMs }) {
  if (!target || now - at > ttlMs || !Number.isFinite(at)) return 0;
  // Provider/model identity must match too; effort identifies the destination cache space.
  const route = (value) => value.space.slice(0, value.space.lastIndexOf("|"));
  if (route(target) !== route(latest)) return 0;
  return latest.tokens.slice(0, sharedPrefix(target, latest)).reduce((sum, value) => sum + value, 0);
}

export function switchEstimate({ latest, target, at, now, ttlMs, pendingTokens, price }) {
  const totalTokens = latest.tokens.reduce((sum, value) => sum + value, 0) + nonnegative(pendingTokens);
  const reused = reusableTokens(target, latest, { now, at, ttlMs });
  const uncachedTokens = totalTokens - reused;
  const usd = Math.round(uncachedTokens * (price.input - (price.cacheRead ?? price.input))) / 1e6;
  return { totalTokens, reusableTokens: reused, uncachedTokens, usd };
}
