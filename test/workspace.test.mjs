import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Workspace, isDenied } from '../src/workspace.mjs';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ws-test-')));
  const root = join(base, 'repo'), outside = join(base, 'outside');
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, 'docs')); await mkdir(outside);
  await writeFile(join(root, 'src', 'a.js'), 'const a = 1;\nexport default a;\n');
  await writeFile(join(root, 'src', 'b.js'), 'const b = 2;\n');
  await writeFile(join(root, 'src', '.env'), 'TOKEN=secret\n');
  await writeFile(join(root, 'src', '.env.example'), 'TOKEN=\n');
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(outside, 'private.txt'), 'private\n');
  await symlink(join(outside, 'private.txt'), join(root, 'src', 'escape.txt'));
  await symlink(outside, join(root, 'src', 'linkdir'));
  return { base, root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('sensitive names are blocked; template variants are allowed', () => {
  for (const p of ['.env', 'a/.env.local', '.git/config', 'k/server.pem', '.ssh/id_ed25519', 'secrets.json', '.npmrc', 'credentials'])
    assert.equal(isDenied(p), true, p);
  for (const p of ['src/a.js', '.env.example', 'docs/environment.md', 'keyboard.js'])
    assert.equal(isDenied(p), false, p);
});

test('grant creation rejects bad roots, missing or sensitive paths and escapes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(Workspace.create({ root: 'repo', read: ['src'] }), /absolute/);
    await assert.rejects(Workspace.create({ root: f.root }), /at least one/);
    await assert.rejects(Workspace.create({ root: f.root, read: ['missing'] }), /not found/);
    await assert.rejects(Workspace.create({ root: f.root, read: ['src/.env'] }), /sensitive/);
    await assert.rejects(Workspace.create({ root: f.root, read: ['../outside'] }), /outside/);
    await assert.rejects(Workspace.create({ root: f.root, read: ['src/escape.txt'] }), /outside/);
    await assert.rejects(Workspace.create({ root: f.root, write: ['src/linkdir/new.txt'] }), /outside/);
    await assert.rejects(Workspace.create({ root: f.root, write: ['src'] }), /regular file/);
    await assert.rejects(Workspace.create({ root: f.root, read: ['src'], extra: 1 }));
  } finally { await f.cleanup(); }
});

test('reads stay inside grants: traversal, symlinks, sensitive and ungranted files are refused', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'] });
    const accesses = []; ws.onAccess = a => accesses.push(a);
    assert.equal((await ws.read('src/a.js')).content, 'const a = 1;\nexport default a;\n');
    assert.equal((await ws.read('src/a.js', { startLine: 2, maxLines: 1 })).content, 'export default a;');
    assert.equal((await ws.read(join(f.root, 'src/b.js'))).path, 'src/b.js');
    await assert.rejects(ws.read('docs/guide.md'), /Not granted/);
    await assert.rejects(ws.read('src/../../outside/private.txt'), /outside/);
    await assert.rejects(ws.read('src/escape.txt'), /outside/);
    await assert.rejects(ws.read('src/linkdir/private.txt'), /outside/);
    await assert.rejects(ws.read('src/.env'), /sensitive/);
    assert.equal((await ws.read('src/.env.example')).content, 'TOKEN=\n');
    assert.deepEqual(accesses.map(a => [a.op, a.path]), [['read', 'src/a.js'], ['read', 'src/a.js'], ['read', 'src/b.js'], ['read', 'src/.env.example']]);
  } finally { await f.cleanup(); }
});

test('list and search show only granted, non-sensitive, non-link entries', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['docs/new.md'] });
    const listed = (await ws.list('.', { recursive: true })).entries.map(e => e.path).sort();
    assert.deepEqual(listed, ['docs', 'src', 'src/.env.example', 'src/a.js', 'src/b.js']);
    const found = (await ws.search('TOKEN')).matches.map(m => m.path);
    assert.deepEqual(found, ['src/.env.example']);
    assert.equal((await ws.search('CONST', { ignoreCase: true })).matches.length, 2);
    await assert.rejects(ws.search('x', { path: '../outside' }), /outside/);
  } finally { await f.cleanup(); }
});

