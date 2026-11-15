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
    assert.equal((await client.listTools()).tools.length, 15);
    const models = await client.callTool({ name: 'copilot_models', arguments: {} });
    assert.match(models.content[0].text, /test-model/);
    const invalid = await client.callTool({ name: 'copilot_start', arguments: { prompt: 'x' } });
    assert.equal(invalid.isError, true);
    const unattested = await client.callTool({ name: 'copilot_start', arguments: { requestId: 'mcp-0', model: 'test-model', prompt: 'sample' } });
    assert.equal(unattested.isError, true);
    assert.match(unattested.content[0].text, /sharingAuthorized/);
    const started = await client.callTool({ name: 'copilot_start', arguments: { requestId: 'mcp-1', model: 'test-model', prompt: 'sample', sharingAuthorized: true } });
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

test('COPILOT_COUNTERPART_LEAD_FAMILY is normalized; unknown values are ignored', () => {
  assert.equal(resolveLeadFamily(undefined), undefined);
  assert.equal(resolveLeadFamily(' Anthropic '), 'anthropic');
  assert.equal(resolveLeadFamily('openai'), 'openai');
  const saved = { ...process.env };
  try {
    delete process.env.COPILOT_COUNTERPART_LEAD_FAMILY; process.env.COPILOT_SUPERVISOR_LEAD_FAMILY = 'anthropic';
    assert.equal(resolveLeadFamily(), 'anthropic');
    process.env.COPILOT_COUNTERPART_LEAD_FAMILY = 'openai';
    assert.equal(resolveLeadFamily(), 'openai');
  } finally { process.env = saved; }
  const write = process.stderr.write; let warned = '';
  process.stderr.write = chunk => { warned += chunk; return true; };
  try { assert.equal(resolveLeadFamily('gemini'), undefined); } finally { process.stderr.write = write; }
  assert.match(warned, /ignoring unknown/);
});

test('failed orchestration before admission frees its request ID for retry', async () => {
  let fail = true, lookups = 0;
  const supervisor = new Supervisor(() => ({ open: async () => ({ send: async () => {} }), close: async () => {} }));
  const { server } = createServer(supervisor, async () => { lookups++; if (fail) throw Error('catalog down'); return [{ id: 'gpt-6-astra', supportedReasoningEfforts: ['high'] }]; });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const args = { requestId: 'o1', prompt: 'p', sharingAuthorized: true, model: 'gpt-6-astra', reasoningEffort: 'high' };
  try {
    for (let i = 0; i < 70; i++) {
      const r = await client.callTool({ name: 'copilot_orchestrate', arguments: { ...args, requestId: `f${i}` } });
      assert.match(r.content[0].text, /catalog down/);
    }
    fail = false;
    const ok = await client.callTool({ name: 'copilot_orchestrate', arguments: args });
    assert.equal(ok.isError, undefined);
    assert.equal(lookups, 71);
  } finally { await supervisor.close(); await client.close(); await server.close(); }
});

test('routed job with files stages an edit; changes then apply writes it through MCP', async () => {
  const { mkdtemp, writeFile, readFile, rm, realpath } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-ws-')));
  await writeFile(join(root, 'a.js'), 'let x = 1;\n');
  let seenPrompt;
  const supervisor = new Supervisor(job => ({ close: async () => {}, open: async (model, onEvent) => ({
    send: async ({ prompt }) => {
      seenPrompt = prompt;
      const tools = Object.fromEntries(job.workspace.tools().map(t => [t.name, t]));
      await tools.workspace_read.handler({ path: 'a.js' });
      await tools.workspace_edit.handler({ path: 'a.js', oldString: '1', newString: '2' });
      onEvent({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'workspace_read', arguments: { path: 'a.js' } } });
      onEvent({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'let x = 1;' } } });
      onEvent({ type: 'session.idle', data: {} });
    } }) }));
  const { server } = createServer(supervisor, async () => [{ id: 'gpt-6.1-sol', supportedReasoningEfforts: ['medium', 'high'] }], { leadFamily: 'anthropic' });
  const client = new Client({ name: 'ws', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) }; };
  try {
    const bad = await call('copilot_delegate', { requestId: 'w0', role: 'code_proposal', task: 't', context: 'c', acceptanceCriteria: 'a', sharingAuthorized: true, files: { root, read: ['../'] } });
    assert.equal(bad.error, true);
    const started = await call('copilot_delegate', { requestId: 'w1', role: 'code_proposal', task: 'bump x', context: 'see a.js', acceptanceCriteria: 'x is 2', sharingAuthorized: true, files: { root, read: ['.'], write: ['a.js'] } });
    assert.equal(started.error, undefined);
    const { jobId } = started.data;
    let done, cursor = 0; const events = [];
    for (let i = 0; i < 20; i++) {
      done = await call('copilot_events', { jobId, after: cursor, waitMs: 500 });
      events.push(...done.data.events); cursor = done.data.nextCursor;
      if (done.data.status === 'completed' && !done.data.hasMore) break;
    }
    assert.equal(done.data.status, 'completed');
    assert.match(seenPrompt, /Granted files[\s\S]*Writable \(staged/);
    assert.ok(events.some(e => e.type === 'supervisor.file_access' && e.data.op === 'stage' && e.data.path === 'a.js'));
    assert.deepEqual(done.data.workspace.staged.map(s => s.path), ['a.js']);
    const toolEvents = events.filter(e => e.type.startsWith('tool.'));
    assert.equal(toolEvents.length, 2);
    assert.ok(toolEvents.every(e => e.data.redacted && !e.data.result && !e.data.arguments));
    assert.ok(!JSON.stringify(events).includes('let x = 1;'));
    assert.equal(await readFile(join(root, 'a.js'), 'utf8'), 'let x = 1;\n');
    const changes = await call('copilot_changes', { jobId });
    assert.match(changes.data.files[0].diff, /\+let x = 2;/);
    assert.equal((await call('copilot_apply', { jobId, changeSetHash: 'f'.repeat(64) })).error, true);
    const applied = await call('copilot_apply', { jobId, changeSetHash: changes.data.changeSetHash });
    assert.deepEqual(applied.data.applied, ['a.js']);
    assert.equal(await readFile(join(root, 'a.js'), 'utf8'), 'let x = 2;\n');
    const plain = await call('copilot_start', { requestId: 's1', model: 'gpt-6.1-sol', prompt: 'p', sharingAuthorized: true });
    assert.match((await call('copilot_changes', { jobId: plain.data.jobId })).data, /not granted files/);
  } finally { await supervisor.close(); await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('orchestration accepts files, web and actions grants shared by the tree', async () => {
  const { mkdtemp, writeFile, rm, realpath } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tree-ws-')));
  await writeFile(join(root, 'a.md'), 'hello\n');
  const supervisor = new Supervisor(() => ({ open: async () => ({ send: async () => {} }), close: async () => {} }));
  const { server } = createServer(supervisor, async () => [{ id: 'gpt-6-astra', supportedReasoningEfforts: ['high'] }]);
  const client = new Client({ name: 't', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const r = await client.callTool({ name: 'copilot_orchestrate', arguments: { requestId: 'tw', prompt: 'x', model: 'gpt-6-astra', sharingAuthorized: true, files: { root, read: ['.'], write: ['a.md'] }, web: true } });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    const job = supervisor.get(JSON.parse(r.content[0].text).jobId);
    assert.ok(job.workspace && job.web);
    assert.deepEqual(job.workspace.spec.write, ['a.md']);
    assert.match(job.events[0].data.policy, /bounded router delegation; files .*; web reads; all other tools denied/);
  } finally { await supervisor.close(); await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
