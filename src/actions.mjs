import { createHash } from 'node:crypto';
import { readFile, realpath, stat, access, lstat, readlink, mkdtemp, cp, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname, basename, relative, sep } from 'node:path';
import { z } from 'zod';

// Named actions: the one exception to "no execution". The owner approves each entry
// once, in a registry file only the owner (or a lead acting with the owner's approval)
// edits. A delegate may run only actions its job was granted, by name, with arguments
// that match each entry's patterns. No shell is involved, so arguments cannot chain
// commands. Actions see files on disk, not a job's staged edits.

export const ACTION_LIMITS = { outputChars: 4000, runsPerJob: 20, maxTimeoutSeconds: 600, bufferBytes: 8 * 1024 * 1024, argChars: 200, quantifiers: 3, overlayFiles: 50000, outputsListed: 50 };
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TERM'];

export function registryPath() {
  return resolve(process.env.COPILOT_COUNTERPART_ACTIONS ?? join(homedir(), '.config', 'copilot-counterpart', 'actions.json'));
}

// Argument patterns use a restricted syntax: ^, then literals, escapes (\d \w \s \. etc.)
// and [character classes], each optionally quantified (+ * ? {m} {m,n}), then $. No groups
// and no alternation, so a pattern always matches the whole argument, and at most three
// quantifiers keep matching fast on the 200-character arguments allowed.
const ATOM = String.raw`(?:\\[dDwWsS.\-_/:+]|\[(?:\\.|[^\]\\])+\]|[A-Za-z0-9 ._\-/:=,@%])`;
const QUANT = String.raw`(?:[+*?]|\{\d{1,3}(?:,\d{0,3})?\})`;
const SAFE_PATTERN = new RegExp(`^\\^(?:${ATOM}${QUANT}?)+\\$$`);
export function checkPattern(pattern) {
  if (!SAFE_PATTERN.test(pattern)) throw Error('Argument patterns must be ^…$ with literals, escapes and [classes] only: no groups or |.');
  if ((pattern.match(new RegExp(QUANT, 'g')) ?? []).length > ACTION_LIMITS.quantifiers) throw Error(`Argument patterns may use at most ${ACTION_LIMITS.quantifiers} quantifiers.`);
  return new RegExp(pattern);
}

// Canonical form of a path that may not exist yet: real parent directory plus file name.
// A dangling symlink is followed to the path it would create, so protection covers the
// file that writing through the link would produce.
export async function canonical(path, depth = 0) {
  const absolute = resolve(path);
  const real = await realpath(absolute).catch(() => undefined);
  if (real) return real;
  const info = await lstat(absolute).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    if (depth >= 16) throw Error(`Too many symlinks: ${absolute}`);
    return canonical(resolve(dirname(absolute), await readlink(absolute)), depth + 1);
  }
  return join(await realpath(dirname(absolute)).catch(() => dirname(absolute)), basename(absolute));
}

const entrySchema = z.object({
  description: z.string().min(1).max(500),
  command: z.string().min(1).max(4096),
  args: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), pattern: z.string().min(2).max(200), description: z.string().max(200).optional() }).strict()).max(8).default([]),
  fixedArgs: z.array(z.string().max(1000)).max(16).default([]).describe('Arguments always passed before the delegate-supplied ones.'),
  cwd: z.string().min(1).max(4096),
  timeoutSeconds: z.number().int().min(1).max(ACTION_LIMITS.maxTimeoutSeconds).default(120),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(16).default([]).describe('Extra environment variable names to pass through.'),
  allowStaged: z.boolean().default(false).describe('Allow runs against a temporary copy of cwd that includes the job\'s staged edits. The action then processes delegate-written content, so approve this only for commands that are safe on untrusted input.'),
  approved: z.string().min(1).max(100).describe('When and by whom it was approved, e.g. "2026-11-15 by Dan in conversation".')
}).strict();
export const registrySchema = z.object({ actions: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), entrySchema) }).strict();

export async function loadRegistry(path = registryPath()) {
  path = resolve(path);
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { path, actions: {}, absent: true }; throw e; }
  const parsed = registrySchema.parse(JSON.parse(text));
  return { path, actions: parsed.actions };
}

