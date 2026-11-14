import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, resolveLeadFamily } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';

test('MCP tools negotiate, validate and dispatch without GitHub requests', async () => {
  const supervisor = new Supervisor(() => ({ open: async () => ({ send: async () => {} }), close: async () => {} }));
  const { server } = createServer(supervisor, async () => [{ id: 'test-model' }]);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.equal((await client.listTools()).tools.length, 10);
    const models = await client.callTool({ name: 'copilot_models', arguments: {} });
    assert.match(models.content[0].text, /test-model/);
    const invalid = await client.callTool({ name: 'copilot_start', arguments: { prompt: 'x' } });
    assert.equal(invalid.isError, true);
    const started = await client.callTool({ name: 'copilot_start', arguments: { requestId: 'mcp-1', model: 'test-model', prompt: 'sample' } });
    const { jobId } = JSON.parse(started.content[0].text);
    const cancelled = await client.callTool({ name: 'copilot_cancel', arguments: { jobId } });
    assert.equal(JSON.parse(cancelled.content[0].text).status, 'cancelled');
  } finally { await supervisor.close(); await client.close(); await server.close(); }
});

test('orchestration requires sharing, validates model, deduplicates and exposes limits',async()=>{
 let lookups=0;
 const supervisor=new Supervisor(()=>({open:async()=>({send:async()=>{}}),close:async()=>{}}));
 const {server}=createServer(supervisor,async()=>{lookups++;return [{id:'gpt-6-astra',supportedReasoningEfforts:['high']}];});
 const client=new Client({name:'tree-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(a),client.connect(b)]);
 const call=arguments_=>client.callTool({name:'copilot_orchestrate',arguments:arguments_});
 try {
  const args={requestId:'tree',prompt:'x',model:'gpt-6-astra'};
  assert.equal((await call(args)).isError,true);assert.equal(lookups,0);
  args.sharingAuthorized=true;
  const [x,y]=await Promise.all([call(args),call(args)]);
  assert.equal(x.isError,undefined);const first=JSON.parse(x.content[0].text);
  assert.equal(first.jobId,JSON.parse(y.content[0].text).jobId);assert.equal(lookups,1);
  assert.equal(first.delegation.maxDepth,2);assert.equal(first.delegation.maxNodes,8);
  assert.equal((await call({...args,prompt:'different'})).isError,true);
  assert.equal((await call({...args,requestId:'unavailable',model:'unknown'})).isError,true);
  assert.equal(supervisor.jobs.size,1);
 } finally {await supervisor.close();await client.close();await server.close();}
});

test('COPILOT_SUPERVISOR_LEAD_FAMILY is normalized; unknown values are ignored', () => {
  assert.equal(resolveLeadFamily(undefined), undefined);
  assert.equal(resolveLeadFamily(' Anthropic '), 'anthropic');
  assert.equal(resolveLeadFamily('openai'), 'openai');
  const write = process.stderr.write; let warned = '';
  process.stderr.write = chunk => { warned += chunk; return true; };
  try { assert.equal(resolveLeadFamily('gemini'), undefined); } finally { process.stderr.write = write; }
  assert.match(warned, /ignoring unknown/);
});
