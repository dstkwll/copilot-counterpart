import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegationTree } from '../src/tree.mjs';
import { Supervisor } from '../src/supervisor.mjs';
const catalog = () => ['gpt-6-astra','gpt-6-luna','gpt-6-sol','claude-opus-5.5'].map(id => ({id,supportedReasoningEfforts:['high','medium']}));
const brief = (allowDelegation=false) => ({task:'compute',context:'synthetic',acceptanceCriteria:'answer',role:'analysis',complexity:'small',risk:'low',allowDelegation});
function harness(behavior, limits={}, options={}) {
  const events=[], opened=[], stopped=[];
  let tree;
  const outer=new Supervisor(()=>tree=new DelegationTree(limits,node=>({
    open:async(model,emit)=>{
      opened.push({node,model});
      return {send:async()=>{
        await behavior({tree,node,model,emit});
        emit({type:'assistant.usage',data:{model:options.wrongModel??model,inputTokens:10,outputTokens:5}});
        emit({type:'assistant.message',data:{content:'answer42'}});
        emit({type:'session.idle',data:{}});
      }};
    },
    close:async()=>{if(!node.stopped){node.stopped=true;stopped.push(node);}if(options.cleanupFailure)throw Error('cleanup failure');}
  }),options.catalog??catalog(),{}));
  const original=outer.record.bind(outer);
  outer.record=(job,type,data)=>{events.push({type,data});original(job,type,data);};
  const result=outer.start({requestId:'root',prompt:'synthetic',model:'gpt-6-astra',reasoningEffort:'high',timeoutSeconds:options.timeout??20,delegation:limits});
  return {outer,get tree(){return tree;},job:outer.get(result.jobId),opened,stopped,events};
}

test('Astra -> routed child -> routed grandchild; usage aggregated once; no child result overwrites root',async()=>{
 const h=harness(async({tree,node})=>{
   if(node.depth<2){const r=await tree.tool(node).handler(brief(true),{toolCallId:'one'});assert.equal(JSON.parse(r).status,'completed');}
   else assert.equal(tree.tool(node),undefined);
 });
 await h.job.task;
 assert.equal(h.job.status,'completed');assert.equal(h.job.result,'answer42');
 assert.deepEqual(h.opened.map(x=>x.model),['gpt-6-astra','gpt-6-luna','gpt-6-luna']);
 assert.equal(h.stopped.length,3);assert.equal(h.job.usage.inputTokens,30);
 assert.equal(h.job.usage.events,3);assert.ok(h.events.some(e=>e.data?.depth===2));
});

test('leaf handoff has no delegation tool even with unused depth',async()=>{
 const h=harness(async({tree,node})=>{
  if(node.depth===0)await tree.tool(node).handler(brief(),{toolCallId:'one'});
  else assert.equal(tree.tool(node),undefined);
 });await h.job.task;assert.equal(h.opened.length,2);
});

test('parallel admissions and duplicate callbacks obey one total cap without queue deadlock',async()=>{
 const h=harness(async({tree,node})=>{
  if(node.depth)return;
  const a=tree.delegate(node,brief(),'same');
  assert.equal(tree.delegate(node,brief(),'same'),a);
  assert.throws(()=>tree.delegate(node,{...brief(),task:'changed'},'same'),/Conflicting/);
  const b=tree.delegate(node,brief(),'two');
  assert.throws(()=>tree.delegate(node,brief(),'three'),/total node/);
  await Promise.all([a,b]);
 },{maxNodes:3});await h.job.task;assert.equal(h.opened.length,3);assert.equal(h.job.status,'completed');
});

test('depth zero and schema bounds prevent further authority',async()=>{
 const h=harness(async({tree,node})=>{
  assert.equal(tree.tool(node),undefined);
  assert.throws(()=>tree.delegate(node,brief(),'x'),/depth/);
 },{maxDepth:0});await h.job.task;assert.equal(h.opened.length,1);
 assert.throws(()=>new DelegationTree({maxNodes:9},()=>{},catalog()));
});

test('unknown tool fields rejected before model lookup; failed route does not refund admission',async()=>{
 const h=harness(async({tree,node})=>{
  assert.throws(()=>tree.delegate(node,{...brief(),model:'gpt-6-astra'},'bad'));
  const r=JSON.parse(await tree.tool(node).handler(brief(),{toolCallId:'one'}));assert.equal(r.status,'rejected');
  assert.throws(()=>tree.delegate(node,brief(),'two'),/total node/);
 },{maxNodes:2},{catalog:[]});await h.job.task;assert.equal(h.opened.length,1);
});

