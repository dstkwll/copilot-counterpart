import { randomUUID, createHash } from 'node:crypto';

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const keptEvents = /^(assistant\.(message|usage)|tool\.|session\.(idle|error)|supervisor\.)/;
const PARTIAL_CHARS = 1000;

// Do not forward opaque provider metadata, encrypted reasoning or authentication fields.
function publicEventData(event) {
  const data = event.data ?? {};
  const fields = ['messageId', 'content', 'deltaContent', 'phase', 'toolCallId', 'toolName',
    'arguments', 'partialOutput', 'progressMessage', 'success', 'aborted', 'message', 'errorType',
    'nodeId', 'parentNodeId', 'op', 'tool', 'path', 'bytes', 'staged', 'created', 'entries', 'matches', 'depth', 'effectiveModel', 'status', 'route', 'usage', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost'];
  const result = Object.fromEntries(fields.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
  if (data.result) result.result = { content: data.result.content, detailedContent: data.result.detailedContent };
  if (data.error) result.error = { message: data.error.message };
  return result;
}

// SDK-independent job state machine. Each job owns a separate runtime.
export class Supervisor {
  constructor(factory, { maxActive = 2, maxJobs = 32, maxEvents = 512 } = {}) {
    this.factory = factory;
    this.maxActive = maxActive;
    this.maxJobs = maxJobs;
    this.maxEvents = maxEvents;
    this.jobs = new Map();
    this.closed = false;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job ID (jobs belong to this server process).');
    return job;
  }

  record(job, type, data = {}) {
    const encoded = JSON.stringify(data);
    const payload = encoded.length > 12000
      ? { truncated: true, preview: encoded.slice(0, 12000) } : data;
    job.events.push({ cursor: ++job.cursor, type, data: payload, at: new Date().toISOString() });
    if (job.events.length > this.maxEvents) job.events.shift();
    for (const wake of job.waiters) wake();
  }

  snapshot(job) {
    return { jobId: job.id, status: job.status, model: job.model,
      reasoningEffort: job.reasoningEffort, partial: job.partial?.text, route: job.route, delegation: job.delegation, workspace: job.workspace?.summary(), usage: job.usage, feedback: job.feedback,
      sessionId: job.session?.sessionId, cursor: job.cursor,
      createdAt: job.createdAt, error: job.error, result: job.result,
      resultTruncated: job.resultTruncated ?? false };
  }

  list() { return [...this.jobs.values()].map(j => this.snapshot(j)); }

  start({ requestId, prompt, model, reasoningEffort, route, timeoutSeconds = 300, delegation, runtimeCatalog, workspace }) {
    if (this.closed) throw new Error('Supervisor is shutting down.');
    if (!requestId || !prompt || prompt.length > 200000 || !model || timeoutSeconds < 1 || timeoutSeconds > 900)
      throw new Error('Invalid request: require requestId, model, bounded prompt and timeout (1–900 seconds).');
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, model, reasoningEffort, route, timeoutSeconds, delegation, files: workspace?.spec })).digest('hex');
    const prior = [...this.jobs.values()].find(j => j.requestId === requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('requestId already used with different inputs.');
      return this.snapshot(prior);
    }
    if ([...this.jobs.values()].filter(j => !j.cleanupComplete).length >= this.maxActive)
      throw new Error('Active job limit reached. Wait or cancel an existing job.');
    if (this.jobs.size >= this.maxJobs)
      throw new Error('Job history is full. Forget a finished job before starting another.');
    const job = { id: randomUUID(), requestId, fingerprint, model, reasoningEffort, route, delegation, runtimeCatalog, workspace, usage: { inputTokens: 0, outputTokens: 0, events: 0 }, status: 'starting',
      createdAt: new Date().toISOString(), events: [], cursor: 0, waiters: new Set(), result: '' };
    this.jobs.set(job.id, job);
    if (workspace) workspace.onAccess = access => this.record(job, 'supervisor.file_access', access);
    const policy = delegation ? 'context-only; bounded router delegation only'
      : workspace ? `scoped files: read ${workspace.spec.read.length} path(s), stage ${workspace.spec.write.length} file(s); all other tools denied`
      : 'context-only; all tools denied';
    this.record(job, 'supervisor.started', { model, timeoutSeconds, policy });
    job.timer = setTimeout(() => void this.cancel(job.id, 'timed_out'), timeoutSeconds * 1000);
    job.task = this.run(job, prompt);
    return this.snapshot(job);
  }

  async run(job, prompt) {
    try {
      job.runtime = this.factory(job);
      job.session = await job.runtime.open(job.model, event => {
        if (terminal.has(job.status)) return;
        // Token deltas are coalesced: one assistant.streaming event per message (which
        // wakes long polls) plus a short tail in the snapshot. Recording every delta
        // flooded pollers' context and evicted audit events from the bounded history;
        // the complete text still arrives as assistant.message.
        if (event.type === 'assistant.message_delta') {
          const messageId = event.data?.messageId;
          if (!job.partial || job.partial.messageId !== messageId) {
            job.partial = { messageId, text: '' };
            this.record(job, 'assistant.streaming', { messageId, phase: event.data?.phase });
          }
          job.partial.text = (job.partial.text + (event.data?.deltaContent ?? '')).slice(-PARTIAL_CHARS);
          return;
        }
        if (event.type === 'assistant.message') job.partial = undefined;
        if (keptEvents.test(event.type)) this.record(job, event.type, this.redactWorkspaceTool(job, event.type, publicEventData(event)));
        if (event.type === 'assistant.usage') {
          job.usage.events++;
          for (const key of ['inputTokens', 'outputTokens']) {
            const value = event.data?.[key];
            if (Number.isFinite(value) && value >= 0) job.usage[key] += value;
          }
        }
        if (event.type === 'assistant.message') {
          const content = event.data?.content ?? '';
          job.result = content.slice(0, 100000);
          job.resultTruncated = content.length > 100000;
        }
        if (event.type === 'session.error') {
          this.finish(job, 'failed', event.data?.message ?? 'Session error');
          void this.cancel(job.id);
        }
        if (event.type === 'session.idle') this.finish(job, event.data?.aborted ? 'cancelled' : 'completed');
      }, { reasoningEffort: job.reasoningEffort });
      if (terminal.has(job.status)) return;
      job.status = 'running';
      this.record(job, 'supervisor.ready', { sessionId: job.session.sessionId });
      await job.session.send({ prompt });
      if (!terminal.has(job.status)) await new Promise(resolve => { job.done = resolve; });
    } catch (error) {
      this.finish(job, 'failed', error.message);
    } finally {
      clearTimeout(job.timer);
      try {
        await job.runtime?.close();
        job.cleanupComplete = true;
      } catch (error) {
        // Fail closed: an unconfirmed runtime shutdown must not free capacity.
        this.record(job, 'supervisor.cleanup_error', { message: error.message });
      }
    }
  }

  // Workspace tool calls carry file contents in their arguments and results. The
  // supervisor.file_access events already record what happened, so keep only metadata
  // here; otherwise every events poll would ship file contents back to the lead.
  redactWorkspaceTool(job, type, data) {
    if (!job.workspace || !type.startsWith('tool.')) return data;
    job.workspaceCalls ??= new Set();
    if (typeof data.toolName === 'string' && data.toolName.startsWith('workspace_')) job.workspaceCalls.add(data.toolCallId);
    if (!job.workspaceCalls.has(data.toolCallId)) return data;
    const kept = { toolCallId: data.toolCallId, toolName: data.toolName, success: data.success, model: data.model, redacted: 'workspace content omitted; see supervisor.file_access' };
    return Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined));
  }

  finish(job, status, error) {
    if (terminal.has(job.status)) return;
    job.status = status;
    job.error = error;
    job.workspace?.freeze();
    clearTimeout(job.timer);
    this.record(job, 'supervisor.finished', { status, error });
    job.done?.();
  }

  async events(id, { after = 0, waitMs = 0, limit = 50 } = {}) {
    const job = this.get(id);
    if (!Number.isInteger(after) || after < 0 || after > job.cursor || waitMs < 0 || waitMs > 30000 || limit < 1 || limit > 100)
      throw new Error('Invalid event cursor, limit or wait duration.');
    if (job.cursor <= after && !terminal.has(job.status) && waitMs) {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); job.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, waitMs);
        job.waiters.add(wake);
      });
    }
    const events = job.events.filter(e => e.cursor > after).slice(0, limit);
    return { ...this.snapshot(job), events, nextCursor: events.at(-1)?.cursor ?? after,
      gap: after < (job.events[0]?.cursor ?? 1) - 1,
      hasMore: (events.at(-1)?.cursor ?? after) < job.cursor };
  }

  async steer(id, prompt) {
    const job = this.get(id);
    if (job.status !== 'running') throw new Error('Only a running job can be steered.');
    if (!prompt || prompt.length > 20000) throw new Error('Steering prompt must be 1–20000 characters.');
    await job.session.send({ prompt, mode: 'immediate' });
    this.record(job, 'supervisor.steering_sent', { note: 'Best effort before next model request; may queue if turn just ended.' });
    return this.snapshot(job);
  }

  async cancel(id, status = 'cancelled') {
    const job = this.get(id);
    if (!job.cancelPromise) {
      this.finish(job, status);
      // Terminal state does not imply its send/startup/cleanup has settled.
      job.cancelPromise = (async () => {
        await job.runtime?.close().catch(error => this.record(job, 'supervisor.cleanup_error', { message: error.message }));
        await job.task;
        return this.snapshot(job);
      })();
    }
    return job.cancelPromise;
  }

  workspaceJob(id) {
    const job = this.get(id);
    if (!job.workspace) throw new Error('This job was not granted files.');
    return job;
  }

  async changes(id) {
    const job = this.workspaceJob(id);
    return { jobId: id, status: job.status, ...(await job.workspace.changes()) };
  }

  // Writes staged changes to disk. Only after the job is terminal and its runtime
  // has shut down, so the delegate can no longer stage anything.
  async apply(id, changeSetHash) {
    const job = this.workspaceJob(id);
    if (!terminal.has(job.status)) throw new Error('Apply only after the job has finished.');
    await job.task;
    if (!job.cleanupComplete) throw new Error('Runtime shutdown is unconfirmed; refusing to apply.');
    const result = await job.workspace.apply(changeSetHash);
    this.record(job, 'supervisor.applied', { files: result.applied });
    return { jobId: id, ...result };
  }

  async forget(id) {
    const job = this.get(id);
    if (!terminal.has(job.status)) throw new Error('Cancel or finish the job before forgetting it.');
    await job.task;
    if (!job.cleanupComplete) throw new Error('Runtime cleanup is unconfirmed; cannot forget its occupied slot.');
    this.jobs.delete(id);
    return { forgotten: id, note: 'Removed bridge memory only; SDK-owned session storage is separate.' };
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
    await Promise.all([...this.jobs.values()].map(j => j.task));
  }
}