test('writes are staged, readable back, limited to exact grants and never touch disk', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['src/a.js', 'docs/new.md'] });
    await assert.rejects(ws.write('src/b.js', 'x'), /Not granted for writing/);
    await assert.rejects(ws.write('src/linkdir/a.js', 'x'), /Not granted for writing/);
    await ws.edit('src/a.js', 'const a = 1;', 'const a = 42;');
    await assert.rejects(ws.edit('src/a.js', 'nope', 'x'), /not found/);
    await ws.write('docs/new.md', '# New\n');
    assert.equal((await ws.read('src/a.js')).content, 'const a = 42;\nexport default a;\n');
    assert.equal((await ws.read('docs/new.md')).content, '# New\n');
    assert.equal(await readFile(join(f.root, 'src/a.js'), 'utf8'), 'const a = 1;\nexport default a;\n');
    await assert.rejects(readFile(join(f.root, 'docs/new.md')));
    const { files } = await ws.changes();
    assert.deepEqual(files.map(c => [c.path, c.status]), [['docs/new.md', 'created'], ['src/a.js', 'modified']]);
    assert.match(files[1].diff, /-const a = 1;\n\+const a = 42;/);
  } finally { await f.cleanup(); }
});

test('concurrent edits to one file are serialized, not lost', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['src/b.js'] });
    await Promise.all([ws.edit('src/b.js', 'const', 'let'), ws.edit('src/b.js', '2', '3')]);
    assert.equal((await ws.read('src/b.js')).content, 'let b = 3;\n');
  } finally { await f.cleanup(); }
});

test('apply needs a finished job and the reviewed hash, and is all-or-nothing', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['src/a.js', 'src/b.js', 'docs/new.md'] });
    await ws.edit('src/a.js', '1', '7'); await ws.edit('src/b.js', '2', '8'); await ws.write('docs/new.md', 'hi\n');
    const { changeSetHash } = await ws.changes();
    await assert.rejects(ws.apply(changeSetHash), /finished/);
    ws.freeze();
    await assert.rejects(ws.write('src/a.js', 'late'), /frozen/);
    await assert.rejects(ws.apply('0'.repeat(64)), /does not match/);
    await writeFile(join(f.root, 'src/b.js'), 'changed meanwhile\n');
    await assert.rejects(ws.apply(changeSetHash), /changed on disk.*Nothing was applied/);
    assert.equal(await readFile(join(f.root, 'src/a.js'), 'utf8'), 'const a = 1;\nexport default a;\n');
    await writeFile(join(f.root, 'src/b.js'), 'const b = 2;\n');
    assert.deepEqual((await ws.apply(changeSetHash)).applied, ['docs/new.md', 'src/a.js', 'src/b.js']);
    assert.equal(await readFile(join(f.root, 'src/a.js'), 'utf8'), 'const a = 7;\nexport default a;\n');
    assert.equal(await readFile(join(f.root, 'docs/new.md'), 'utf8'), 'hi\n');
    await assert.rejects(ws.apply(changeSetHash), /already in progress or done/);
  } finally { await f.cleanup(); }
});

test('a created file is refused at apply if something appeared at that path', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['docs/new.md'] });
    await ws.write('docs/new.md', 'mine\n'); ws.freeze();
    const { changeSetHash } = await ws.changes();
    await writeFile(join(f.root, 'docs/new.md'), 'theirs\n');
    await assert.rejects(ws.apply(changeSetHash), /changed on disk/);
    assert.equal(await readFile(join(f.root, 'docs/new.md'), 'utf8'), 'theirs\n');
  } finally { await f.cleanup(); }
});

