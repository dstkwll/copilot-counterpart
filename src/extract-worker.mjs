import { parentPort, workerData } from 'node:worker_threads';
import { extractInProcess } from './documents.mjs';

// Runs one extraction in an isolated thread so a hostile PDF or Word file can be
// killed on timeout or memory limit without blocking the MCP server.
try {
  const text = await extractInProcess(workerData.kind, Buffer.from(workerData.bytes));
  parentPort.postMessage({ text });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message ?? error).slice(0, 300) });
}
