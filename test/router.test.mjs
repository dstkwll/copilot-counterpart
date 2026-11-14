import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Router, chooseRoute } from '../src/router.mjs';
import { Supervisor } from '../src/supervisor.mjs';

const catalog = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'claude-sonnet-5.5', 'claude-opus-5.5']
  .map(id => ({ id, policy: { state: 'enabled' }, supportedReasoningEfforts: ['medium', 'high'] }));
const input = { requestId: 'r1', role: 'review', complexity: 'normal', risk: 'low',
  task: 'Review sample', context: 'function example() {}', acceptanceCriteria: 'Find real defects', sharingAuthorized: true };

function fixture(models = async () => catalog) {
  const calls = [];
  const s = new Supervisor(() => ({
    open: async (model, emit, options) => { calls.push({ model, emit, options }); return { send: async () => {} }; }, close: async () => {}
  }));
  return { s, r: new Router(s, models), calls };
}

test('lead-neutral routing: role/complexity/risk map to intended models and efforts', () => {
  const route = overrides => chooseRoute({ ...input, ...overrides }, catalog);
  assert.equal(route({}).model, 'gpt-6.1-sol');
  assert.equal(route({}).crossFamily, undefined);
  assert.equal(route({ role: 'correctness' }).model, 'gpt-6.1-sol');
  assert.equal(route({ risk: 'high' }).model, 'claude-opus-5.5');
  assert.equal(route({ role: 'sparring' }).model, 'claude-opus-5.5');
  assert.equal(route({ role: 'code_proposal', complexity: 'small' }).model, 'gpt-6-luna');
  assert.equal(route({ role: 'analysis' }).model, 'gpt-6.1-sol');
  assert.equal(route({ role: 'analysis' }).reasoningEffort, 'medium');
  assert.equal(route({ role: 'code_proposal', complexity: 'complex' }).reasoningEffort, 'high');
});

test('anthropic lead routes independent roles to OpenAI, sparring to Astra high', () => {
  const route = overrides => chooseRoute({ ...input, ...overrides }, catalog, { leadFamily: 'anthropic' });
  for (const role of ['review', 'correctness']) {
    assert.equal(route({ role }).model, 'gpt-6.1-sol');
    assert.equal(route({ role }).crossFamily, true);
  }
  assert.deepEqual([route({ role: 'sparring' }).model, route({ role: 'sparring' }).reasoningEffort], ['gpt-6-astra', 'high']);
  assert.equal(route({ risk: 'high' }).model, 'gpt-6-astra');
  assert.equal(route({ role: 'analysis' }).model, 'gpt-6.1-sol');
  assert.equal(route({ role: 'analysis' }).leadFamily, 'anthropic');
});

test('openai lead routes independent roles to Opus 5.5 high', () => {
  const route = overrides => chooseRoute({ ...input, ...overrides }, catalog, { leadFamily: 'openai' });
  for (const role of ['review', 'correctness', 'sparring']) {
    assert.deepEqual([route({ role }).model, route({ role }).reasoningEffort, route({ role }).crossFamily], ['claude-opus-5.5', 'high', true]);
  }
  assert.equal(route({ role: 'code_proposal', complexity: 'small' }).model, 'gpt-6-luna');
});

test('per-call leadFamily overrides the server default; same-family fallback is reported', () => {
  assert.equal(chooseRoute({ ...input, leadFamily: 'openai' }, catalog, { leadFamily: 'anthropic' }).model, 'claude-opus-5.5');
  const noOpus = catalog.filter(m => m.id !== 'claude-opus-5.5');
  const r = chooseRoute(input, noOpus, { leadFamily: 'openai' });
  assert.deepEqual([r.model, r.fallback, r.crossFamily], ['gpt-6.1-sol', true, false]);
  const noAstra = catalog.filter(m => m.id !== 'gpt-6-astra');
  assert.equal(chooseRoute({ ...input, role: 'sparring' }, noAstra, { leadFamily: 'anthropic' }).model, 'gpt-6.1-sol');
});

test('leadFamily is validated', async () => {
  const { s, r } = fixture(async () => { throw new Error('Should not query models'); });
  try { await assert.rejects(r.delegate({ ...input, leadFamily: 'google' }), /leadFamily/); }
  finally { await s.close(); }
});

test('availability/policy/effort checked with safe fallback, no arbitrary downgrade', () => {
  const denied = catalog.map(m => m.id === 'gpt-6.1-sol' ? { ...m, policy: { state: 'disabled' } } : m);
  assert.equal(chooseRoute(input, denied).model, 'gpt-6-sol');
  assert.equal(chooseRoute(input, denied).fallback, true);
  assert.throws(() => chooseRoute(input, [{ id: 'gpt-6.1-sol', supportedReasoningEfforts: ['low'] }]), /No allowed model/);
});