test('tool set: read-only grants get no write tools; tool errors return as data', async () => {
  const f = await fixture();
  try {
    const ro = await Workspace.create({ root: f.root, read: ['src'] });
    assert.deepEqual(ro.tools().map(t => t.name), ['workspace_read', 'workspace_list', 'workspace_search']);
    const rw = await Workspace.create({ root: f.root, read: ['src'], write: ['src/a.js'] });
    const tools = Object.fromEntries(rw.tools().map(t => [t.name, t]));
    assert.deepEqual(Object.keys(tools), ['workspace_read', 'workspace_list', 'workspace_search', 'workspace_write', 'workspace_edit']);
    assert.ok(Object.values(tools).every(t => t.skipPermission && t.defer === 'never'));
    const log = []; rw.onAccess = e => log.push(e);
    assert.match(await tools.workspace_read.handler({ path: 'src/.env' }), /"error":"Path is blocked/);
    assert.deepEqual([log[0].op, log[0].tool, log[0].path], ['refused', 'workspace_read', 'src/.env']);
    assert.match(await tools.workspace_read.handler({ path: 'src/a.js', bogus: 1 }), /"error"/);
    assert.match(await tools.workspace_edit.handler({ path: 'src/a.js', oldString: '1', newString: '5' }), /"staged":true/);
  } finally { await f.cleanup(); }
});

test('sensitive checks ignore case and cover the root itself', async () => {
  for (const p of ['.GIT/config', '.SSH/ID_RSA', 'Keys/Server.PEM', '.ENV', 'Credentials.json']) assert.equal(isDenied(p), true, p);
  const f = await fixture();
  try {
    await mkdir(join(f.root, '.git'));
    await writeFile(join(f.root, '.git', 'config'), '[core]\n');
    await assert.rejects(Workspace.create({ root: join(f.root, '.git'), read: ['config'] }), /sensitive/);
  } finally { await f.cleanup(); }
});

test('hard-linked files are refused for read, search and staging', async () => {
  const f = await fixture();
  try {
    await link(join(f.root, 'src', '.env'), join(f.root, 'src', 'public.txt'));
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['src/public.txt'] });
    await assert.rejects(ws.read('src/public.txt'), /Hard-linked/);
    assert.deepEqual((await ws.search('TOKEN=secret')).matches, []);
    await assert.rejects(ws.write('src/public.txt', 'x'), /Hard-linked/);
  } finally { await f.cleanup(); }
});

test('a parent swapped for a symlink after the grant no longer matches', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['src/a.js'] });
    await writeFile(join(f.outside, 'a.js'), 'outside\n');
    await rename(join(f.root, 'src'), join(f.root, 'src-old'));
    await symlink(f.outside, join(f.root, 'src'));
    await assert.rejects(ws.read('src/a.js'), /outside|Not granted/);
    await assert.rejects(ws.write('src/a.js', 'x'), /Not granted for writing/);
  } finally { await f.cleanup(); }
});

test('binary and oversized content is refused before staging', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'src', 'bin.dat'), Buffer.from([1, 0, 2]));
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['src/a.js', 'src/bin.dat'] });
    await assert.rejects(ws.read('src/bin.dat'), /Binary/);
    await assert.rejects(ws.edit('src/bin.dat', 'a', 'b'), /Binary/);
    await assert.rejects(ws.write('src/a.js', 'x\0y'), /Binary/);
    const big = 'x'.repeat(600 * 1024);
    await ws.write('src/a.js', 'ab ab');
    await assert.rejects(ws.edit('src/a.js', 'ab', big, { replaceAll: true }), /size limit/);
  } finally { await f.cleanup(); }
});

