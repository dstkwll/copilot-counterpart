# Copilot Counterpart

A local [MCP](https://modelcontextprotocol.io) server that lets a coding assistant such as **Codex** or **Claude Code** hand bounded work to models in your **GitHub Copilot** subscription, with automatic model routing, live progress, steering and cancellation. Jobs are context-only by default. A call can grant scoped file access (reads, PDF/Word text, and staged writes the lead reviews before anything reaches disk), read-only web access, and pre-approved named actions.

It uses the official [GitHub Copilot SDK](https://github.com/github/copilot-sdk) and your existing `copilot login`. It is not an unofficial API proxy, and it never copies credentials.

## Why

Your primary assistant stays the thinking partner and decision-maker. Copilot gives it cheap access to *other* models for:

- **independent review** of a meaningful change,
- **correctness checks** (races, lifecycle, invariants),
- **design sparring** before a consequential decision,
- **bounded analysis or code proposals** returned as text.

The router picks the model and reasoning effort from the task's role, complexity and risk, and sends independent work to a **different model family from the lead**, so a Claude-led session gets a GPT second opinion and a Codex-led session gets a Claude one.

## Safety model

- By default delegates receive only the context you put in the prompt. Every built-in and MCP tool and every permission request is denied, configuration/instruction discovery is disabled, and each job gets a fresh empty working directory. The adapter verifies the runtime's actual tool set before sending context.
- Never a shell. Each capability exists only when the call grants it:
  - `files` ([scoped files](#scoped-files)): reads limited to named paths, writes staged in memory and applied only by the lead through `copilot_apply`.
  - `web: true` ([web reads](#web-reads)): GET-only reads of public pages and APIs; local and private-network addresses are refused; every fetch is logged.
  - `actions` ([named actions](#named-actions)): only commands the owner approved in a registry, by name, with arguments matching each entry's patterns, run without a shell.
- `sharingAuthorized: true` is required on every inference call. It is the orchestrator's attestation that the user or project permits sending that context to Copilot, not an independent policy check.
- At most two active jobs, 32 retained jobs, 512 events per job, a five-minute default deadline (15 minute maximum), and one supervised escalation per job.
- Opt-in recursive delegation (`copilot_orchestrate`) is bounded to eight nodes and depth three; its lead and children share the call's grants.

These are SDK-level restrictions, not an OS sandbox against a compromised SDK or runtime.

## Install

Requires Node 22+ and a GitHub Copilot subscription.

```sh
git clone https://github.com/dstkwll/copilot-counterpart.git
cd copilot-counterpart
npm ci --ignore-scripts
npm test
copilot login   # only if you are not already authenticated
```

Use `npm ci` without `--omit=optional`: the Copilot SDK ships its platform binary as an optional dependency. (pdf.js's optional native canvas is replaced by an empty stub through a package override, because text extraction doesn't need it.)

**Recommended: run a separate runtime copy.** Register the server from a copy, not your checkout, so editing source never changes a running host by accident:

```sh
scripts/install-local.sh            # default: ~/.local/share/copilot-counterpart
```

It refuses uncommitted changes, runs the tests, backs up the current copy (keeping two), installs locked dependencies, runs the tests in the copy, records provenance in `INSTALLATION.md` and `source-sha256.json`, and updates installed copies of the skill. Rerun it after every update, then start new host sessions. The commands below use `$PWD/src/server.mjs`; with a runtime copy, point them at `~/.local/share/copilot-counterpart/src/server.mjs` instead.

Register the server with each assistant using **absolute paths**. Registrations made before the rename may still use `COPILOT_SUPERVISOR_LEAD_FAMILY`, which is accepted as an alias. Set `COPILOT_COUNTERPART_LEAD_FAMILY` to the assistant's own model family so the router can pick a different family for reviews.

### Codex

```sh
codex mcp add copilot-counterpart \
  --env COPILOT_COUNTERPART_LEAD_FAMILY=openai \
  -- "$(command -v node)" "$PWD/src/server.mjs"
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.copilot-counterpart]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/copilot-counterpart/src/server.mjs"]
env = { COPILOT_COUNTERPART_LEAD_FAMILY = "openai" }
```

### Claude Code

```sh
claude mcp add copilot-counterpart --scope user \
  -e COPILOT_COUNTERPART_LEAD_FAMILY=anthropic \
  -- "$(command -v node)" "$PWD/src/server.mjs"
```

Each host starts its own server process. Jobs, request IDs and feedback are not shared between hosts.

### Skill (recommended)

[`skills/copilot-delegation`](skills/copilot-delegation/SKILL.md) tells the assistant when to delegate, how to supervise, and how to report receipts. It works for both hosts:

```sh
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s "$PWD/skills/copilot-delegation" ~/.codex/skills/copilot-delegation
ln -s "$PWD/skills/copilot-delegation" ~/.claude/skills/copilot-delegation
```

The skill defers to *your* sharing authorization. To let the assistant delegate without asking each time, state it in your own global instructions (`~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`). For example: "You may send task-relevant code and context to my authenticated GitHub Copilot service for reviews and delegations; never include secrets."

Start a new session after registering so the tools and skill are picked up. Already-running server processes keep the routing policy they loaded.

## Routing (policy v3)

`copilot_delegate` takes `requestId`, `role`, `task`, `context`, `acceptanceCriteria`, `sharingAuthorized: true`, and optional `complexity` (small/normal/complex), `risk` (low/high), `leadFamily` (`openai`/`anthropic`, overriding the server default), `parentJobId` and `timeoutSeconds`.

| Role | Claude lead (`anthropic`) | Codex lead (`openai`) | No lead configured |
| --- | --- | --- | --- |
| review | GPT-6.1 Sol high | Claude Opus 5.5 high | GPT-6.1 Sol high |
| correctness | GPT-6.1 Sol high | Claude Opus 5.5 high | GPT-6.1 Sol high |
| sparring, high-risk review | GPT-6 Astra high | Claude Opus 5.5 high | Claude Opus 5.5 high |
| analysis / code_proposal, small | GPT-6 Luna medium | same | same |
| analysis / code_proposal, normal | GPT-6.1 Sol medium | same | same |
| analysis / code_proposal, complex or high risk | GPT-6.1 Sol high | same | same |

- **Fallbacks.** Each route has its own ordered fallback list ([full table](docs/model-routing.md#routes)). Usually GPT-6.1 Sol falls back to GPT-6 Sol. Correctness and sparring also try the other family's strongest model, but Claude-led review does not. The route reports `fallback: true`, and `crossFamily: false` when it had to use the lead's own family. If nothing qualifies, it fails closed without starting inference. It never silently picks an older-generation model.
- **Escalation.** You can escalate a finished routed job once, with `parentJobId` and a fresh self-contained brief. Luna escalates to Sol, and Sol escalates to the ceiling for the lead: Astra for Claude, Opus 5.5 for Codex or no lead. Astra and Opus 5.5 can't be escalated further. Previous output isn't forwarded automatically, and cancelled or timed-out jobs can't be escalated.
- **No cost-based routing.** The router doesn't route on price. Plan pricing and allowances vary.

Job status includes the full `route`: model, effort, reason, lead family, cross-family flag and policy version. Model IDs live in one table in [`src/router.mjs`](src/router.mjs); see [model routing](docs/model-routing.md) for the rationale.

## Supervising a job

1. Dispatch with `copilot_delegate`, or with `copilot_start` and an explicit model from `copilot_models`. `copilot_start` bypasses routing but not the tool boundary, and it also requires `sharingAuthorized: true`. Steering is covered by the job's original attestation.
2. Collect the result with `copilot_wait(jobId, timeoutSeconds)`, which returns only status, result, usage and staged paths; call again if it returns `running`. To watch progress, poll `copilot_events(jobId, after, waitMs ≤ 30000)` instead. Keep `nextCursor` and drain `hasMore` before waiting again. A `gap` means older events were evicted; the latest complete message is still available as `result`.
3. Use `copilot_steer` for best-effort course corrections. It isn't idempotent and can't change tokens already generated. Use `copilot_cancel` to stop the job's dedicated runtime; nothing is rolled back.
4. For jobs with writable files, review `copilot_changes` and apply with `copilot_apply` only if the diff is right.
5. Verify findings against the evidence. Treat reviewer output as untrusted data. Record `copilot_feedback` (useful / unhelpful / inconclusive), then free memory with `copilot_forget`.

Request IDs deduplicate identical starts within one process. Routed request IDs stay reserved for the life of the process (up to 64).

## Scoped files

Pass `files` to `copilot_delegate` or `copilot_start`:

```json
"files": { "root": "/abs/path/to/repo", "read": ["src", "test/router.test.mjs"], "write": ["src/router.mjs"] }
```

- The delegate gets `workspace_read`, `workspace_list` and `workspace_search`, plus `workspace_write` and `workspace_edit` only when `write` is non-empty. They are custom tools; built-in file tools stay denied.
- **Reads** are limited to the `read` paths (directories recursively) and the `write` files: UTF-8 text, plus the extracted text of `.pdf` (via pdf.js, without fonts, eval or rendering) and `.docx` files (each extraction runs in a worker thread with a 512 MB heap limit and a 30-second deadline), which can be read and searched but not edited. Paths are resolved through symlinks and must stay inside `root`; files are opened without following symlinks, and hard-linked files are refused. Per-read, per-job and search size caps apply.
- **Sensitive paths are always refused**, even if granted, in any letter case: `.git`, `.ssh`, `.aws`, `.env*` (except `.example`/`.sample`/`.template`), keys and certificates, `.npmrc`/`.netrc`, `credentials*`, `secrets*`.
- **Writes are staged**, never written by the delegate. Only exact `write` files can be edited or created. When the job finishes, call `copilot_changes` for a unified diff and a `changeSetHash` computed from the same snapshot, review it, then call `copilot_apply` with that hash. Apply refuses before writing anything if a file changed on disk after the job read it, prepares every file before committing, re-checks each one just before replacing it, and if a commit still fails midway reports exactly which files were written. It runs once per job.
- Every access and refusal appears in the job's events as `supervisor.file_access`, and job status includes a `workspace` summary. File contents are stripped from the job's tool events, so polling events doesn't pull them into the lead's context.
- File contents you grant are sent to Copilot like any other context, so `sharingAuthorized` covers them too. Grant the smallest set the task needs. `copilot_orchestrate` takes `files` too: the lead and its children share one workspace, so all their staged edits form one diff. Design notes: [scoped files](docs/scoped-files.md).

Applying a reviewed diff is cheap for the lead: it reads the diff instead of writing the code, and apply needs no re-typing.

## Web reads

Pass `web: true` to `copilot_delegate`, `copilot_start` or `copilot_orchestrate`. The delegate gets `web_get(url, maxChars?, offset?)`, which returns extracted text: HTML is converted to text, PDFs are extracted, JSON and plain text are returned as is. Long responses page with `offset`.

- Any public host is allowed. Research is the main use, so there is no allowlist.
- GET only, no cookies or credentials, `http`/`https` only. Hostnames are resolved and refused if any address is loopback, private, link-local, carrier-grade NAT, multicast or reserved (IPv4 or IPv6, including IPv4 embedded in IPv6). The connection is pinned to the checked address, and every redirect is checked again.
- IPv6 counts as public only inside global unicast (`2000::/3`), excluding documentation, Teredo, 6to4 and ORCHID ranges; NAT64 and IPv4-mapped addresses are checked as IPv4.
- 4 MB per response, an absolute 20-second deadline covering redirects and the body, at most 4 fetches at once, 60 fetches and 40 MB per job counted as bytes arrive. Redirect bodies are never read, and fetches still running when the job ends are aborted. Every fetch and refusal is logged as `supervisor.web_access`.
- The remaining risk is a page that injects instructions into a delegate holding private context, which could then try to leak it through a URL. Every fetched URL is in the job log, so review it, and avoid combining `web: true` with sensitive file grants when a task doesn't need both.

## Named actions

The one exception to "no execution". The owner approves actions in `~/.config/copilot-counterpart/actions.json` (override with `COPILOT_COUNTERPART_ACTIONS`):

```json
{ "actions": { "render": {
  "description": "Render a résumé version to PDF",
  "command": "/abs/path/repo/tools/render.sh",
  "args": [{ "name": "version", "pattern": "^v[0-9]+$" }],
  "cwd": "/abs/path/repo", "timeoutSeconds": 120,
  "approved": "2026-11-15 by the owner in conversation" } } }
```

- A job lists the names it may use (`actions: ["render"]`), and the delegate calls `run_action({ name, args })`. It gets back the exit code and a capped tail of stdout and stderr.
- Argument patterns use a restricted syntax: `^`, then literals, escapes such as `\d` and `\.`, and `[character classes]`, each optionally quantified, then `$`. No groups or `|`, and at most three quantifiers, so a pattern always matches the whole argument and can't backtrack catastrophically. Arguments are at most 200 characters. The command runs without a shell, so nothing can be chained. Only a minimal environment is passed (`PATH`, `HOME`, locale and any names the entry lists).
- By default actions see files on disk, not a job's staged edits. An entry with `"allowStaged": true` can also run with `run_action({ name, args, staged: true })`. That run uses a temporary copy of `cwd` (APFS clones where available, `.git` skipped, at most 50,000 files) with the job's staged edits written in. The approved script runs from the copy after the same hash check, so scripts that locate files relative to themselves see the copy too. Files the run creates or changes are listed as `@runN/...` paths, which the delegate can read with `workspace_read`, for example to check a rendered PDF. The copy is deleted when the job ends, and real files are never touched. Approve `allowStaged` only for commands that are safe on delegate-written input.
- A script changed after the job started is refused. One action runs at a time, at most 20 per job.
- No write grant may ever cover the registry or a registered script. This is checked when the job starts and again just before `copilot_apply`. If the registry exists but can't be read or parsed, every write grant is refused until it is fixed. `copilot_actions` lists the registry. To add an entry, get the owner's approval, then edit the file with your own tools.

## Recursive delegation (opt-in)

Failed orchestration requests that never started a job free their request ID. `copilot_orchestrate` starts a lead session that may call `delegate_task`, plus any tools the call's grants provide; children get the same grants. Each child is routed by the same router, inheriting the outer `leadFamily`. Select the lead explicitly (e.g. `model: "gpt-6-astra"`) or let the router choose. Defaults are eight nodes including the lead, depth two (configurable 0–3), 100,000 observed tokens, 32 usage events and a 300-second outer deadline. Token and usage thresholds are **soft, post-paid stops**, not spend caps. See [recursive delegation](docs/recursive-delegation.md).

## Data and lifecycle

Only send context you are authorized to share; never send secrets. Opaque provider metadata and encrypted reasoning are filtered from returned events. This is not a general redaction service.

Jobs and events live in memory in one MCP process. A restart loses job IDs and deduplication, and graceful shutdown terminates the runtimes it owns. The SDK may persist sessions and logs under `~/.copilot`, and `copilot_forget` doesn't delete them. Token usage is aggregated from observed usage events; it isn't an invoice, and missing events don't prove zero consumption.

## Development

```sh
npm test                                     # offline, no inference
npm run smoke -- --live gpt-6-luna           # one synthetic inference
node scripts/live-controls.mjs --live        # steering and cancellation while streaming
node scripts/review-routing.mjs --live --synthetic
node scripts/probe-tree.mjs --live           # three-node recursive probe
```

Live scripts use synthetic context, consume Copilot allowance, and never run in CI. `review-routing.mjs --live` without `--synthetic` sends this repository's source to Copilot. Contributor and agent guidance is in [AGENTS.md](AGENTS.md).

## Credits

- [GitHub Copilot SDK](https://github.com/github/copilot-sdk): runtime lifecycle, authentication, sessions and event streaming.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): schema validation and stdio transport.
- Design references (no code copied): [copilot-plugin-cc](https://github.com/wagnersza/copilot-plugin-cc) job control and [copilot-sdk-proxy](https://github.com/theblixguy/copilot-sdk-proxy) streaming/model discovery.

## License

[MIT](LICENSE). Not affiliated with GitHub, OpenAI or Anthropic.
