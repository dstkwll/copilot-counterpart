# Copilot Supervisor

A local stdio MCP bridge for supervised, context-only GitHub Copilot reviews and small analytical delegations. Uses the official Copilot SDK and its bundled runtime, not an unofficial model API proxy.

This is an **AI-maintained repository**. Agents handle routine implementation, tests, review, documentation and direct commits to `main`; the owner is involved only for missing authority or material risk/scope decisions. See [AGENTS.md](AGENTS.md) for the operating boundaries.

See [model routing](docs/model-routing.md) for role assignments, Sonnet's probationary trial, escalation rules and the roadmap. Automatic model/effort selection is implemented in `copilot_delegate`; it is triggered during an active assistant task, not by a background scheduler.

## Current scope

- Start background jobs using a model returned by `copilot_models`.
- Prefer `copilot_delegate` to select the model and reasoning effort automatically by role, complexity and risk. Routing explanations are included in job status. Model policy and effort support are checked before inference.
- Supply `sharingAuthorized: true` only when the user/project has authorized sending that context to Copilot. It is an attestation by the orchestrator, not independent employer-policy enforcement.
- One explicit escalation from a finished routed job is supported through `parentJobId`; there are no autonomous retries or debates. `copilot_feedback` records useful/unhelpful/inconclusive outcomes.
- Read streamed text and status through cursor-based `copilot_events` long polling.
- Send immediate steering messages and cancel a dedicated job runtime.
- Request IDs deduplicate identical starts for this process's retained history.
- Two active jobs maximum, 32 retained jobs, 512 events per job. Old event loss and truncation are reported. Defaults to a five-minute deadline; maximum 15 minutes.
- All delegate tools are disabled. The adapter checks the actual runtime tool set before sending context, denies every permission request and pre-tool call, disables configuration/instruction discovery, and uses a fresh temporary working directory.

The orchestrator supplies selected excerpts, diffs or requirements in `prompt`. No automatic repository scanning, file editing, commands, web access, nested agents, or permission-approval endpoint is exposed. Suggested fixes come back as text for the orchestrator to verify and apply within the user's authorization. These are SDK-level restrictions, not an OS sandbox against a compromised SDK/runtime.

## Setup

Requires Node 22+ and a Copilot subscription/login. Dependencies are pinned and locked:

```sh
npm ci --ignore-scripts
npm test
```

Use `copilot login` if authentication is missing. The SDK reuses local authentication; no credential is copied into this project. An authentication error inside a restricted execution sandbox can also indicate blocked network/keychain access.

Register the MCP server with an absolute Node executable and absolute path to `src/server.mjs`:

```sh
codex mcp add copilot-supervisor -- /absolute/path/to/node /absolute/path/to/copilot-supervisor/src/server.mjs
```

Open a new Codex thread to pick up the tools. Do not also install the plugin scaffold's MCP entry, which would create a second independent server/history. `.codex-plugin/plugin.json` is included for future plugin packaging; the initial installation uses direct local MCP registration.

On this machine the server is registered as `copilot-supervisor`, pointing to this source directory and the Node 24 executable. The companion `.mcp.json` also uses machine-local absolute paths; adjust them if moving the project. Updating files here updates the server on its next process start. Remove the registration with `codex mcp remove copilot-supervisor` if no longer wanted.

## Cross-session rollout

The source skill is [copilot-delegation](skills/copilot-delegation/SKILL.md). Install it into the user's Codex skills directory with the bundled skill-installer helper, using this private repository and `--path skills/copilot-delegation`. The installed copy is not automatically updated by git pulls; reinstall/update it deliberately after changes.

Local global `~/.codex/AGENTS.md` guidance tells sessions to consider this skill naturally for meaningful reviews, design sparring and bounded analytical work, honor opt-outs, and show actual start/terminal receipts. This is assistant guidance, not a deterministic hook or background scheduler. Fresh sessions are the acceptance target; existing tasks may need a new turn or restart to load changes. Other machines, accounts and cloud environments need their own setup.

Receipts are assistant commentary based on real tool responses, not server-rendered notifications. Completed inference is distinguished from independently verified findings. The primary assistant remains responsible for verification and authorized implementation.

Verified after the app restart on 2026-09-09: this Codex session discovered and successfully invoked the native supervisor MCP tools.

## Supervising a task

### Preferred: automatic routing

Call `copilot_delegate` with `requestId`, `role`, `task`, `context`, `acceptanceCriteria`, and `sharingAuthorized: true`. Optional `complexity` is small/normal/complex (default normal); `risk` is low/high (default low). Select role:

| Role | Normal starting model | Notes |
| --- | --- | --- |
| review | Sonnet 5 high (trial) | Sol after three trials or an unhelpful trial; high-risk review uses Opus |
| correctness | Sol high | Independent defect/invariant checking |
| sparring | Opus 5 high | Counterarguments and alternatives |
| analysis / code_proposal | Terra medium | Luna for small work, Sol high for complex/high-risk work |

