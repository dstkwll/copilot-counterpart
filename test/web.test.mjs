import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { WebAccess, isBlockedAddress, htmlToText, WEB_LIMITS } from '../src/web.mjs';
import { pdf } from './fixtures.mjs';

test('private, local and special addresses are blocked; public ones are not', () => {
  for (const a of ['127.0.0.1', '10.0.0.5', '172.31.0.1', '192.168.0.10', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd12::1', 'fec0::1', '2001:db8::1', '2001:0:4136:e378::1', '2002:a00:1::1', '3fff::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::a00:1', 'ff02::1', 'not-an-ip'])
    assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])
    assert.equal(isBlockedAddress(a), false, a);
});

test('html becomes readable text without scripts or styles', () => {
  const { title, text } = htmlToText('<html><head><title>Job &amp; Co</title><style>x{}</style></head><body><script>evil()</script><h1>Staff Engineer</h1><p>Remote&nbsp;OK</p><ul><li>Go</li><li>K8s</li></ul></body></html>');
  assert.equal(title, 'Job & Co');
  assert.equal(text, 'Staff Engineer\nRemote OK\n\n• Go\n• K8s');
});

// A local server stands in for the internet. Tests map fake hostnames to it and mark
// one hostname "private" so the real blocking path is exercised.
async function server(routes) {
  const s = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); return res.end(); }
    route(req, res);
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise(r => s.close(r)) };
}
const TEST_ADDRESSES = { 'public.test': '127.0.0.1', 'private.test': '10.0.0.1' };
const testWeb = () => new WebAccess({
  resolve: async host => TEST_ADDRESSES[host] ? [{ address: TEST_ADDRESSES[host], family: 4 }] : [],
  blocked: address => address !== '127.0.0.1' && isBlockedAddress(address)
});

test('fetches html, json, gzip and pdf; logs each fetch; sends no cookies', async () => {
  let seenHeaders;
  const srv = await server({
    '/page': (req, res) => { seenHeaders = req.headers; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'a=b' }); res.end('<title>T</title><p>Hello</p>'); },
    '/api': (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync('{"jobs":[1]}')); },
    '/doc': (req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf(['Posting text'])); },
    '/again': (req, res) => { seenHeaders = req.headers; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }
  });
  try {
    const web = testWeb(); const log = []; web.onAccess = e => log.push(e);
    const page = await web.fetch(`http://public.test:${srv.port}/page`);
    assert.deepEqual([page.status, page.title, page.text], [200, 'T', 'Hello']);
    assert.equal((await web.fetch(`http://public.test:${srv.port}/api`)).text, '{"jobs":[1]}');
    const part = await web.fetch(`http://public.test:${srv.port}/api`, { maxChars: 5, offset: 2 });
    assert.deepEqual([part.text, part.truncated, part.nextOffset, part.totalChars], ['jobs"', true, 7, 12]);
    assert.match((await web.fetch(`http://public.test:${srv.port}/doc`)).text, /Posting text/);
    await web.fetch(`http://public.test:${srv.port}/again`);
    assert.equal(seenHeaders.cookie, undefined);
    assert.equal(seenHeaders.host, `public.test:${srv.port}`);
    assert.equal(log.length, 5); assert.ok(log.every(e => e.op === 'fetch' && e.status === 200));
    assert.equal(web.summary().fetches, 5);
  } finally { await srv.close(); }
});

test('refuses private targets, redirects into them, bad schemes, credentials, oversize and unknown types', async () => {
  const srv = await server({
    '/hop': (req, res) => { res.writeHead(302, { location: 'http://private.test/secret' }); res.end(); },
    '/big': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.alloc(WEB_LIMITS.bodyBytes + 10, 97)); },
    '/bin': (req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('x'); }
  });
  try {
    const web = testWeb();
    await assert.rejects(web.fetch('http://private.test/'), /local or private/);
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/hop`), /local or private/);
    await assert.rejects(web.fetch('file:///etc/passwd'), /Only http/);
    await assert.rejects(web.fetch(`http://user:pw@public.test:${srv.port}/`), /credentials/);
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/big`), /too large/);
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/bin`), /Unsupported content type/);
    // The real resolver and blocklist refuse loopback outright.
    await assert.rejects(new WebAccess().fetch(`http://127.0.0.1:${srv.port}/bin`), /local or private/);
    await assert.rejects(new WebAccess().fetch(`http://localhost:${srv.port}/bin`), /local or private/);
  } finally { await srv.close(); }
});

