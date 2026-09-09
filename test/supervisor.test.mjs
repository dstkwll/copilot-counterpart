import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Supervisor } from '../src/supervisor.mjs';

function fixture(options = {}) {
  const runtimes = [];
  const supervisor = new Supervisor(() => {
    const runtime = { sends: [], closed: false,
      async open(model, listener) { this.emit = listener; return { sessionId: 'fixture', send: async m => this.sends.push(m) }; },
      async close() { this.closed = true; } };
    runtimes.push(runtime);
    return runtime;
  }, options);
  const start = (extra = {}) => supervisor.start({ requestId: 'one', model: 'fixture-model', prompt: 'Review sample', ...extra });
  return { supervisor, runtimes, start };
}

test('streams before completion, preserves result, cleans runtime', async () => {
  const { supervisor: s, start, runtimes } = fixture();
  const j = start();
  await tick();
  runtimes[0].emit({ type: 'assistant.message_delta', data: { deltaContent: 'Hello' } });
  runtimes[0].emit({ type: 'assistant.message', data: { content: 'Interim', encrypted_content: 'private-provider-metadata', token: 'secret' } });
  const progress = await s.events(j.jobId);
  assert.equal(progress.status, 'running');
  assert.ok(progress.events.some(e => e.type === 'assistant.message_delta'));
  assert.equal(JSON.stringify(progress).includes('private-provider-metadata'), false);
  assert.equal(JSON.stringify(progress).includes('secret'), false);
  runtimes[0].emit({ type: 'assistant.message', data: { content: 'Finding' } });
  runtimes[0].emit({ type: 'session.idle', data: {} });
  await tick();
  assert.equal(s.list()[0].result, 'Finding');
  assert.equal(s.list()[0].status, 'completed');
  assert.equal(runtimes[0].closed, true);
  await s.close();
});

test('steering uses immediate mode and cancel is idempotent', async () => {
  const { supervisor: s, start, runtimes } = fixture();
  const j = start(); await tick();
  await s.steer(j.jobId, 'Focus on safety');
  assert.deepEqual(runtimes[0].sends[1], { prompt: 'Focus on safety', mode: 'immediate' });
  await s.cancel(j.jobId); await s.cancel(j.jobId);
  runtimes[0].emit({ type: 'session.idle', data: {} });
  assert.equal(s.list()[0].status, 'cancelled');
  await assert.rejects(s.steer(j.jobId, 'Again'), /running/);
  await s.close();
});

test('duplicate start dedupes and mismatched retry rejects', async () => {
  const { supervisor: s, start, runtimes } = fixture();
  assert.equal(start().jobId, start().jobId);
  assert.equal(runtimes.length, 1);
  assert.throws(() => start({ prompt: 'Different' }), /different/);
  await s.close();
});

test('enforces active limit and forget frees bounded history', async () => {
  const { supervisor: s, start } = fixture({ maxActive: 1, maxJobs: 1 });
  const j = start();
  assert.throws(() => start({ requestId: 'two' }), /Active/);
  await assert.rejects(s.forget(j.jobId), /Cancel/);
  await s.cancel(j.jobId);
  assert.throws(() => start({ requestId: 'two' }), /history/);
  await s.forget(j.jobId);
  start({ requestId: 'two' });
  await s.close();
});

test('event pagination reports dropped history and wakes long polls', async () => {
  const { supervisor: s, start, runtimes } = fixture({ maxEvents: 3 });
  const j = start(); await tick();
  const after = s.list()[0].cursor;
  const waiting = s.events(j.jobId, { after, waitMs: 1000 });
  runtimes[0].emit({ type: 'assistant.message_delta', data: { deltaContent: 'wake' } });
  assert.equal((await waiting).events.length, 1);
  for (let i = 0; i < 5; i++) runtimes[0].emit({ type: 'assistant.message_delta', data: { deltaContent: String(i) } });
  const first = await s.events(j.jobId, { limit: 1 });
  assert.equal(first.gap, true);
  assert.equal(first.hasMore, true);
  const rest = await s.events(j.jobId, { after: first.nextCursor });
  assert.equal(rest.events.length, 2);
  assert.equal(rest.hasMore, false);
  await assert.rejects(s.events(j.jobId, { after: 999 }), /Invalid/);
  await s.close();
});

test('cancel while opening prevents any prompt being sent', async () => {
  let finishOpen, sent = false, closed = false;
  const s = new Supervisor(() => ({
    open: () => new Promise(resolve => { finishOpen = () => resolve({ send: async () => { sent = true; } }); }),
    close: async () => { closed = true; }
  }));
  const j = s.start({ requestId: 'r', model: 'm', prompt: 'p' });
  await s.cancel(j.jobId);
  finishOpen(); await tick();
  assert.equal(sent, false); assert.equal(closed, true);
  await s.close();
});

test('startup errors become failed jobs', async () => {
  const s = new Supervisor(() => ({ open: async () => { throw new Error('No auth'); }, close: async () => {} }));
  const j = s.start({ requestId: 'r', model: 'm', prompt: 'p' });
  await tick();
  assert.equal(s.get(j.jobId).status, 'failed');
  assert.equal(s.get(j.jobId).error, 'No auth');
  await s.close();
});

test('deadline terminates job', async () => {
  const { supervisor: s, start, runtimes } = fixture();
  const j = start({ timeoutSeconds: 1 });
  await s.events(j.jobId, { after: j.cursor, waitMs: 2000 });
  await s.events(j.jobId, { after: s.list()[0].cursor, waitMs: 2000 });
  assert.equal(s.get(j.jobId).status, 'timed_out');
  assert.equal(runtimes[0].closed, true);
  await s.close();
});
