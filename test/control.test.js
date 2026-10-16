import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../index.js';

function composition(mode) {
  const handlers = new Map();
  let guard;
  const ctx = {tools:{guard(fn){guard=fn;}}, on(name,fn){handlers.set(name,fn);}, inject(){}};
  apply(ctx,{mode,maxChildren:2,maxConcurrent:2,pressureTokens:24000,retainTokens:8000});
  return {guard,handlers};
}

test('ordinary native tool executions remain usable in single-agent mode',()=>{
  const {guard}=composition('single');
  assert.equal(guard({name:'bash',arguments:{command:'python -m unittest'},callId:'call-1'}),undefined);
  assert.match(guard({name:'subagent',arguments:{},callId:'call-2'}),/main agent only/);
});

test('delegation on a non-routed session uses native dispatch',async()=>{
  const {handlers}=composition('native');
  const agent={session:{id:'root',header:{}}};
  const result={isError:false,value:{kind:'continuable',subagentId:'child'},content:[]};
  let calls=0;
  const actual=await handlers.get('tools/execute')({name:'subagent',arguments:{},agent},async()=>{
    calls++;
    return result;
  });
  assert.equal(calls,1);
  assert.equal(actual,result);
});

test('native delegation reservations share a task limit and release on failure',()=>{
  const {guard,handlers}=composition('native');
  const agent={session:{id:'root',header:{}}};
  const first={name:'subagent',callId:'first',agent};
  const second={name:'subagent_fork',callId:'second',agent};
  assert.equal(guard(first),undefined);
  assert.equal(guard(second),undefined);
  assert.match(guard({name:'subagent',callId:'third',agent}),/limit reached/);
  handlers.get('tools/result')(first,{isError:true});
  assert.equal(guard({name:'subagent',callId:'replacement',agent}),undefined);
  const unrelated={session:{id:'other-task',header:{}}};
  assert.equal(guard({name:'subagent',callId:'other',agent:unrelated}),undefined);
});

test('the final budgeted child report concludes the returned native result',async()=>{
  const handlers=new Map();
  const agent={session:{id:'child',header:{parentSession:'root'},snapshotEvents:()=>[],requestHeader:()=>undefined}};
  const ctx={
    tools:{guard(){},get:()=>({})},
    agents:{get:id=>id==='child'?agent:undefined},
    tokenMeter:{measure:()=>({totalTokens:100})},
    on(name,fn){handlers.set(name,fn);},inject(){},
  };
  apply(ctx,{mode:'native',retainTokens:8000,maxChildRequests:16,maxChildTurnRequests:2});
  await handlers.get('agent/pre-step')({agent,messages:[],turn:'turn',signal:new AbortController().signal},async()=>({kind:'continue'}));
  for(let i=0;i<2;i++){
    const stream=handlers.get('llm/stream')({sessionId:'child'},async function*(){});
    await stream.next();
  }
  const result={isError:false,value:{accepted:true},content:[]};
  let dispatched=0;
  const actual=await handlers.get('tools/execute')({
    name:'send_message',agent,arguments:{agent_id:'root',message:'Completed the assigned work.'},
    concludeTurn(){},
  },async()=>{dispatched++;return result;});
  assert.equal(dispatched,1);
  assert.deepEqual(actual,{...result,concludesTurn:true});
});