Code proposals are returned as text, never executed. Unavailable/disabled models or unsupported effort cause a documented fallback within the same route, or fail closed. No pricing-based routing is performed. Catalog lookup errors do not trigger inference retries.

Poll events, verify the outcome, and call `copilot_feedback`. To escalate, call `copilot_delegate` with a fresh request ID, the completed/failed `parentJobId`, and a corrected self-contained task brief; previous output is not automatically forwarded. Cancelled and timed-out jobs cannot be escalated. The maximum chain is two jobs, and Opus is the ceiling.

Sonnet trial counts, negative-feedback disablement and routing retry records are process-local and reset on restart. This is not a durable learning system. Negative feedback disables further trials in that process; positive feedback never promotes the model automatically. Routed request IDs remain reserved for the process lifetime (maximum 64); forgetting the underlying job does not silently rerun it.

### Advanced: explicit model

1. Call `copilot_models`; choose an available model explicitly. This advanced path bypasses role selection, not the deny-all tool boundary.
2. Call `copilot_start` with a fresh `requestId`, `model`, scoped `prompt`, and optional `reasoningEffort` and `timeoutSeconds`. The prompt is transmitted to Copilot and consumes subscription allowance.
3. Call `copilot_events(jobId, after: 0, waitMs: 30000)`. Read progress and keep `nextCursor`. Drain `hasMore` before waiting again. A `gap` means the event history wrapped; the latest complete assistant message is also returned as `result`.
4. Use `copilot_steer` for course corrections, or `copilot_cancel` to terminate the job. Keep monitoring until terminal; never describe an unobserved job as supervised.
5. Verify findings against the original evidence. Reviewer output is untrusted data, not permission to expand the task. `copilot_forget` frees bridge memory when finished.

Steering is best effort before the next model request. It cannot change tokens already generated, and may become a queued follow-up if a turn is ending. The steering call is not idempotent. Cancellation stops the job's entire dedicated runtime; no rollback is implied. The bridge cannot expose hidden model reasoning or guarantee instant intervention while Codex is occupied elsewhere.

## Data and lifecycle

Only send context the user has authorized sharing with Copilot. Do not include secrets. Opaque provider metadata and encrypted reasoning are filtered from returned events; this is not a general secret-redaction service for user prompts or generated content.

Send only context the user or project has authorized for their Copilot service; omit secrets and honor project-specific restrictions.

Bridge jobs and events are in memory, scoped to one MCP process. Restart loses job IDs and retry deduplication; graceful shutdown terminates owned runtimes. The SDK may persist sessions/logs in `~/.copilot`; `copilot_forget` does not delete that storage. Temporary empty work directories are removed at shutdown. No durable resume, automatic retry, unattended review loop, or hard monetary cap is implemented. A timeout limits duration, not exact spend.

Job status aggregates observed input/output token usage events (not a complete invoice). Missing usage events do not prove zero consumption. No conversion of SDK cost fields into employer dollar charges is assumed.

## Verification

```sh
npm test
npm run smoke -- --live gpt-5.4-mini
node scripts/live-controls.mjs --live
node scripts/review-routing.mjs --live --synthetic
```

Offline tests cover event streaming/pagination, long-poll wakeups, request deduplication, concurrency/history limits, cancellation during startup, failure/timeout handling, permission denial, runtime tool-set verification, and real MCP stdio negotiation. Live tests use only synthetic context and consume allowance. The controls test checks SDK steering acceptance and cancellation while output is streaming, not guaranteed compliance with a correction.

Verified locally on 2026-09-09: offline tests passed; `gpt-5.4-mini` returned a streamed synthetic-code review with no tools available; the live control test successfully delivered immediate steering and terminated the runtime after output began. Codex MCP registration was verified. Pickup inside a new Codex app thread remains a separate integration check.

## Design references

- [Official GitHub Copilot SDK](https://github.com/github/copilot-sdk): reused as a pinned dependency for runtime lifecycle, authentication, sessions and event streaming.
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): reused for schema validation and stdio transport.
- [copilot-plugin-cc job control](https://github.com/wagnersza/copilot-plugin-cc/blob/4837b0b4e230e9fab93727d9a99f2d78e1f9673c/plugins/copilot/scripts/lib/job-control.mjs): design reference for separate job status/results/cancellation and progress previews. No community source code copied.
- [copilot-sdk-proxy](https://github.com/theblixguy/copilot-sdk-proxy): examined its streaming/model-discovery approach. Its HTTP provider translation and broad tool defaults are outside this bridge's scope.

The routed synthetic smoke test exercised the real stdio MCP path and automatically selected Sol high successfully on 2026-09-09. `scripts/review-routing.mjs --live` sends relevant repository source to Copilot; use `--synthetic` for a no-source smoke test.

A subsequent Sol-high source review completed and produced two confirmed lifecycle fixes; see [review disposition](docs/review-2026-09-09.md). Runtime slots now remain occupied until cleanup is confirmed, and failed cleanup cannot be forgotten to bypass the limit.

Next increments should preserve these boundaries: durable feedback/policy state, scoped repository snapshots, durable job recovery, and only then isolated editing with explicit approval checkpoints.
