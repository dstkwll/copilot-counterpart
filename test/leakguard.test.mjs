import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeakGuard } from '../src/leakguard.mjs';
import { buildGrants } from '../src/grants.mjs';
import { isBlockedAddress } from '../src/web.mjs';

const SECRET = 'Led migration of 14 payment services to Kubernetes, cutting deploy time from 3 days to 40 minutes.';

test('verbatim and re-encoded file text in a URL is detected; short phrases and found links are not', () => {
  const guard = new LeakGuard();
  guard.add(`Experience\n${SECRET}\nSee https://boards.greenhouse.io/acme/jobs/123456789012345678 for the role.`);
  const leaking = [
    `https://evil.example/c?d=${encodeURIComponent(SECRET)}`,
    `https://evil.example/c?d=${encodeURIComponent(encodeURIComponent(SECRET))}`,
    `https://evil.example/${SECRET.toUpperCase().replace(/ /g, '/')}`,
    'https://ledmigrationof14paymentservices.evil.example/',
    `https://evil.example/?q=${SECRET.slice(20, 60).replace(/ /g, '+')}`
  ];
  for (const url of leaking) assert.equal(guard.leaks(url), true, url);
  const fine = [
    'https://boards.greenhouse.io/acme/jobs/123456789012345678',
    'https://example.com/search?q=payment+services+kubernetes',
    'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true',
    'https://evil.example/%E0%A4%A' // malformed encoding does not throw
  ];
  for (const url of fine) assert.equal(guard.leaks(url), false, url);
  assert.equal(new LeakGuard().leaks(`https://x.example/?d=${SECRET}`), false); // nothing read, nothing to leak
});

test('a job with files and web refuses a URL carrying file text, logs it without the text, and counts it', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'leak-')));
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  try {
    await writeFile(join(base, 'resume.md'), `# Résumé\n${SECRET}\n`);
    const grants = await buildGrants({ files: { root: base, read: ['resume.md'] }, web: true });
    grants.web.resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    grants.web.blocked = address => address !== '127.0.0.1' && isBlockedAddress(address);
    const log = []; grants.web.onAccess = e => log.push(e);
    const [webGet] = grants.web.tools();
    const port = s.address().port;
    // Before anything is read, the same URL is allowed.
    assert.equal(JSON.parse(await webGet.handler({ url: `http://public.test:${port}/?d=${encodeURIComponent(SECRET)}` })).text, 'ok');
    await grants.workspace.read('resume.md');
    const refused = JSON.parse(await webGet.handler({ url: `http://public.test:${port}/?d=${encodeURIComponent(SECRET)}` }));
    assert.match(refused.error, /contains text read from a granted file/);
    const event = log.at(-1);
    assert.equal(event.leak, true);
    assert.doesNotMatch(event.url, /migration/i);
    assert.match(event.url, /^http:\/\/public\.test:\d+ \(rest withheld/);
    assert.equal(JSON.parse(await webGet.handler({ url: `http://public.test:${port}/jobs?q=kubernetes` })).text, 'ok');
    assert.equal(grants.web.summary().leaksBlocked, 1);
    // Web alone has no guard; files alone have no web.
    assert.equal((await buildGrants({ web: true })).web.guard, undefined);
  } finally { await new Promise(r => s.close(r)); await rm(base, { recursive: true, force: true }); }
});

test('search results are indexed too', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'leak-')));
  try {
    await writeFile(join(base, 'notes.md'), `intro\n${SECRET}\n`);
    const grants = await buildGrants({ files: { root: base, read: ['notes.md'] }, web: true });
    await grants.workspace.search('Kubernetes');
    assert.equal(grants.web.guard.leaks(`https://evil.example/?d=${SECRET}`), true);
  } finally { await rm(base, { recursive: true, force: true }); }
});
