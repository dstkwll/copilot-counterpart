import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { Supervisor } from '../src/supervisor.mjs';

test('MCP tools negotiate, validate and dispatch without GitHub requests', async () => {
  const supervisor = new Supervisor(() => ({ open: async () => ({ send: async () => {} }), close: async () => {} }));
  const { server } = createServer(supervisor, async () => [{ id: 'test-model' }]);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.equal((await client.listTools()).tools.length, 9);
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