test('effective model mismatch cancels entire tree and cannot return accepted completion',async()=>{
 const h=harness(async()=>{},{},{wrongModel:'unexpected'});await h.job.task;
 assert.equal(h.job.status,'failed');assert.match(h.job.error,/Effective model/);assert.equal(h.stopped.length,1);
});

test('observed usage threshold closes admission; this is not a hard token cap',async()=>{
 const h=harness(async()=>{},{maxObservedTokens:1});await h.job.task;
 assert.equal(h.job.status,'failed');assert.match(h.job.error,/usage limit/);assert.equal(h.job.usage.inputTokens,10);
});

test('cleanup failure retains outer capacity',async()=>{
 const h=harness(async()=>{},{},{cleanupFailure:true});await h.job.task;
 assert.equal(h.job.cleanupComplete,undefined);
 await assert.rejects(h.outer.forget(h.job.id),/cleanup is unconfirmed/);
});

test('missing usage evidence does not accept root completion',async()=>{
 let tree;const outer=new Supervisor(()=>tree=new DelegationTree({},()=>({open:async(model,e)=>({send:async()=>e({type:'session.idle',data:{}})}),close:async()=>{}}),catalog()));
 const j=outer.get(outer.start({requestId:'missing',prompt:'x',model:'gpt-6-astra',timeoutSeconds:3}).jobId);await j.task;
 assert.equal(j.status,'failed');assert.match(j.error,/Missing effective-model/);
});

test('model mismatch stops a blocked send immediately rather than waiting for its cleared deadline',async()=>{
 let tree,release,stops=0;
 const outer=new Supervisor(()=>tree=new DelegationTree({},()=>({
  open:async(model,e)=>({send:async()=>{
    const blocked=new Promise(r=>release=r);
    e({type:'assistant.usage',data:{model:'wrong',inputTokens:1,outputTokens:1}});
    await blocked;
  }}),close:async()=>{if(!stops)stops++;release?.();}
 }),catalog()));
 const job=outer.get(outer.start({requestId:'blocked',prompt:'x',model:'gpt-6-astra',timeoutSeconds:10}).jobId);
 await Promise.race([job.task,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('failed to interrupt')),1000);t.unref();})]);
 assert.equal(job.status,'failed');assert.equal(stops,1);assert.equal(job.cleanupComplete,true);
});

test('cancel while grandchild is active closes every descendant and prevents further sends',async()=>{
 let tree,ready;const running=new Promise(r=>ready=r);const stops=[];
 const outer=new Supervisor(()=>tree=new DelegationTree({},node=>{
  let release;
  return {open:async(model,e)=>({send:async()=>{
    if(node.depth<2)await tree.tool(node).handler(brief(true),{toolCallId:'child'});
    else {const wait=new Promise(r=>release=r);ready();await wait;}
    e({type:'assistant.usage',data:{model,inputTokens:1,outputTokens:1}});e({type:'session.idle',data:{}});
  }}),close:async()=>{if(!stops.includes(node.depth))stops.push(node.depth);release?.();}};
 },catalog()));
 const job=outer.get(outer.start({requestId:'cancel',prompt:'x',model:'gpt-6-astra',timeoutSeconds:10}).jobId);
 await running;await outer.cancel(job.id);await job.task;
 assert.equal(job.status,'cancelled');assert.deepEqual(stops.sort(),[0,1,2]);assert.equal(job.cleanupComplete,true);
});

test('child results are capped before returning to the parent',async()=>{
 let tree;const outer=new Supervisor(()=>tree=new DelegationTree({},node=>({
  open:async(model,e)=>({send:async()=>{
    if(node.depth===0){const r=await tree.delegate(node,brief(),'long');assert.equal(r.result.length,12000);assert.equal(r.truncated,true);}
    e({type:'assistant.usage',data:{model,inputTokens:1,outputTokens:1}});
    e({type:'assistant.message',data:{content:'a'.repeat(15000)}});e({type:'session.idle',data:{}});
  }}),close:async()=>{}
 }),catalog()));
 const j=outer.get(outer.start({requestId:'long',prompt:'x',model:'gpt-6-astra',timeoutSeconds:10}).jobId);await j.task;assert.equal(j.status,'completed');
});
