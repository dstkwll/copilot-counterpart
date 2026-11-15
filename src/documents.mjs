import { inflateRawSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';

// Text extraction for granted .pdf and .docx files and fetched PDFs. Read-only:
// these formats can be read and searched, never staged for writing.

export const DOCUMENT_LIMITS = { pdfPages: 300, textChars: 2_000_000, docxEntryBytes: 32 * 1024 * 1024, timeoutMs: 30000, heapMb: 512, workers: 2, queued: 16 };

export function documentKind(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return undefined;
}

let pdfjs;
async function loadPdfjs() {
  // Loaded lazily: it is large, and it only matters when a PDF is actually read.
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

export async function extractPdf(bytes) {
  const { getDocument, VerbosityLevel } = await loadPdfjs();
  // isEvalSupported:false closes pdf.js's font-code evaluation path; no fonts,
  // workers or network are needed for text.
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, stopAtErrors: false, verbosity: VerbosityLevel.ERRORS });
  const doc = await task.promise;
  try {
    const pages = Math.min(doc.numPages, DOCUMENT_LIMITS.pdfPages);
    const out = [];
    let length = 0;
    for (let n = 1; n <= pages && length < DOCUMENT_LIMITS.textChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : '');
      }
      page.cleanup();
      out.push(text.trim());
      length += text.length;
    }
    let text = out.join('\n\n\f\n\n');
    if (doc.numPages > pages) text += `\n\n[${doc.numPages - pages} more pages not extracted]`;
    return text.slice(0, DOCUMENT_LIMITS.textChars);
  } finally { await task.destroy(); }
}

// Minimal ZIP reader: enough to pull word/document.xml out of a .docx.
function zipEntry(bytes, wanted) {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('Not a valid .docx (no ZIP directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw Error('Corrupt .docx directory.');
    const method = buf.readUInt16LE(p + 10), compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if (size > DOCUMENT_LIMITS.docxEntryBytes) throw Error('.docx content too large.');
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw Error('Corrupt .docx entry.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: DOCUMENT_LIMITS.docxEntryBytes });
      throw Error('Unsupported .docx compression.');
    }
    p += 46 + nameLength + extra + comment;
  }
  throw Error('Not a Word document (no word/document.xml).');
}

export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™' };
  return text.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z]{1,32});/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

// Linear-time tag removal: [^<>]* stops at the next '<', so input such as '<<<<…'
// cannot cause quadratic rescanning the way /<[^>]+>/ does.
export function stripTags(text) { return text.replace(/<[^<>]*>/g, ''); }

export function extractDocx(bytes) {
  const xml = zipEntry(bytes, 'word/document.xml').toString('utf8');
  const text = stripTags(xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:(br|cr)\b[^<>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n'));
  return decodeEntities(text).replace(/\n{3,}/g, '\n\n').trim().slice(0, DOCUMENT_LIMITS.textChars);
}

export async function extractInProcess(kind, bytes) {
  return kind === 'pdf' ? extractPdf(bytes) : extractDocx(bytes);
}

// Production path: each extraction runs in its own worker thread with a heap limit and
// a deadline, so a hostile file cannot block or exhaust the MCP server.
// Process-wide cap on extraction workers, with a bounded queue: parallel reads cannot
// start an unbounded number of 512 MB threads.
let running = 0; const waiting = [];
async function slot(signal) {
  if (running < DOCUMENT_LIMITS.workers) { running++; return; }
  if (waiting.length >= DOCUMENT_LIMITS.queued) throw Error('Too many documents being extracted; try again shortly.');
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    signal?.addEventListener('abort', () => { const i = waiting.indexOf(entry); if (i >= 0) { waiting.splice(i, 1); reject(signal.reason ?? Error('Cancelled.')); } }, { once: true });
  });
}
function release() {
  const next = waiting.shift();
  if (next) next.resolve(); else running--;
}

export async function extractDocument(kind, bytes, signal) {
  if (signal?.aborted) throw signal.reason ?? Error('Cancelled.');
  await slot(signal);
  try { return await runWorker(kind, bytes, signal); } finally { release(); }
}

function runWorker(kind, bytes, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.mjs', import.meta.url), {
      workerData: { kind, bytes: new Uint8Array(bytes) }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: DOCUMENT_LIMITS.heapMb, maxYoungGenerationSizeMb: 64 }
    });
    worker.stdout.resume(); worker.stderr.resume(); // keep library warnings off the protocol stream
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(value); };
    const timer = setTimeout(() => done(reject, Error('Text extraction timed out.')), DOCUMENT_LIMITS.timeoutMs);
    signal?.addEventListener('abort', () => done(reject, signal.reason ?? Error('Cancelled.')), { once: true });
    worker.once('message', m => m.error ? done(reject, Error(m.error)) : done(resolve, m.text));
    worker.once('error', e => done(reject, Error(`Text extraction failed: ${String(e.message).slice(0, 200)}`)));
    worker.once('exit', code => done(reject, Error(`Text extraction stopped (exit ${code}).`)));
  });
}