// Paths a write grant must never cover: the registry itself and every registered script.
export async function protectedPaths(registry) {
  const paths = new Set([resolve(registry.path), await canonical(registry.path)]);
  for (const entry of Object.values(registry.actions)) { paths.add(resolve(entry.command)); paths.add(await canonical(entry.command)); }
  return paths;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
class ActionRefusal extends Error {}

export class Actions {
  // Validates the granted names against the registry and snapshots each script's hash,
  // so a script changed during the job is refused rather than run.
  static async create(names, registry) {
    const actions = new Actions(registry);
    for (const name of [...new Set(names)]) {
      const entry = registry.actions[name];
      if (!entry) throw Error(`Unknown action: ${name}. Registered: ${Object.keys(registry.actions).join(', ') || 'none'} (${registry.path}).`);
      if (!isAbsolute(entry.command) || !isAbsolute(entry.cwd)) throw Error(`Action ${name} needs an absolute command and cwd.`);
      const command = await realpath(entry.command).catch(() => { throw Error(`Action ${name}: command not found.`); });
      if (!(await stat(command)).isFile()) throw Error(`Action ${name}: command is not a file.`);
      await access(command, constants.X_OK).catch(() => { throw Error(`Action ${name}: command is not executable.`); });
      if (!(await stat(entry.cwd).catch(() => undefined))?.isDirectory()) throw Error(`Action ${name}: cwd is not a directory.`);
      const patterns = entry.args.map(a => { try { return checkPattern(a.pattern); } catch (e) { throw Error(`Action ${name}, argument ${a.name}: ${e.message}`); } });
      actions.granted.set(name, { ...entry, command, patterns, hash: sha(await readFile(command)) });
    }
    return actions;
  }

  constructor(registry) {
    this.registry = registry; this.granted = new Map(); this.runs = 0;
    this.frozen = false; this.running = Promise.resolve(); this.onAccess = undefined;
    this.workspace = undefined; // set by buildGrants when the job also has files
    this.overlays = [];
  }

  // Removes temporary run copies; called when the job finishes.
  async cleanup() { const dirs = this.overlays.splice(0); await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))); }

  get names() { return [...this.granted.keys()]; }
  freeze() { this.frozen = true; }
  summary() { return { granted: this.names, runs: this.runs }; }

  run(name, args = [], options = {}) {
    // One action at a time per job.
    const next = this.running.then(() => this.runOnce(name, args, options));
    this.running = next.catch(() => {});
    return next;
  }

  async runOnce(name, args, { staged = false } = {}) {
    if (this.frozen) throw new ActionRefusal('The job has finished.');
    const entry = this.granted.get(name);
    if (!entry) throw new ActionRefusal(`Action not granted to this job: ${name}. Granted: ${this.names.join(', ') || 'none'}.`);
    if (this.runs >= ACTION_LIMITS.runsPerJob) throw new ActionRefusal('Job action limit reached.');
    if (args.length !== entry.args.length) throw new ActionRefusal(`${name} takes ${entry.args.length} argument(s): ${entry.args.map(a => a.name).join(', ') || 'none'}.`);
    args.forEach((value, i) => {
      if (typeof value !== 'string' || value.length > ACTION_LIMITS.argChars || !entry.patterns[i].test(value))
        throw new ActionRefusal(`Argument ${entry.args[i].name} does not match ${entry.args[i].pattern}.`);
    });
    if (sha(await readFile(entry.command)) !== entry.hash) throw new ActionRefusal(`The script for ${name} changed after this job started; refusing to run it.`);
    if (staged && !entry.allowStaged) throw new ActionRefusal(`${name} is not approved to run on staged edits; ask the lead to apply them first.`);
    if (staged && !this.workspace) throw new ActionRefusal('This job has no files grant, so it has no staged edits.');
    this.runs++;
    const run = staged ? await this.overlay(entry, this.runs) : { cwd: entry.cwd, command: entry.command };
    const env = Object.fromEntries([...BASE_ENV, ...entry.env].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const started = Date.now();
    const result = await new Promise(resolve => execFile(run.command, [...entry.fixedArgs, ...args], {
      cwd: run.cwd, env, timeout: entry.timeoutSeconds * 1000, killSignal: 'SIGKILL', maxBuffer: ACTION_LIMITS.bufferBytes, shell: false, windowsHide: true
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })));
    const tail = text => text.length > ACTION_LIMITS.outputChars ? `…[${text.length - ACTION_LIMITS.outputChars} chars omitted]\n` + text.slice(-ACTION_LIMITS.outputChars) : text;
    const timedOut = Boolean(result.error?.killed && result.error?.signal === 'SIGKILL');
    const exitCode = result.error ? (typeof result.error.code === 'number' ? result.error.code : null) : 0;
    const summary = { action: name, args, exitCode, signal: result.error?.signal ?? null, timedOut, durationMs: Date.now() - started,
      stdout: tail(result.stdout), stderr: tail(result.stderr) };
    if (result.error && exitCode === null && !timedOut && !result.error.signal) summary.error = String(result.error.code ?? result.error.message).slice(0, 200);
    if (staged) {
      summary.staged = { applied: run.applied, skipped: run.skipped, outputs: await this.outputs(run) };
      this.workspace.addRunRoot(run.alias, run.cwd);
    }
    this.onAccess?.({ op: 'action', action: name, args, exitCode, timedOut, durationMs: summary.durationMs, staged: staged || undefined });
    return summary;
  }

  // Builds a temporary copy of the action's cwd (APFS clones where available, .git
  // skipped) with the job's staged edits written in. The approved script runs from the
  // copy when it lives inside cwd, after the same hash check.
  async overlay(entry, n) {
    const base = await realpath(entry.cwd);
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'copilot-counterpart-run-')));
    this.overlays.push(temp);
    const root = join(temp, 'w');
    let files = 0;
    await cp(base, root, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: async src => {
        if (basename(src) === '.git') return false;
        if (++files > ACTION_LIMITS.overlayFiles) throw new ActionRefusal(`The action's folder has more than ${ACTION_LIMITS.overlayFiles} files; too large to copy.`);
        return true;
      } });
    const applied = [], skipped = [];
    for (const s of this.workspace.snapshot()) {
      if (s.target === base || !s.target.startsWith(base + sep)) { skipped.push(s.path); continue; }
      const dest = join(root, relative(base, s.target));
      await mkdir(dirname(dest), { recursive: true });
      await rm(dest, { force: true }); // never write through a link copied from the original
      await writeFile(dest, s.content);
      applied.push(s.path);
    }
    let command = entry.command;
    if (command.startsWith(base + sep)) {
      command = join(root, relative(base, command));
      if (sha(await readFile(command)) !== entry.hash) throw new ActionRefusal('The copied script does not match the approved one.');
    }
    return { cwd: root, command, applied, skipped, alias: `@run${n}`, before: await this.listing(root) };
  }

  async listing(root) {
    const map = new Map();
    const walk = async dir => {
      for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full);
        else if (item.isFile()) { const info = await stat(full); map.set(relative(root, full), `${info.size}:${info.mtimeMs}`); }
      }
    };
    await walk(root);
    return map;
  }

  async outputs(run) {
    const after = await this.listing(run.cwd);
    const changed = [...after].filter(([p, v]) => run.before.get(p) !== v).map(([p]) => p).sort();
    return { files: changed.slice(0, ACTION_LIMITS.outputsListed).map(p => `${run.alias}/${p}`), more: Math.max(0, changed.length - ACTION_LIMITS.outputsListed) };
  }

  tools() {
    if (!this.granted.size) return [];
    const list = [...this.granted].map(([n, e]) => `${n}(${e.args.map(a => `${a.name}: ${a.pattern}`).join(', ')})${e.allowStaged ? ' [staged ok]' : ''} — ${e.description}`).join('; ');
    const tool = {
      name: 'run_action', skipPermission: true, defer: 'never',
      description: `Run a pre-approved named action with its arguments; returns exit code and the tail of its output. By default it sees files on disk, not your staged edits. With staged: true (only for actions marked [staged ok]) it runs on a temporary copy that includes your staged edits, and lists the files it created or changed as @runN/... paths you can read with workspace_read. Available: ${list}`.slice(0, 2000),
      parameters: z.object({ name: z.string().min(1).max(48), args: z.array(z.string().max(ACTION_LIMITS.argChars)).max(8).default([]), staged: z.boolean().default(false) }).strict()
    };
    tool.handler = async raw => {
      try { const a = tool.parameters.parse(raw); return JSON.stringify(await this.run(a.name, a.args, { staged: a.staged })); }
      catch (error) {
        const message = String(error.message).slice(0, 300);
        this.onAccess?.({ op: 'refused', tool: 'run_action', action: typeof raw?.name === 'string' ? raw.name.slice(0, 48) : undefined, message });
        return JSON.stringify({ error: message });
      }
    };
    return [tool];
  }

  describe() {
    return `You may use run_action for these pre-approved actions only: ${this.names.join(', ')}. They run real commands on disk files, or with staged: true on a temporary copy that includes your staged edits (where allowed); run them only when the task needs the result.`;
  }
}
