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

test("preferRoutes keeps preferred-provider models when one fits and falls back otherwise", async () => {
  const { preferRoutes } = await import("../models.js");
  const routes = { "deepseek-v4-pro": "workbuddy", "glm-5.3": "workbuddy", "claude-haiku-5-5": "opencode-go-anthropic" };
  const items = Object.keys(routes).map((id) => ({ id }));
  const by = (item) => routes[item.id];
  const preferred = preferRoutes(items, by, ["workbuddy"]);
  assert.deepEqual(preferred.kept.map((item) => item.id), ["deepseek-v4-pro", "glm-5.3"]);
  assert.deepEqual(preferred.dropped.map((item) => item.id), ["claude-haiku-5-5"]);
  const only = preferRoutes([{ id: "claude-haiku-5-5" }], by, ["workbuddy"]);
  assert.deepEqual(only, { kept: [{ id: "claude-haiku-5-5" }], dropped: [] });
  assert.deepEqual(preferRoutes(items, by, []), { kept: items, dropped: [] });
});
