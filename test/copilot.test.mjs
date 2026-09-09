import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotRuntime } from '../src/copilot.mjs';

test('adapter disables discovery, tools and permissions, verifies runtime tool set', async () => {
  let clientOptions, sessionOptions, stopped = false;
  const runtime = new CopilotRuntime(options => {
    clientOptions = options;
    return { start: async () => {}, forceStop: async () => { stopped = true; },
      createSession: async options => {
        sessionOptions = options;
        return { on: () => () => {}, rpc: { tools: {
          initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [] })
        } } };
      } };
  });
  try {
    await runtime.open('test', () => {});
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
