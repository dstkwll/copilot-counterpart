import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio process starts and exposes tools without inference', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 9);
    const jobs = await client.callTool({ name: 'copilot_jobs', arguments: {} });
    assert.deepEqual(JSON.parse(jobs.content[0].text), []);
  } finally { await client.close(); }
});
