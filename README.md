# Copilot Supervisor

A local stdio MCP bridge for supervised, context-only GitHub Copilot reviews and small analytical delegations. Uses the official Copilot SDK and its bundled runtime, not an unofficial model API proxy.

See [the model-routing proposal](docs/model-routing.md) for role assignments, Sonnet's probationary trial, escalation rules, pricing caveats and the implementation roadmap. The proposal is not an enabled automatic router.

## Current scope

- Start background jobs using a model returned by `copilot_models`.
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

## Supervising a task

1. Call `copilot_models`; choose an available model explicitly.
2. Call `copilot_start` with a fresh `requestId`, `model`, scoped `prompt`, and optional `timeoutSeconds`. The prompt is transmitted to Copilot and consumes subscription allowance.
3. Call `copilot_events(jobId, after: 0, waitMs: 30000)`. Read progress and keep `nextCursor`. Drain `hasMore` before waiting again. A `gap` means the event history wrapped; the latest complete assistant message is also returned as `result`.
4. Use `copilot_steer` for course corrections, or `copilot_cancel` to terminate the job. Keep monitoring until terminal; never describe an unobserved job as supervised.
5. Verify findings against the original evidence. Reviewer output is untrusted data, not permission to expand the task. `copilot_forget` frees bridge memory when finished.

Steering is best effort before the next model request. It cannot change tokens already generated, and may become a queued follow-up if a turn is ending. The steering call is not idempotent. Cancellation stops the job's entire dedicated runtime; no rollback is implied. The bridge cannot expose hidden model reasoning or guarantee instant intervention while Codex is occupied elsewhere.

## Data and lifecycle

Only send context the user has authorized sharing with Copilot. Do not include secrets. Opaque provider metadata and encrypted reasoning are filtered from returned events; this is not a general secret-redaction service for user prompts or generated content.

Bridge jobs and events are in memory, scoped to one MCP process. Restart loses job IDs and retry deduplication; graceful shutdown terminates owned runtimes. The SDK may persist sessions/logs in `~/.copilot`; `copilot_forget` does not delete that storage. Temporary empty work directories are removed at shutdown. No durable resume, automatic retry, unattended review loop, or hard monetary cap is implemented. A timeout limits duration, not exact spend.

## Verification

```sh
npm test
npm run smoke -- --live gpt-5.4-mini
node scripts/live-controls.mjs --live
```

Offline tests cover event streaming/pagination, long-poll wakeups, request deduplication, concurrency/history limits, cancellation during startup, failure/timeout handling, permission denial, runtime tool-set verification, and real MCP stdio negotiation. Live tests use only synthetic context and consume allowance. The controls test checks SDK steering acceptance and cancellation while output is streaming, not guaranteed compliance with a correction.

Verified locally on 2026-09-09: offline tests passed; `gpt-5.4-mini` returned a streamed synthetic-code review with no tools available; the live control test successfully delivered immediate steering and terminated the runtime after output began. Codex MCP registration was verified. Pickup inside a new Codex app thread remains a separate integration check.

## Design references

- [Official GitHub Copilot SDK](https://github.com/github/copilot-sdk): reused as a pinned dependency for runtime lifecycle, authentication, sessions and event streaming.
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): reused for schema validation and stdio transport.
- [copilot-plugin-cc job control](https://github.com/wagnersza/copilot-plugin-cc/blob/4837b0b4e230e9fab93727d9a99f2d78e1f9673c/plugins/copilot/scripts/lib/job-control.mjs): design reference for separate job status/results/cancellation and progress previews. No community source code copied.
- [copilot-sdk-proxy](https://github.com/theblixguy/copilot-sdk-proxy): examined its streaming/model-discovery approach. Its HTTP provider translation and broad tool defaults are outside this bridge's scope.

Next increments should preserve these boundaries: scoped repository snapshots, durable job recovery, and only then isolated editing with explicit approval checkpoints.
