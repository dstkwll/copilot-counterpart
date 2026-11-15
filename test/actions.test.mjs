import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actions, loadRegistry } from '../src/actions.mjs';
import { buildGrants } from '../src/grants.mjs';

async function fixture(extra = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'actions-')));
  const tools = join(base, 'repo', 'tools'); await mkdir(tools, { recursive: true });
  const script = join(tools, 'render.sh');
  await writeFile(script, '#!/bin/sh\necho "rendered $1"\necho "warn" 1>&2\n[ "$1" = "v9" ] && exit 3\nexit 0\n'); await chmod(script, 0o755);
  const slow = join(tools, 'slow.sh'); await writeFile(slow, '#!/bin/sh\nsleep 5\n'); await chmod(slow, 0o755);
  const registry = join(base, 'config', 'actions.json'); await mkdir(join(base, 'config'));
  const actions = {
    render: { description: 'Render a résumé version', command: script, args: [{ name: 'version', pattern: '^v[0-9]+$' }], cwd: join(base, 'repo'), timeoutSeconds: 10, approved: 'test' },
    slow: { description: 'Sleeps', command: slow, cwd: base, timeoutSeconds: 1, approved: 'test' },
    ...extra
  };
  await writeFile(registry, JSON.stringify({ actions }));
  process.env.COPILOT_COUNTERPART_ACTIONS = registry;
  return { base, script, registry, cleanup: async () => { delete process.env.COPILOT_COUNTERPART_ACTIONS; await rm(base, { recursive: true, force: true }); } };
}

test('a granted action runs without a shell and returns a capped summary', async () => {
  const f = await fixture();
  try {
    const actions = await Actions.create(['render'], await loadRegistry());
    const log = []; actions.onAccess = e => log.push(e);
    const ok = await actions.run('render', ['v8']);
    assert.deepEqual([ok.exitCode, ok.stdout.trim(), ok.stderr.trim(), ok.timedOut], [0, 'rendered v8', 'warn', false]);
    assert.equal((await actions.run('render', ['v9'])).exitCode, 3);
    assert.deepEqual(log.map(e => [e.op, e.action, e.exitCode]), [['action', 'render', 0], ['action', 'render', 3]]);
  } finally { await f.cleanup(); }
});

test('names, arguments and patterns are enforced; injection has nowhere to go', async () => {
  const f = await fixture();
  try {
    const actions = await Actions.create(['render'], await loadRegistry());
    await assert.rejects(actions.run('slow', []), /not granted/);
    await assert.rejects(actions.run('render', []), /takes 1 argument/);
    for (const bad of ['v8; rm -rf ~', 'v8 && echo hi', '$(id)', '../v8', 'v8\nv9'])
      await assert.rejects(actions.run('render', [bad]), /does not match/, bad);
    await assert.rejects(Actions.create(['nope'], await loadRegistry()), /Unknown action/);
  } finally { await f.cleanup(); }
});

test('unanchored patterns, missing scripts and invalid registries are refused at job start', async () => {
  const f = await fixture({ loose: { description: 'x', command: '/bin/echo', args: [{ name: 'a', pattern: 'v[0-9]+' }], cwd: '/', approved: 't' },
    missing: { description: 'x', command: '/nonexistent/x.sh', cwd: '/', approved: 't' } });
  try {
    const registry = await loadRegistry();
    await assert.rejects(Actions.create(['loose'], registry), /must be \^…\$/);
    await assert.rejects(Actions.create(['missing'], registry), /not found/);
    await writeFile(f.registry, '{"actions": {"Bad Name": {}}}');
    await assert.rejects(buildGrants({ actions: ['render'] }), /registry is invalid/);
  } finally { await f.cleanup(); }
});

test('timeouts kill the command, and a script changed mid-job is refused', async () => {
  const f = await fixture();
  try {
    const actions = await Actions.create(['slow', 'render'], await loadRegistry());
    const slow = await actions.run('slow', []);
    assert.equal(slow.timedOut, true);
    await writeFile(f.script, (await readFile(f.script, 'utf8')) + '# changed\n');
    await assert.rejects(actions.run('render', ['v8']), /changed after this job started/);
    actions.freeze();
    await assert.rejects(actions.run('slow', []), /finished/);
  } finally { await f.cleanup(); }
});

