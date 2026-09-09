import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.argv.includes('--live')) {
  console.error('Explicit opt-in required: node scripts/review-routing.mjs --live. Sends this repository\'s routing source to Copilot.');
  process.exit(2);
}
const synthetic = process.argv.includes('--synthetic');
const files = ['src/router.mjs', 'src/supervisor.mjs', 'src/server.mjs', 'src/copilot.mjs'];
const context = synthetic ? 'Synthetic JavaScript sample: function average(xs) { return xs.reduce((a,b) => a+b, 0) / xs.length; }'
  : (await Promise.all(files.map(async name => `${name}\n${await readFile(new URL(`../${name}`, import.meta.url), 'utf8')}`))).join('\n\n');
const client = new Client({ name: 'routing-review', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'inherit' });
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  if (response.isError) throw new Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
};
let jobId;
try {
  await client.connect(transport);
  const started = await call('copilot_delegate', { requestId: 'routing-review', role: 'correctness',
    complexity: 'complex', risk: 'high', sharingAuthorized: true, timeoutSeconds: 180,
    task: synthetic ? 'Review this synthetic function for one edge-case defect. Respond in under 100 words.' : 'Review this local MCP routing implementation for concrete correctness/security defects. Focus on idempotency, concurrency, lifecycle cleanup, fail-closed tool permissions and escalation boundaries. Report up to four actionable findings; if none, say so. Do not ask for features outside the intended context-only scope.',
    acceptanceCriteria: synthetic ? 'Identify the behavior for empty input; do not use tools.' : 'One inference job per identical routed request; maximum one supervised escalation; no delegate file/shell tools; explicit supported reasoning; no runaway retry loops. Offline tests passed.', context });
  jobId = started.jobId;
  console.log(JSON.stringify({ jobId, model: started.model, reasoningEffort: started.reasoningEffort, route: started.route }));
  let after = 0;
  for (;;) {
    const progress = await call('copilot_events', { jobId, after, waitMs: 10000 });
    after = progress.nextCursor;
    console.log(JSON.stringify({ status: progress.status, events: progress.events.length, cursor: after }));
    if (!['starting', 'running'].includes(progress.status) && !progress.hasMore) {
      console.log(JSON.stringify({ result: progress.result, error: progress.error, usage: progress.usage }));
      if (progress.status !== 'completed') process.exitCode = 1;
      break;
    }
  }
} finally {
  if (jobId) await call('copilot_cancel', { jobId }).catch(() => {});
  await client.close();
}