test('the web_get tool returns errors as data, logs refusals and stops after the job', async () => {
  const web = testWeb(); const log = []; web.onAccess = e => log.push(e);
  const [tool] = web.tools();
  assert.equal(tool.name, 'web_get');
  assert.match(await tool.handler({ url: 'http://private.test/' }), /"error":"Refused/);
  assert.equal(log[0].op, 'refused');
  web.freeze();
  assert.match(await tool.handler({ url: 'http://public.test/' }), /finished/);
});

test('markup extraction stays linear on hostile input', () => {
  const t0 = Date.now();
  htmlToText('<'.repeat(4 * 1024 * 1024));
  htmlToText('<script'.repeat(300000));
  htmlToText('<!--'.repeat(500000));
  htmlToText('<title'.repeat(300000));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

test('an aborted compressed response is an error, not a crash; slow bodies hit the absolute deadline', async () => {
  const { createGzip } = await import('node:zlib');
  const srv = await server({
    '/cut': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); const z = createGzip(); z.pipe(res); z.write('x'.repeat(50000)); z.flush(() => setTimeout(() => res.socket.destroy(), 50)); },
    '/trickle': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); const t = setInterval(() => res.write('.'), 200); res.on('close', () => clearInterval(t)); },
    '/redir-stream': (req, res) => { res.writeHead(302, { location: '/ok' }); const t = setInterval(() => res.write('x'.repeat(10000)), 10); res.on('close', () => clearInterval(t)); },
    '/ok': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fine'); }
  });
  const saved = WEB_LIMITS.timeoutMs; WEB_LIMITS.timeoutMs = 1500;
  try {
    const web = testWeb();
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/cut`));
    const t0 = Date.now();
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/trickle`), /timed out/);
    assert.ok(Date.now() - t0 < 4000);
    const fresh = testWeb();
    assert.equal((await fresh.fetch(`http://public.test:${srv.port}/redir-stream`)).text, 'fine');
    assert.equal(fresh.summary().bytes, 4, 'only the final body is counted; the redirect body is never read');
  } finally { WEB_LIMITS.timeoutMs = saved; await srv.close(); }
});

test('freezing aborts in-flight fetches and the shared budget limits concurrency', async () => {
  const srv = await server({ '/hang': (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a'); } });
  try {
    const web = testWeb();
    const pending = [1, 2, 3, 4].map(() => web.fetch(`http://public.test:${srv.port}/hang`));
    await new Promise(r => setTimeout(r, 200));
    await assert.rejects(web.fetch(`http://public.test:${srv.port}/hang`), /at once/);
    web.freeze();
    const results = await Promise.allSettled(pending);
    assert.ok(results.every(r => r.status === 'rejected' && /finished/.test(r.reason.message)));
  } finally { await srv.close(); }
});

test('comments keep the next character; non-ASCII case changes keep offsets aligned', () => {
  assert.equal(htmlToText('<p>A<!--x-->BC</p>').text, 'ABC');
  const r = htmlToText('<title>İstanbul</title><p>Hello</p>');
  assert.deepEqual([r.title, r.text], ['İstanbul', 'Hello']);
});

test('a hanging DNS lookup still honors the deadline and freeze', async () => {
  const web = new WebAccess({ resolve: () => new Promise(() => {}) });
  const saved = WEB_LIMITS.timeoutMs; WEB_LIMITS.timeoutMs = 300;
  try { await assert.rejects(web.fetch('http://stuck.test/'), /timed out/); } finally { WEB_LIMITS.timeoutMs = saved; }
  const frozen = new WebAccess({ resolve: () => new Promise(() => {}) });
  const pending = frozen.fetch('http://stuck.test/');
  setTimeout(() => frozen.freeze(), 50);
  await assert.rejects(pending, /finished/);
});
