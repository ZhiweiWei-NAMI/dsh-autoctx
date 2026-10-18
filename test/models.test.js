import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  modelInfo,
  costUSD,
  availableModels,
  pickModel,
  briefCost,
  knowledge,
} from '../models.js';

test('costUSD prices disjoint host usage per 1M, with the long-prompt tier',()=>{
  assert.equal(costUSD('deepseek-v4.1-flash',{input:1e6,output:1e6,cacheRead:1e6}),0.753);
  assert.equal(costUSD('deepseek-v4.1-flash',{inputTokens:1e6,outputTokens:1e6,cacheReadTokens:1e6}),0.753);
  assert.equal(costUSD('claude-haiku-5-5',{input:20000,output:1000,cacheRead:5000,cacheWrite:10000}),0.0038);
  // 215K prompt tokens > 100K: every input-side price scales 5x and output uses the tier price.
  assert.equal(costUSD('claude-haiku-5-5',{input:200000,output:1000,cacheRead:5000,cacheWrite:10000}),0.109);
  assert.equal(costUSD('deepseek-v4.1-flash',{}),undefined);
  assert.equal(costUSD('no-such-model',{input:1e6}),undefined);
});

test('modelInfo resolves exact ids and the id after the last slash, case-insensitively',()=>{
  assert.equal(modelInfo('glm-5.3').family,'glm');
  assert.equal(modelInfo('workbuddy/glm-5.3-flash').id,'glm-5.3-flash');
  assert.equal(modelInfo('DEEPSEEK-V4.1-FLASH').id,'deepseek-v4.1-flash');
  assert.equal(modelInfo('nope/nope'),undefined);
  assert.equal(modelInfo(undefined),undefined);
});

test('availableModels keeps configured routes and hides paid ones unless allowed',()=>{
  const routes={'deepseek-v4.1-flash':'workbuddy','glm-5.3':'opencode-go','mimo-v2.6-flash':'opencode-go','ghost-model':'workbuddy'};
  assert.deepEqual(availableModels(routes).map(entry=>entry.id),['deepseek-v4.1-flash']);
  assert.deepEqual(availableModels(routes,{allowPaid:true}).map(entry=>entry.id),
    ['deepseek-v4.1-flash','mimo-v2.6-flash','glm-5.3']);
  assert.deepEqual(availableModels(undefined).length,0);
});

test('pickModel ranks by effective weight, then brief cost; family is no rule',()=>{
  const available=availableModels({'deepseek-v4.1-flash':'workbuddy','glm-5.3-flash':'workbuddy',
    'claude-haiku-5-5':'opencode-go-anthropic','deepseek-v4-pro':'workbuddy'},{allowPaid:true});
  // No evidence: every weight is neutral, so the cheapest brief wins, the executor's own model included.
  assert.equal(pickModel('reviewer',{available}).id,'claude-haiku-5-5');
  const weights={'deepseek-v4.1-flash':0.8};
  assert.equal(pickModel('reviewer',{available,weightOf:id=>weights[id]??0.5}).id,'deepseek-v4.1-flash');
  assert.equal(pickModel('reviewer',{available,weightOf:id=>weights[id]??0.5,exclude:['deepseek-v4.1-flash']}).id,'claude-haiku-5-5');
  assert.equal(pickModel('advisor',{available:[]}),undefined);
});

test('knowledge is sorted, deterministic and bounded',()=>{
  const first=knowledge(CATALOG.models);
  assert.ok(Buffer.byteLength(first,'utf8')<=4000);
  assert.equal(knowledge(CATALOG.models),first);
  assert.equal(knowledge([]),'');
  const ids=first.split('\n').map(row=>row.split(' | ')[0]);
  assert.deepEqual(ids,[...ids].sort());
  assert.ok(first.includes('measured as executor: 37/48, 42 calls/task, 11 hit call cap'));
  assert.ok(first.includes('deepseek-v4.1-flash | deepseek/flash | $0.15/0.6/0.003 per 1M | context 1000000 | prior: '));
  const long=CATALOG.models.map(entry=>({...entry,prior:'研究🚀'.repeat(2000)}));
  const shortened=knowledge(long);
  assert.ok(Buffer.byteLength(shortened,'utf8')<=4000);
  assert.ok(shortened.includes(' | prior: 研究🚀'));
  assert.ok(!shortened.includes('\ufffd'));
  assert.deepEqual(shortened.split('\n').map(row=>row.split(' | ')[0]),ids);
  assert.equal(knowledge([...long].reverse()),shortened);
  const fixedOverflow={...CATALOG.models[0],family:'family'.repeat(1000)};
  assert.equal(knowledge([fixedOverflow]),fixedOverflow.id);
});

