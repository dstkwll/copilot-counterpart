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