test('write grants can never cover the registry or a registered script', async () => {
  const f = await fixture();
  try {
    await assert.rejects(buildGrants({ files: { root: f.base, write: ['repo/tools/render.sh'] } }), /registered action script/);
    await assert.rejects(buildGrants({ files: { root: f.base, write: ['config/actions.json'] } }), /action registry/);
    assert.ok((await buildGrants({ files: { root: f.base, write: ['config/notes.json'] } })).workspace);
    const ok = await buildGrants({ files: { root: f.base, read: ['repo'], write: ['repo/notes.md'] }, actions: ['render'], web: true });
    assert.deepEqual(Object.keys(ok).sort(), ['actions', 'web', 'workspace']);
  } finally { await f.cleanup(); }
});

test('patterns are restricted so they anchor the whole argument and cannot backtrack badly', async () => {
  const { checkPattern } = await import('../src/actions.mjs');
  for (const ok of ['^v[0-9]+$', '^[a-z]+\\.md$', '^\\d{4}-\\d{2}-\\d{2}$', '^[A-Za-z0-9_-]{1,40}$']) assert.ok(checkPattern(ok), ok);
  for (const bad of ['^safe|other$', '^([a-z]+)+$', '^(?:a)$', 'v1', '^v1', '^a*a*a*a*b$', '^.*$x'])
    assert.throws(() => checkPattern(bad), undefined, bad);
  const f = await fixture();
  try {
    const actions = await Actions.create(['render'], await loadRegistry());
    await assert.rejects(actions.run('render', ['v' + '1'.repeat(300)]), /does not match/);
  } finally { await f.cleanup(); }
});

test('registry protection is canonical, fails closed, and is rechecked before apply', async () => {
  const f = await fixture();
  const { Workspace } = await import('../src/workspace.mjs');
  try {
    // A relative registry path that does not exist yet is still protected.
    const cwd = process.cwd(); process.chdir(f.base);
    try {
      process.env.COPILOT_COUNTERPART_ACTIONS = 'missing-actions.json';
      await assert.rejects(buildGrants({ files: { root: f.base, write: ['missing-actions.json'] } }), /action registry/);
    } finally { process.chdir(cwd); process.env.COPILOT_COUNTERPART_ACTIONS = f.registry; }
    // A malformed registry refuses every write grant.
    const good = await readFile(f.registry, 'utf8');
    await writeFile(f.registry, '{ not json');
    await assert.rejects(buildGrants({ files: { root: f.base, write: ['repo/notes.md'] } }), /could not be read/);
    await writeFile(f.registry, good);
    // A script registered after the job started is refused at apply.
    const notes = join(f.base, 'repo', 'tools', 'later.sh');
    await writeFile(notes, '#!/bin/sh\necho later\n'); await chmod(notes, 0o755);
    const grants = await buildGrants({ files: { root: f.base, write: ['repo/tools/later.sh'] } });
    await grants.workspace.write('repo/tools/later.sh', '#!/bin/sh\necho changed\n');
    grants.workspace.freeze();
    const { changeSetHash } = await grants.workspace.changes();
    const reg = JSON.parse(good); reg.actions.later = { description: 'Later', command: notes, cwd: f.base, approved: 'test' };
    await writeFile(f.registry, JSON.stringify(reg));
    await assert.rejects(grants.workspace.apply(changeSetHash), /registered action script.*Nothing was applied/);
    assert.equal(await readFile(notes, 'utf8'), '#!/bin/sh\necho later\n');
  } finally { await f.cleanup(); }
});

test('a dangling registry symlink protects the file it would create', async () => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture();
  try {
    const link = join(f.base, 'config', 'linked.json');
    await symlink(join(f.base, 'repo', 'future.json'), link);
    process.env.COPILOT_COUNTERPART_ACTIONS = link;
    await assert.rejects(buildGrants({ files: { root: f.base, write: ['repo/future.json'] } }), /action registry/);
  } finally { await f.cleanup(); }
});
