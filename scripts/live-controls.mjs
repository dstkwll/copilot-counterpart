import { Supervisor } from '../src/supervisor.mjs';
import { CopilotRuntime } from '../src/copilot.mjs';

if (!process.argv.includes('--live')) {
  console.error('Uses Copilot allowance with synthetic context. Run node scripts/live-controls.mjs --live');
  process.exit(2);
}
const s = new Supervisor(() => new CopilotRuntime());
try {
  const job = s.start({ requestId: 'live-controls', model: 'gpt-6-luna', timeoutSeconds: 45,
    prompt: 'For a streaming transport test, output integers from 1 through 1000, one per line. No tools.' });
  let after = 0, steered = false, observed = false;
  for (;;) {
    const update = await s.events(job.jobId, { after, waitMs: 10000 });
    after = update.nextCursor;
    if (update.status === 'running' && !steered) {
      await s.steer(job.jobId, 'Use a comma between numbers instead.');
      steered = true;
      console.log('PASS: live SDK accepted immediate steering. This checks delivery, not model compliance.');
    }
    if (update.events.some(e => e.type === 'assistant.message_delta')) {
      observed = true;
      const stopped = await s.cancel(job.jobId);
      if (stopped.status !== 'cancelled') throw new Error(`Cancellation raced completion: ${stopped.status}`);
      console.log('PASS: observed streaming output and cancelled the active dedicated runtime.');
      break;
    }
    if (!['starting', 'running'].includes(update.status)) throw new Error(`Unexpected terminal state: ${update.status}: ${update.error}`);
  }
  if (!steered || !observed) throw new Error('Missing expected control evidence.');
} finally { await s.close(); }