test('staged creations show up in recursive list and in search', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'], write: ['docs/new.md'] });
    await ws.write('docs/new.md', 'needle here\n');
    assert.ok((await ws.list('.', { recursive: true })).entries.some(e => e.path === 'docs/new.md' && e.staged));
    assert.deepEqual((await ws.search('needle')).matches.map(m => m.path), ['docs/new.md']);
    assert.deepEqual((await ws.search('needle', { path: 'docs/new.md' })).matches.map(m => m.path), ['docs/new.md']);
  } finally { await f.cleanup(); }
});

test('the hash covers only reviewed content; apply is single-flight', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['src/a.js', 'src/b.js'] });
    await ws.edit('src/a.js', '1', '5');
    const first = await ws.changes();
    await ws.edit('src/b.js', '2', '6');
    ws.freeze();
    await assert.rejects(ws.apply(first.changeSetHash), /does not match/);
    const second = await ws.changes();
    assert.equal(second.files.length, 2);
    const results = await Promise.allSettled([ws.apply(second.changeSetHash), ws.apply(second.changeSetHash)]);
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(await readFile(join(f.root, 'src/b.js'), 'utf8'), 'const b = 6;\n');
  } finally { await f.cleanup(); }
});

test('unexpected filesystem errors are reduced to their code', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, read: ['src'] });
    const read = ws.tools().find(t => t.name === 'workspace_read');
    ws.read = async () => { const e = Error(`EACCES: permission denied, open '${f.outside}/private.txt'`); e.code = 'EACCES'; throw e; };
    const out = await read.handler({ path: 'src/a.js' });
    assert.match(out, /File system error \(EACCES\)/);
    assert.doesNotMatch(out, /outside/);
  } finally { await f.cleanup(); }
});

test('a FIFO in a granted directory is refused without hanging', async () => {
  const f = await fixture();
  try {
    execFileSync('mkfifo', [join(f.root, 'src', 'pipe')]);
    const ws = await Workspace.create({ root: f.root, read: ['src'] });
    await assert.rejects(ws.read('src/pipe'), /Not a regular file/);
    assert.equal((await ws.search('const')).matches.length, 2);
  } finally { await f.cleanup(); }
});

test('a UTF-8 BOM is preserved through edit, diff and apply', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'src', 'bom.txt'), '\uFEFFline one\nline two\n');
    const ws = await Workspace.create({ root: f.root, write: ['src/bom.txt'] });
    await ws.edit('src/bom.txt', 'two', '2');
    ws.freeze();
    const { files, changeSetHash } = await ws.changes();
    assert.doesNotMatch(files[0].diff, /^-.*line one/m);
    await ws.apply(changeSetHash);
    assert.deepEqual([...(await readFile(join(f.root, 'src', 'bom.txt'))).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally { await f.cleanup(); }
});

test('a parent directory replaced at the same path is detected', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['docs/new.md'] });
    await rename(join(f.root, 'docs'), join(f.root, 'docs-old'));
    await mkdir(join(f.root, 'docs'));
    await assert.rejects(ws.write('docs/new.md', 'x'), /Parent directory changed/);
  } finally { await f.cleanup(); }
});

test('a partial commit is recorded and blocks retry', async () => {
  const f = await fixture();
  try {
    const ws = await Workspace.create({ root: f.root, write: ['src/a.js', 'src/b.js'] });
    await ws.edit('src/a.js', '1', '3'); await ws.edit('src/b.js', '2', '4'); ws.freeze();
    const { changeSetHash } = await ws.changes();
    const disk = ws.diskState.bind(ws); let calls = 0;
    // Pass both preflight checks and the first commit check, then fail the second commit.
    ws.diskState = async t => { if (++calls === 4) throw Error('injected'); return disk(t); };
    await assert.rejects(ws.apply(changeSetHash), /Apply stopped at src\/b\.js[\s\S]*Written: src\/a\.js/);
    assert.equal(ws.summary().applyState, 'partial');
    await assert.rejects(ws.apply(changeSetHash), /already in progress or done/);
  } finally { await f.cleanup(); }
});
