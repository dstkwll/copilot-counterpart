import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/copilot.mjs';

test('adapter disables discovery, tools and permissions, verifies runtime tool set', async () => {
  let clientOptions, sessionOptions, stopped = false;
  const runtime = new CopilotRuntime(options => {
    clientOptions = options;
    return { start: async () => {}, forceStop: async () => { stopped = true; },
      listModels: async () => [{ id: 'test', supportedReasoningEfforts: ['high'] }],
      createSession: async options => {
        sessionOptions = options;
        return { on: () => () => {}, rpc: { tools: {
          initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [] })
        } } };
      } };
  });
  try {
    await runtime.open('test', () => {}, { reasoningEffort: 'high' });
    assert.equal(sessionOptions.reasoningEffort, 'high');
    assert.equal(clientOptions.mode, 'empty');
    assert.equal(sessionOptions.enableConfigDiscovery, false);
    assert.equal(sessionOptions.skipCustomInstructions, true);
    assert.deepEqual(sessionOptions.availableTools, []);
    assert.deepEqual(sessionOptions.excludedTools, ['builtin:*', 'mcp:*', 'custom:*']);
    assert.match((await sessionOptions.onPermissionRequest({ kind: 'shell' })).kind, /^denied/);
    assert.equal((await sessionOptions.hooks.onPreToolUse({ toolName: 'bash' })).permissionDecision, 'deny');
  } finally { await runtime.close(); }
  assert.equal(stopped, true);
});

test('adapter fails closed if runtime exposes a tool', async () => {
  const runtime = new CopilotRuntime(() => ({ start: async () => {}, forceStop: async () => {},
    listModels: async () => [{ id: 'test' }],
    createSession: async () => ({ rpc: { tools: {
      initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [{ name: 'bash' }] })
    } } }) }));
  try { await assert.rejects(runtime.open('test', () => {}), /Safety check/); }
  finally { await runtime.close(); }
});

test('close is single-flight and cleanup runs even if forceStop rejects', async () => {
  const runtime = new CopilotRuntime();
  let stops = 0, cleanups = 0;
  runtime.client = { forceStop: async () => { stops++; throw new Error('stop failed'); } };
  runtime.cleanup = async () => { cleanups++; };
  const results = await Promise.allSettled([runtime.close(), runtime.close()]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(stops, 1); assert.equal(cleanups, 1);
});

test('delegation adapter exposes only the explicit custom tool and denies other tools', async () => {
 let config;
 const tool={name:'delegate_task',handler:async()=> 'ok'};
 const runtime=new CopilotRuntime(()=>({start:async()=>{},forceStop:async()=>{},
  listModels:async()=>[{id:'test',supportedReasoningEfforts:['high']}],
  createSession:async c=>{config=c;return {on:()=>()=>{},rpc:{tools:{initializeAndValidate:async()=>{},getCurrentMetadata:async()=>({tools:[{name:'delegate_task'}]})}}};}
 }),tool);
 try {
  await runtime.open('test',()=>{},{reasoningEffort:'high'});
  assert.deepEqual(config.availableTools,['custom:delegate_task']);
  assert.deepEqual(config.excludedTools,['builtin:*','mcp:*']);
  assert.equal((await config.hooks.onPreToolUse({toolName:'delegate_task'})).permissionDecision,'allow');
  assert.equal((await config.hooks.onPreToolUse({toolName:'task'})).permissionDecision,'deny');
  assert.equal((await config.hooks.onPreToolUse({toolName:'bash'})).permissionDecision,'deny');
 } finally {await runtime.close();}
});

test('cancel joins late startup and stops again before freeing the runtime',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r);let stops=0,created=0;
 const runtime=new CopilotRuntime(()=>({start:async()=>{entered();await new Promise(r=>release=r);},forceStop:async()=>{stops++;},createSession:async()=>{created++;}}));
 const opening=runtime.open('test',()=>{});opening.catch(()=>{});
 await ready;const closing=runtime.close();release();
 await assert.rejects(opening,/Cancelled/);await closing;
 assert.equal(created,0);assert.equal(stops,2);
});

test('failed initial stop still joins startup and attempts final stop',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r);let stops=0,cleanups=0;
 const runtime=new CopilotRuntime(()=>({start:async()=>{entered();await new Promise(r=>release=r);},forceStop:async()=>{if(++stops===1)throw Error('first stop failed');}}));
 runtime.cleanup=async()=>{cleanups++;};
 const opening=runtime.open('test',()=>{});opening.catch(()=>{});await ready;
 const closing=runtime.close();release();await assert.rejects(closing,/first stop failed/);
 assert.equal(stops,2);assert.equal(cleanups,1);
});

test('adapter validates model existence and policy even without a reasoning effort', async () => {
  let created = false;
  const fake = catalog => () => ({ start: async () => {}, forceStop: async () => {}, listModels: async () => catalog,
    createSession: async () => { created = true; throw Error('should not create'); } });
  for (const [catalog, pattern] of [[[], /unavailable/], [[{ id: 'test', policy: { state: 'disabled' } }], /disabled/]]) {
    const runtime = new CopilotRuntime(fake(catalog));
    try { await assert.rejects(runtime.open('test', () => {}), pattern); } finally { await runtime.close(); }
  }
  const runtime = new CopilotRuntime(fake([{ id: 'test', supportedReasoningEfforts: ['low'] }]));
  try { await assert.rejects(runtime.open('test', () => {}, { reasoningEffort: 'high' }), /effort unsupported/); } finally { await runtime.close(); }
  assert.equal(created, false);
});

test('workspace tools are exposed by exact name and anything else stays denied', async () => {
  let config;
  const tools = ['workspace_read', 'workspace_edit'].map(name => ({ name, handler: async () => '{}' }));
  const workspace = { describe: () => 'Workspace root: /r' };
  const runtime = new CopilotRuntime(() => ({ start: async () => {}, forceStop: async () => {},
    listModels: async () => [{ id: 'test' }],
    createSession: async c => { config = c; return { on: () => () => {}, rpc: { tools: { initializeAndValidate: async () => {},
      getCurrentMetadata: async () => ({ tools: tools.map(t => ({ name: t.name })) }) } } }; } }), tools, { workspace });
  try {
    await runtime.open('test', () => {});
    assert.deepEqual(config.availableTools, ['custom:workspace_read', 'custom:workspace_edit']);
    assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*']);
    for (const [name, decision] of [['workspace_read', 'allow'], ['workspace_edit', 'allow'], ['workspace_write', 'deny'], ['view', 'deny'], ['bash', 'deny']])
      assert.equal((await config.hooks.onPreToolUse({ toolName: name })).permissionDecision, decision, name);
    assert.match(config.systemMessage.content, /Staged edits are reviewed|workspace_\* tools/);
    assert.match(config.systemMessage.content, /Workspace root: \/r/);
  } finally { await runtime.close(); }
});
