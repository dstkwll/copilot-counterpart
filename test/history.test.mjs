import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { History } from '../src/history.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { Router } from '../src/router.mjs';

const fakeRuntime = content => () => ({ close: async () => {}, open: async (m, onEvent) => ({ send: async () => {
  onEvent({ type: 'assistant.usage', data: { model: m, inputTokens: 100, outputTokens: 20 } });
  onEvent({ type: 'assistant.message', data: { content } }); onEvent({ type: 'session.idle', data: {} });
} }) });

test('finished jobs are recorded as metadata only, with stats and private file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'));
  try {
    const history = new History(join(dir, 'state', 'history.jsonl'));
    const s = new Supervisor(fakeRuntime('SECRET RESULT TEXT'), { history });
    const j = s.start({ requestId: 'r1', model: 'gpt-6.1-sol', reasoningEffort: 'high', prompt: 'PRIVATE PROMPT', route: { role: 'review', leadFamily: 'anthropic', crossFamily: true, fallback: false, policyVersion: 3 }, meta: { complexity: 'normal', risk: 'low' } });
    await s.get(j.jobId).task; await history.writing;
    const raw = await readFile(history.path, 'utf8');
    assert.doesNotMatch(raw, /SECRET RESULT|PRIVATE PROMPT/);
    assert.equal((await stat(history.path)).mode & 0o777, 0o600);
    const q = await history.query();
    assert.equal(q.jobs[0].role, 'review'); assert.equal(q.jobs[0].status, 'completed'); assert.equal(q.jobs[0].usage.inputTokens, 100);
    assert.deepEqual(q.stats[0], { role: 'review', model: 'gpt-6.1-sol', jobs: 1, completed: 1, failed: 0, timedOut: 0, cancelled: 0, feedback: { useful: 0, unhelpful: 0, inconclusive: 0 }, avgInputTokens: 100, avgOutputTokens: 20, avgSeconds: 0 });
    await s.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feedback persists, works across processes, and rejects contradictions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'));
  try {
    const path = join(dir, 'h.jsonl');
    const first = new Supervisor(fakeRuntime('ok'), { history: new History(path) });
    const router1 = new Router(first, async () => [], { history: first.history });
    const j = first.start({ requestId: 'x', model: 'claude-opus-5.5', prompt: 'p', route: { role: 'correctness' } });
    await first.get(j.jobId).task;
    await router1.feedback(j.jobId, 'useful');
    // A different process (fresh supervisor) can still record and read feedback.
    const second = new Supervisor(fakeRuntime('ok'), { history: new History(path) });
    const router2 = new Router(second, async () => [], { history: second.history });
    assert.match((await router2.feedback(j.jobId, 'useful')).note, /durable history/);
    await assert.rejects(router2.feedback(j.jobId, 'unhelpful'), /contradictory/);
    await assert.rejects(router2.feedback('00000000-0000-4000-8000-000000000000', 'useful'), /Unknown job/);
    const q = await second.history.query({ role: 'correctness' });
    assert.equal(q.jobs[0].feedback, 'useful'); assert.equal(q.stats[0].feedback.useful, 1);
    await first.close(); await second.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history can be turned off and survives a torn line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hist-'));
  const saved = process.env.COPILOT_COUNTERPART_HISTORY;
  try {
    process.env.COPILOT_COUNTERPART_HISTORY = 'off';
    const off = new History(); assert.equal(off.enabled, false); await off.recordFeedback('x', 'useful'); assert.deepEqual(await off.records(), []);
    const h = new History(join(dir, 'h.jsonl'));
    await h.append({ type: 'job', jobId: 'a', role: 'review', model: 'm', status: 'completed' });
    const { appendFile } = await import('node:fs/promises'); await appendFile(h.path, '{"type":"job","jobI');
    await h.append({ type: 'job', jobId: 'b', role: 'review', model: 'm', status: 'failed' });
    await tick();
    // The torn line is skipped; the next append starts after it on the same line, so only
    // complete JSON lines count. Job a is always intact.
    const ids = (await h.records()).map(r => r.jobId);
    assert.ok(ids.includes('a'));
    assert.ok(!ids.some(id => id === undefined));
  } finally { if (saved === undefined) delete process.env.COPILOT_COUNTERPART_HISTORY; else process.env.COPILOT_COUNTERPART_HISTORY = saved; await rm(dir, { recursive: true, force: true }); }
});
