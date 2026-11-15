import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, docx, pdf } from './fixtures.mjs';
import { extractDocx, extractPdf } from '../src/documents.mjs';
import { Workspace } from '../src/workspace.mjs';

test('docx text is extracted with paragraphs and entities', () => {
  assert.equal(extractDocx(docx(['Senior Engineer', 'Built A &amp; B'])), 'Senior Engineer\nBuilt A & B');
  assert.throws(() => extractDocx(Buffer.from('not a zip')), /not a valid|ZIP/i);
  assert.throws(() => extractDocx(zip({ 'other.xml': 'x' })), /word\/document\.xml/);
});

test('pdf text is extracted', async () => {
  const text = await extractPdf(pdf(['Dan Example', 'Staff Engineer']));
  assert.match(text, /Dan Example/);
  assert.match(text, /Staff Engineer/);
  await assert.rejects(extractPdf(Buffer.from('%PDF-1.4 garbage')));
});

test('granted pdf and docx files are readable and searchable, never writable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'docs-')));
  try {
    await writeFile(join(root, 'resume.pdf'), pdf(['Kubernetes platform lead']));
    await writeFile(join(root, 'resume.docx'), docx(['Kubernetes migration']));
    await writeFile(join(root, 'broken.docx'), 'nope');
    const ws = await Workspace.create({ root, read: ['.'], write: ['resume.docx'] });
    assert.match((await ws.read('resume.pdf')).content, /platform lead/);
    assert.equal((await ws.read('resume.docx')).content, 'Kubernetes migration');
    assert.deepEqual((await ws.search('Kubernetes')).matches.map(m => m.path).sort(), ['resume.docx', 'resume.pdf']);
    await assert.rejects(ws.read('broken.docx'), /Could not extract text/);
    await assert.rejects(ws.write('resume.docx', 'x'), /can be read as text but not edited/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('extraction runs in a killable worker and hostile markup stays fast', async () => {
  const { extractDocument, DOCUMENT_LIMITS } = await import('../src/documents.mjs');
  assert.match(await extractDocument('pdf', pdf(['Worker text'])), /Worker text/);
  const t0 = Date.now();
  const hostile = docx(['x']).toString('latin1'); // ensure the worker path handles docx too
  assert.equal(await extractDocument('docx', docx(['<'.repeat(1)])), '<');
  const big = (await import('./fixtures.mjs')).zip({ 'word/document.xml': '<'.repeat(4 * 1024 * 1024) });
  assert.equal(typeof await extractDocument('docx', big), 'string');
  assert.ok(Date.now() - t0 < 5000);
  const saved = DOCUMENT_LIMITS.timeoutMs; DOCUMENT_LIMITS.timeoutMs = 1;
  try { await assert.rejects(extractDocument('pdf', pdf(['slow'])), /timed out/); } finally { DOCUMENT_LIMITS.timeoutMs = saved; }
});

test('extraction workers are pooled and cancellable', async () => {
  const { extractDocument, DOCUMENT_LIMITS } = await import('../src/documents.mjs');
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => extractDocument('pdf', pdf([`Doc ${i}`]))));
  assert.ok(runs.every((t, i) => t.includes(`Doc ${i}`)));
  const saved = DOCUMENT_LIMITS.queued; DOCUMENT_LIMITS.queued = 0;
  try {
    const flood = Array.from({ length: DOCUMENT_LIMITS.workers + 2 }, () => extractDocument('pdf', pdf(['x'])));
    const settled = await Promise.allSettled(flood);
    assert.ok(settled.some(r => r.status === 'rejected' && /Too many documents/.test(r.reason.message)));
  } finally { DOCUMENT_LIMITS.queued = saved; }
  const controller = new AbortController(); controller.abort(Error('stop'));
  await assert.rejects(extractDocument('pdf', pdf(['x']), controller.signal), /stop/);
});
