import test from 'node:test';
import assert from 'node:assert/strict';
import {newStats,applyStatsRecord} from '../stats.js';

test('stats reducer tracks dispatched decisions, children and compactions per session',()=>{
  let stats=newStats('auto',12,64000);
  stats=applyStatsRecord(stats,{},1);
  stats=applyStatsRecord(stats,{kind:'jev'},1);
  stats=applyStatsRecord(stats,{},2);
  assert.equal(stats.decisions,2);
  stats=applyStatsRecord(stats,{kind:'child_start',active:1});
  stats=applyStatsRecord(stats,{kind:'child_start',active:2});
  assert.equal(stats.delegations,2);
  assert.equal(stats.activeChildren,2);
  stats=applyStatsRecord(stats,{kind:'child_end',active:1});
  assert.equal(stats.activeChildren,1);
  assert.equal(stats.childrenDone,1);
  stats=applyStatsRecord(stats,{kind:'context_pressure',nativeEstimate:41000,pressure:41000});
  assert.equal(stats.contextTokens,41000);
  stats=applyStatsRecord(stats,{kind:'context_scores',session:'root',estimatedBefore:20000,estimatedAfter:1600});
  stats=applyStatsRecord(stats,{kind:'context_scores',session:'child',estimatedBefore:1000,estimatedAfter:900});
  stats=applyStatsRecord(stats,{kind:'context_replaced',session:'root'});
  assert.equal(stats.compactions,1);
  assert.equal(stats.tokensSaved,18400);
  assert.deepEqual(stats.pendingSaved,{child:100});
  stats=applyStatsRecord(stats,{kind:'context_scores',session:'child',estimatedBefore:1000,estimatedAfter:900});
  stats=applyStatsRecord(stats,{kind:'context_kept',session:'child',reason:'no reduction'});
  assert.equal(stats.compactions,1);
  assert.equal(stats.tokensSaved,18400);
  assert.deepEqual(stats.pendingSaved,{});
});

test('stats reducer records the last decision route and mode changes',()=>{
  let stats=newStats('auto',12,64000);
  stats=applyStatsRecord(stats,{kind:'policy_snapshot',mode:'single'});
  assert.equal(stats.mode,'single');
  stats=applyStatsRecord(stats,{kind:'delegation_decision',profile:{label:'general',options:{reasoningEffort:'high'}}});
  assert.equal(stats.lastDecision,'general/high');
  const untouched=newStats('auto',12,64000);
  const after=applyStatsRecord(untouched,{kind:'native_message_error',session:'x'});
  assert.deepEqual(after,untouched);
});
