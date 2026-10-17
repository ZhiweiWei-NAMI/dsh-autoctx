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

test('costUSD prices uncached and cached tokens per 1M',()=>{
  assert.equal(costUSD('deepseek-v4.1-flash',{input:1e6,output:1e6,cacheRead:1e6}),0.753);
  assert.equal(costUSD('claude-haiku-5-5',{input:200000,output:1000,cacheRead:5000,cacheWrite:10000}),0.0218);
  assert.equal(costUSD('deepseek-v4.1-flash',{}),0);
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

test('pickModel reviewer avoids the executor family',()=>{
  const available=availableModels({'deepseek-v4.1-flash':'workbuddy','glm-5.3-flash':'workbuddy',
    'claude-haiku-5-5':'opencode-go-anthropic','deepseek-v4-pro':'workbuddy'},{allowPaid:true});
  const choice=pickModel('reviewer',{executor:'deepseek-v4.1-flash',available,exclude:['glm-5.3-flash']});
  assert.equal(choice.family,'claude');
});

test('pickModel advisor prefers a pro tier and then a different family',()=>{
  const available=availableModels({'claude-haiku-5-5':'opencode-go-anthropic','deepseek-v4-pro':'workbuddy','glm-5.3':'opencode-go'},{allowPaid:true});
  const choice=pickModel('advisor',{executor:'deepseek-v4.1-flash',available});
  assert.equal(choice.tier,'pro');
  assert.equal(choice.id,'glm-5.3');
});

test('pickModel worker reuses the executor model and honors exclude',()=>{
  const available=availableModels({'deepseek-v4.1-flash':'workbuddy','glm-5.3-flash':'workbuddy'},{allowPaid:true});
  assert.equal(pickModel('worker',{executor:'deepseek-v4.1-flash',available}).id,'deepseek-v4.1-flash');
  assert.equal(pickModel('worker',{executor:'deepseek-v4.1-flash',available,exclude:['deepseek-v4.1-flash']}).id,'glm-5.3-flash');
  assert.equal(pickModel('advisor',{executor:'deepseek-v4.1-flash',available}),undefined);
});

test('knowledge is sorted, deterministic and bounded',()=>{
  const first=knowledge(CATALOG.models);
  assert.ok(Buffer.byteLength(first,'utf8')<=4000);
  assert.equal(knowledge(CATALOG.models),first);
  assert.equal(knowledge([]),'');
  const ids=first.split('\n').map(row=>row.split(' | ')[0]);
  assert.deepEqual(ids,[...ids].sort());
  assert.ok(first.includes('measured 37/48, 42 calls/task, 11 hit call cap'));
  assert.ok(first.includes('deepseek-v4.1-flash | deepseek/flash | $0.15/0.6/0.003 per 1M | roles: executor,worker'));
  const long=CATALOG.models.map(entry=>({...entry,strengths:'研究🚀'.repeat(2000),weaknesses:'long '.repeat(2000)}));
  const shortened=knowledge(long);
  assert.ok(Buffer.byteLength(shortened,'utf8')<=4000);
  assert.ok(shortened.includes(' | + 研究🚀'));
  assert.ok(!shortened.includes('\ufffd'));
  assert.deepEqual(shortened.split('\n').map(row=>row.split(' | ')[0]),ids);
  assert.equal(knowledge([...long].reverse()),shortened);
  const fixedOverflow={...CATALOG.models[0],family:'family'.repeat(1000)};
  assert.equal(knowledge([fixedOverflow]),fixedOverflow.id);
});

test('malformed entries are skipped by selection and knowledge stays lenient',()=>{
  const valid=modelInfo('glm-5.3-flash');
  const broken=[{id:'no-price',roles:['reviewer']},{id:'no-roles',price:valid.price},null];
  const count=CATALOG.models.length;
  try {
    CATALOG.models.push(...broken);
    assert.deepEqual(availableModels({'no-price':'workbuddy','no-roles':'workbuddy',[valid.id]:'workbuddy'}),[valid]);
  } finally {
    CATALOG.models.length=count;
  }
  assert.equal(pickModel('reviewer',{executor:'deepseek-v4.1-flash',available:[...broken,valid]}),valid);
  assert.equal(knowledge([...broken,valid]),knowledge([valid]));
  const unmeasured=knowledge([{...valid,measured:undefined}]);
  assert.equal(knowledge([{...valid,measured:{}}]),unmeasured);
  assert.equal(knowledge([{...valid,measured:{resolved:3,cases:null,callsPerCase:'bad',callCapped:0}}]),
    unmeasured+' | measured 3 resolved, 0 hit call cap');
  assert.equal(briefCost({id:'broken'}),Infinity);
});
