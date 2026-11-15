import { appendFile, mkdir, readFile, rename, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

// Durable, metadata-only job history shared by every server process on the machine
// (each host runs its own process). Records route, outcome, usage and feedback, never
// prompts, results or file contents. Disable with COPILOT_COUNTERPART_HISTORY=off.

export const HISTORY_LIMITS = { rotateBytes: 5 * 1024 * 1024, listMax: 200 };

export function historyPath() {
  const value = process.env.COPILOT_COUNTERPART_HISTORY;
  if (value === 'off') return undefined;
  return resolve(value ?? join(homedir(), '.local', 'state', 'copilot-counterpart', 'history.jsonl'));
}

export class History {
  constructor(path = historyPath()) { this.path = path; this.writing = Promise.resolve(); }

  get enabled() { return Boolean(this.path); }

  // Appends one line. O_APPEND writes of a single short line do not interleave between
  // processes on a local filesystem. Failures never affect the job.
  append(record) {
    if (!this.path) return Promise.resolve();
    const line = JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n';
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const size = (await stat(this.path).catch(() => undefined))?.size ?? 0;
        if (size > HISTORY_LIMITS.rotateBytes) await rename(this.path, this.path + '.1').catch(() => {});
        await appendFile(this.path, line, { mode: 0o600 });
        await chmod(this.path, 0o600).catch(() => {});
      } catch (error) { process.stderr.write(`copilot-counterpart: history write failed: ${error.message}\n`); }
    });
    return this.writing;
  }

  recordJob(job) {
    const route = job.route ?? {};
    return this.append({
      type: 'job', jobId: job.id, status: job.status, error: job.error ? String(job.error).slice(0, 300) : undefined,
      model: job.model, reasoningEffort: job.reasoningEffort, role: route.role ?? job.meta?.role ?? (job.delegation ? 'orchestrate' : 'explicit'),
      complexity: job.meta?.complexity, risk: job.meta?.risk, leadFamily: route.leadFamily, crossFamily: route.crossFamily,
      fallback: route.fallback, policyVersion: route.policyVersion, escalatedFrom: job.meta?.parentJobId,
      grants: { files: job.workspace ? { read: job.workspace.spec.read.length, write: job.workspace.spec.write.length, staged: job.workspace.staged.size, applied: job.workspace.applyState } : undefined,
        web: job.web ? job.web.summary() : undefined, actions: job.actions ? job.actions.summary() : undefined },
      usage: job.usage, createdAt: job.createdAt, durationMs: Date.parse(new Date().toISOString()) - Date.parse(job.createdAt),
      resultChars: job.result?.length ?? 0
    });
  }

  recordFeedback(jobId, outcome) { return this.append({ type: 'feedback', jobId, outcome }); }

  async records() {
    if (!this.path) return [];
    await this.writing;
    const lines = [];
    for (const file of [this.path + '.1', this.path]) {
      const text = await readFile(file, 'utf8').catch(() => '');
      for (const line of text.split('\n')) { if (!line) continue; try { lines.push(JSON.parse(line)); } catch { /* skip a torn line */ } }
    }
    return lines;
  }

  // Jobs (latest first) with feedback merged in, plus per-role, per-model statistics.
  async query({ limit = 20, role, model, sinceDays } = {}) {
    const all = await this.records();
    const feedback = new Map();
    for (const r of all) if (r.type === 'feedback') feedback.set(r.jobId, r.outcome);
    const since = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    const jobs = all.filter(r => r.type === 'job' && (!role || r.role === role) && (!model || r.model === model) && Date.parse(r.at) >= since)
      .map(r => ({ ...r, feedback: feedback.get(r.jobId) ?? r.feedback })).reverse();
    const groups = new Map();
    for (const j of jobs) {
      const key = `${j.role}|${j.model}`;
      const g = groups.get(key) ?? { role: j.role, model: j.model, jobs: 0, completed: 0, failed: 0, timedOut: 0, cancelled: 0, useful: 0, unhelpful: 0, inconclusive: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
      g.jobs++;
      if (j.status === 'completed') g.completed++; else if (j.status === 'failed') g.failed++; else if (j.status === 'timed_out') g.timedOut++; else if (j.status === 'cancelled') g.cancelled++;
      if (j.feedback && g[j.feedback] !== undefined) g[j.feedback]++;
      g.inputTokens += j.usage?.inputTokens ?? 0; g.outputTokens += j.usage?.outputTokens ?? 0; g.durationMs += j.durationMs ?? 0;
      groups.set(key, g);
    }
    const stats = [...groups.values()].map(g => ({ role: g.role, model: g.model, jobs: g.jobs, completed: g.completed, failed: g.failed, timedOut: g.timedOut, cancelled: g.cancelled,
      feedback: { useful: g.useful, unhelpful: g.unhelpful, inconclusive: g.inconclusive },
      avgInputTokens: Math.round(g.inputTokens / g.jobs), avgOutputTokens: Math.round(g.outputTokens / g.jobs), avgSeconds: Math.round(g.durationMs / g.jobs / 1000) }))
      .sort((a, b) => b.jobs - a.jobs);
    return { path: this.path, totalJobs: jobs.length, jobs: jobs.slice(0, Math.min(limit, HISTORY_LIMITS.listMax)), stats };
  }

  async hasJob(jobId) { return (await this.records()).some(r => r.type === 'job' && r.jobId === jobId); }
  async feedbackFor(jobId) { let f; for (const r of await this.records()) if (r.type === 'feedback' && r.jobId === jobId) f = r.outcome; return f; }
}
