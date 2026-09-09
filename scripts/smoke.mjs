import { Supervisor } from '../src/supervisor.mjs';
import { CopilotRuntime, listModels } from '../src/copilot.mjs';

// Explicit opt-in: one small inference request, using only synthetic sample code.
if (!process.argv.includes('--live')) {
  console.error('Live smoke test uses Copilot allowance. Run npm run smoke -- --live [model-id].');
  process.exit(2);
}
const models = await listModels();
const requested = process.argv[process.argv.indexOf('--live') + 1];
const model = requested ?? models.find(m => m.id.includes('mini'))?.id ?? models[0]?.id;
if (!models.some(m => m.id === model)) throw new Error('Requested model is unavailable.');
console.log(JSON.stringify({ model }));
const s = new Supervisor(() => new CopilotRuntime());
try {
  const job = s.start({ requestId: 'synthetic-smoke', model, timeoutSeconds: 90,
    prompt: 'Review this synthetic JavaScript function for one bug. Do not use tools. Give a short progress note, then the finding: function average(xs) { return xs.reduce((a,b) => a+b, 0) / xs.length; }' });
  let after = 0;
  for (;;) {
    const update = await s.events(job.jobId, { after, waitMs: 10000 });
    for (const event of update.events) {
      if (event.type === 'assistant.message_delta') process.stdout.write('.');
      else console.log(JSON.stringify(event));
    }
    after = update.nextCursor;
    if (!['starting', 'running'].includes(update.status) && !update.hasMore) {
      if (update.status !== 'completed' || !update.result) throw new Error(`Smoke failed: ${update.status}: ${update.error ?? 'no result'}`);
      if (s.get(job.jobId).events.some(e => e.type === 'tool.execution_start')) throw new Error('Unexpected tool execution');
      console.log('PASS: live output received, completed result, no tool execution.');
      break;
    }
  }
} finally { await s.close(); }
