import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fingerprint, sharedPrefix, reusableTokens, switchEstimate } from "../cachespace.js";

const messages = [
  { role: "system", content: "Keep the exact prefix" },
  { role: "user", content: "Fix the failure" },
  { role: "assistant", content: "Inspecting" },
];
const options = { provider: "native", model: "executor", tools: [{ name: "read" }], messages };
const make = (changes = {}) => fingerprint({ ...options, ...changes }, (message) => message.content.length);
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("fingerprints chain full SHA-256 prefixes and retain only digests and counts", () => {
  const result = make();
  const config = hash(JSON.stringify({ provider: "native", model: "executor", effort: null, tools: options.tools }));
  assert.equal(result.config, config);
  assert.equal(result.space, "native|executor|default");
  let previous = config;
  for (const [i, message] of messages.entries()) {
    previous = hash(previous + JSON.stringify(message));
    assert.equal(result.hashes[i], previous);
    assert.match(result.hashes[i], /^[a-f0-9]{64}$/);
    assert.equal(result.tokens[i], message.content.length);
  }
  assert.equal(Object.hasOwn(result, "messages"), false);
  assert.equal(Object.hasOwn(result, "tools"), false);
  for (const invalid of [-1, NaN, Infinity])
    assert.throws(() => fingerprint(options, () => invalid), RangeError);
});

test("sharing requires the exact leading message order and tools, independently of effort", () => {
  const original = make();
  const high = make({ reasoningEffort: "high" });
  assert.notEqual(original.config, high.config);
  assert.notEqual(original.hashes[0], high.hashes[0]);
  assert.equal(sharedPrefix(original, high), messages.length);
  assert.equal(sharedPrefix(original, make({ messages: [messages[0], { role: "user", content: "Inserted" }, ...messages.slice(1)] })), 1);
  assert.equal(sharedPrefix(original, make({ messages: [messages[1], messages[0], messages[2]] })), 0);
  assert.equal(sharedPrefix(original, make({ tools: [{ name: "write" }] })), 0);
  assert.equal(sharedPrefix(original, make({ messages: [...messages, { role: "user", content: "Next" }] })), messages.length);
});

test("reuse sums only the latest shared prefix and expires at the assumed TTL", () => {
  const target = make({ reasoningEffort: "high", messages: messages.slice(0, 2) });
  const latest = make();
  const expected = latest.tokens[0] + latest.tokens[1];
  assert.equal(reusableTokens(target, latest, { now: 1100, at: 1000, ttlMs: 100 }), expected);
  assert.equal(reusableTokens(target, latest, { now: 1101, at: 1000, ttlMs: 100 }), 0);
  assert.equal(reusableTokens(undefined, latest, { now: 1100, at: 1000, ttlMs: 100 }), 0);
  assert.equal(reusableTokens(make({ model: "other" }), latest, { now: 1100, at: 1000, ttlMs: 100 }), 0);
});

test("switch estimates include pending tokens and six-decimal extra input cost", () => {
  const latest = fingerprint(options, () => 1000);
  const target = fingerprint({ ...options, reasoningEffort: "high", messages: messages.slice(0, 2) }, () => 900);
  const input = { latest, target, at: 1000, now: 1100, ttlMs: 100, pendingTokens: 500,
    price: { input: 2, cacheRead: 0.5 } };
  assert.deepEqual(switchEstimate(input), {
    totalTokens: 3500, reusableTokens: 2000, uncachedTokens: 1500, usd: 0.00225,
  });
  assert.deepEqual(switchEstimate({ ...input, target: undefined }), {
    totalTokens: 3500, reusableTokens: 0, uncachedTokens: 3500, usd: 0.00525,
  });
  assert.equal(switchEstimate({ ...input, price: { input: 2 } }).usd, 0);
  assert.equal(switchEstimate({ ...input, pendingTokens: 501, price: { input: 0.15, cacheRead: 0.003 } }).usd, 0.000221);
});