test('malformed entries are skipped by selection and knowledge stays lenient',()=>{
  const valid=modelInfo('glm-5.3-flash');
  const broken=[{id:'no-price',roles:['reviewer']},null];
  const count=CATALOG.models.length;
  try {
    CATALOG.models.push(...broken);
    assert.deepEqual(availableModels({'no-price':'workbuddy',[valid.id]:'workbuddy'}),[valid]);
  } finally {
    CATALOG.models.length=count;
  }
  assert.equal(pickModel('reviewer',{available:[...broken,valid]}),valid);
  assert.equal(knowledge([...broken,valid]),knowledge([valid]));
  const unmeasured=knowledge([{...valid,measured:undefined}]);
  assert.equal(knowledge([{...valid,measured:{}}]),unmeasured);
  assert.equal(knowledge([{...valid,measured:{resolved:3,cases:null,callsPerCase:'bad',callCapped:0}}]),
    unmeasured+' | measured as executor: 3 resolved, 0 hit call cap');
  assert.equal(briefCost({id:'broken'}),Infinity);
});

test("routePolicy keeps preferred and allowed routes, drops others when one fits, and falls back otherwise", async () => {
  const { routePolicy } = await import("../models.js");
  const routes = { "deepseek-v4-pro": "workbuddy", "gpt-6.1-sol": "openai-codex", "claude-haiku-5-5": "opencode-go-anthropic" };
  const items = Object.keys(routes).map((id) => ({ id }));
  const by = (item) => routes[item.id];
  const policy = routePolicy(items, by, { preferred: ["workbuddy"], allowed: ["openai-codex"] });
  assert.deepEqual(policy.kept.map((item) => item.id), ["deepseek-v4-pro", "gpt-6.1-sol"]);
  assert.deepEqual(policy.dropped.map((item) => item.id), ["claude-haiku-5-5"]);
  assert.deepEqual(policy.preferredOnly.map((item) => item.id), ["deepseek-v4-pro"]);
  assert.equal(policy.isPreferred({ id: "gpt-6.1-sol" }), false);
  const codexOnly = routePolicy([{ id: "gpt-6.1-sol" }, { id: "claude-haiku-5-5" }], by, { preferred: ["workbuddy"], allowed: ["openai-codex"] });
  assert.deepEqual(codexOnly.kept.map((item) => item.id), ["gpt-6.1-sol"]);
  assert.deepEqual(codexOnly.preferredOnly, []);
  const none = routePolicy([{ id: "claude-haiku-5-5" }], by, { preferred: ["workbuddy"], allowed: ["openai-codex"] });
  assert.deepEqual(none.kept.map((item) => item.id), ["claude-haiku-5-5"]);
  assert.deepEqual(routePolicy(items, by).kept, items);
});

test("DSH GPT-family entries carry list prices, the long-context tier and the openai-codex route", async () => {
  const { modelInfo, costUSD } = await import("../models.js");
  for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const entry = modelInfo(id);
    assert.deepEqual(entry.routes, ["openai-codex"], id);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) assert.equal(typeof entry.price[key], "number", id + " " + key);
    assert.equal(entry.price.above.tokens, 272000);
  }
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + " != " + b);
  near(costUSD("gpt-6.1-sol", { inputTokens: 100000, cacheReadTokens: 100000, outputTokens: 10000 }), 0.2 + 0.01 + 0.1);
  near(costUSD("gpt-6.1-sol", { inputTokens: 200000, cacheReadTokens: 100000, outputTokens: 10000 }), 0.8 + 0.02 + 0.15);
});