test('concurrent duplicate dispatches create one job and preserve effort', async () => {
  const { s, r, calls } = fixture();
  try {
    const [a, b] = await Promise.all([r.delegate(input), r.delegate(input)]);
    assert.equal(a.jobId, b.jobId); await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.reasoningEffort, 'high');
    await assert.rejects(r.delegate({ ...input, context: 'different' }), /different routing inputs/);
  } finally { await s.close(); }
});

test('authorization/unknown arguments fail before catalog access', async () => {
  const { s, r } = fixture(async () => { throw new Error('Should not query models'); });
  try {
    await assert.rejects(r.delegate({ ...input, sharingAuthorized: false }), /sharingAuthorized/);
    await assert.rejects(r.delegate({ ...input, allowWrites: true }), /allowWrites/);
  } finally { await s.close(); }
});

test('feedback is recorded once and does not change routing', async () => {
  const { s, r, calls } = fixture();
  try {
    const a = await r.delegate(input); await tick();
    calls[0].emit({ type: 'session.idle', data: {} }); await tick();
    assert.equal(r.feedback(a.jobId, 'unhelpful').outcome, 'unhelpful');
    assert.throws(() => r.feedback(a.jobId, 'useful'), /contradictory/);
    const b = await r.delegate({ ...input, requestId: 'r2' });
    assert.equal(b.model, 'gpt-6.1-sol');
  } finally { await s.close(); }
});

test('one escalation only; no duplicates, no recursion, no cancelled escalation', async () => {
  const { s, r, calls } = fixture();
  try {
    const a = await r.delegate(input); await tick();
    await assert.rejects(r.delegate({ ...input, requestId: 'early', parentJobId: a.jobId }), /completed or failed/);
    calls[0].emit({ type: 'session.idle', data: {} }); await tick();
    const b = await r.delegate({ ...input, requestId: 'escalation', parentJobId: a.jobId }); await tick();
    assert.equal(b.model, 'claude-opus-5.5');
    await assert.rejects(r.delegate({ ...input, requestId: 'duplicate', parentJobId: a.jobId }), /already has/);
    calls[1].emit({ type: 'session.idle', data: {} }); await tick();
    await assert.rejects(r.delegate({ ...input, requestId: 'recursive', parentJobId: b.jobId }), /Only one escalation/);
    const c = await r.delegate({ ...input, requestId: 'cancelled' }); await s.cancel(c.jobId);
    await assert.rejects(r.delegate({ ...input, requestId: 'retry-cancelled', parentJobId: c.jobId }), /completed or failed/);
  } finally { await s.close(); }
});

test('catalog failure starts no inference and can be retried explicitly', async () => {
  let fail = true;
  const { s, r, calls } = fixture(async () => { if (fail) throw new Error('Auth unavailable'); return catalog; });
  try {
    await assert.rejects(r.delegate(input), /Auth unavailable/);
    assert.equal(calls.length, 0); fail = false;
    await r.delegate(input); await tick(); assert.equal(calls.length, 1);
  } finally { await s.close(); }
});


test('policy v3 preserves tier fallbacks, rejects legacy-only catalogs and enforces lead-aware ceilings', () => {
  const route = (overrides, models = catalog, state = {}) => chooseRoute({ ...input, ...overrides }, models, state);
  assert.equal(route({ role: 'analysis' }).policyVersion, 3);
  const withoutLuna = catalog.filter(m => m.id !== 'gpt-6-luna');
  assert.equal(route({ role: 'analysis', complexity: 'small' }, withoutLuna).model, 'gpt-6.1-sol');
  assert.equal(route({ role: 'analysis', complexity: 'small' }, withoutLuna).fallback, true);
  assert.equal(route({ role: 'analysis' }, catalog.filter(m => m.id !== 'gpt-6.1-sol')).model, 'gpt-6-sol');
  const onlyOpus = catalog.filter(m => !m.id.includes('sol'));
  assert.equal(route({ role: 'correctness' }, onlyOpus).model, 'claude-opus-5.5');
  assert.equal(route({ role: 'sparring' }, catalog.filter(m => m.id !== 'claude-opus-5.5')).model, 'gpt-6.1-sol');
  const legacy = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'claude-opus-5', 'claude-sonnet-5']
    .map(id => ({ id, supportedReasoningEfforts: ['medium', 'high'] }));
  for (const role of ['analysis', 'correctness', 'sparring', 'review']) {
    assert.throws(() => route({ role }, legacy), /No allowed model/);
  }
  const parent = { id: 'parent', status: 'completed', route: { depth: 0 }, model: 'gpt-6.1-sol' };
  assert.equal(route({}, catalog, { parent }).model, 'claude-opus-5.5');
  assert.equal(route({}, catalog, { parent, leadFamily: 'anthropic' }).model, 'gpt-6-astra');
  assert.equal(route({}, catalog, { parent: { ...parent, model: 'gpt-6-luna' } }).model, 'gpt-6.1-sol');
  for (const model of ['claude-opus-5.5', 'gpt-6-astra'])
    assert.throws(() => route({}, catalog, { parent: { ...parent, model } }), /ceiling/);
});
