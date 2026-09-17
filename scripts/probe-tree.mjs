import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv.includes('--live'))throw Error('Explicit --live required; consumes Copilot allowance.');
const client=new Client({name:'nested-probe',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],stderr:'pipe'});
let jobId;
try {
 await client.connect(transport);
 const call=async(name,args)=>{
  const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);
 };
 const root=await call('copilot_orchestrate',{requestId:`probe-${Date.now()}`,sharingAuthorized:true,model:'gpt-6-astra',reasoningEffort:'high',timeoutSeconds:150,limits:{maxNodes:3,maxDepth:2,maxObservedTokens:30000,maxUsageEvents:12},prompt:'Synthetic delegation capability test. Use delegate_task exactly once with role analysis, complexity small, risk low, allowDelegation true. Ask that child to use its delegate_task exactly once (analysis/small/low, allowDelegation false) to compute 17+25. Give the child this complete instruction as task and context and require that it actually delegates. Wait for its answer. Then return only the arithmetic answer. Do not solve directly; we are testing two levels of delegation. Keep briefs under 100 words.'});
 jobId=root.jobId;console.log(JSON.stringify({started:jobId,model:root.model}));
 let after=0,done=false,cancelled=false;const nodes=new Map();
 while(!done){
  const r=await call('copilot_events',{jobId,after,limit:100,waitMs:1000});after=r.nextCursor;
  for(const e of r.events){if(e.type==='supervisor.node'){nodes.set(e.data.nodeId,e.data);console.log(JSON.stringify(e.data));if(process.argv.includes('--cancel') && e.data.depth===2 && !cancelled){cancelled=true;await call('copilot_cancel',{jobId});}}}
  if(['completed','failed','timed_out','cancelled'].includes(r.status)&&!r.hasMore){
   console.log(JSON.stringify({status:r.status,result:r.result,error:r.error,usage:r.usage}));
   if(cancelled){assert.equal(r.status,'cancelled');done=true;continue;}
   assert.equal(r.status,'completed');assert.match(r.result,/42/);
   assert.equal(nodes.size,3);assert.deepEqual([...nodes.values()].map(n=>n.depth).sort(),[0,1,2]);
   assert.equal([...nodes.values()].find(n=>n.depth===0).effectiveModel,'gpt-6-astra');
   assert.ok([...nodes.values()].filter(n=>n.depth>0).every(n=>n.effectiveModel==='gpt-5.6-luna'));done=true;
  }
 }
 await call('copilot_forget',{jobId});jobId=undefined;
} finally {
 if(jobId)await client.callTool({name:'copilot_cancel',arguments:{jobId}}).catch(()=>{});
 await client.close();
}
