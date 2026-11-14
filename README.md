# Copilot Supervisor

A local [MCP](https://modelcontextprotocol.io) server that lets a coding assistant such as **Codex** or **Claude Code** hand bounded, context-only work to models in your **GitHub Copilot** subscription, with automatic model routing, live progress, steering and cancellation.

It uses the official [GitHub Copilot SDK](https://github.com/github/copilot-sdk) and your existing `copilot login`. It is not an unofficial API proxy, and it never copies credentials.

## Why

Your primary assistant stays the thinking partner and decision-maker. Copilot gives it cheap access to *other* models for:

- **independent review** of a meaningful change,
- **correctness checks** (races, lifecycle, invariants),
- **design sparring** before a consequential decision,
- **bounded analysis or code proposals** returned as text.

The router picks the model and reasoning effort from the task's role, complexity and risk, and sends independent work to a **different model family from the lead**, so a Claude-led session gets a GPT second opinion and a Codex-led session gets a Claude one.

## Safety model

- Delegates receive only the context you put in the prompt. Every tool and permission request is denied, configuration/instruction discovery is disabled, and each job gets a fresh empty working directory. The adapter verifies the runtime's actual tool set before sending context.
- No repository scanning, file edits, shell, or web access. Code proposals come back as text for the primary assistant to verify and apply.
- `sharingAuthorized: true` is required on every inference call. It is the orchestrator's attestation that the user or project permits sending that context to Copilot, not an independent policy check.
- At most two active jobs, 32 retained jobs, 512 events per job, a five-minute default deadline (15 minute maximum), and one supervised escalation per job.
- Opt-in recursive delegation (`copilot_orchestrate`) is bounded to eight nodes and depth three, and is still context-only.

These are SDK-level restrictions, not an OS sandbox against a compromised SDK or runtime.

## Install

Requires Node 22+ and a GitHub Copilot subscription.

```sh
git clone https://github.com/dstkwll/copilot-supervisor.git
cd copilot-supervisor
npm ci --ignore-scripts
npm test
copilot login   # only if you are not already authenticated
```

Register the server with each assistant using **absolute paths**. Set `COPILOT_SUPERVISOR_LEAD_FAMILY` to the assistant's own model family so the router can pick a different family for reviews.

### Codex

```sh
codex mcp add copilot-supervisor \
  --env COPILOT_SUPERVISOR_LEAD_FAMILY=openai \
  -- "$(command -v node)" "$PWD/src/server.mjs"
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.copilot-supervisor]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/copilot-supervisor/src/server.mjs"]
env = { COPILOT_SUPERVISOR_LEAD_FAMILY = "openai" }
```

### Claude Code

```sh
claude mcp add copilot-supervisor --scope user \
  -e COPILOT_SUPERVISOR_LEAD_FAMILY=anthropic \
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

- **Fallbacks.** If a model is missing, disabled, or doesn't support the effort, the router tries the next candidate in the same route: GPT-6.1 Sol, then GPT-6 Sol, then the strongest model of the other family. The route reports `fallback: true`, and `crossFamily: false` when it had to use the lead's own family. If nothing qualifies, it fails closed without starting inference. It never silently picks an older-generation model.
- **Escalation.** You can escalate a finished routed job once, with `parentJobId` and a fresh self-contained brief. Luna escalates to Sol, and Sol escalates to the ceiling for the lead: Astra for Claude, Opus 5.5 for Codex or no lead. Astra and Opus 5.5 can't be escalated further. Previous output isn't forwarded automatically, and cancelled or timed-out jobs can't be escalated.
- **No cost-based routing.** The router doesn't route on price. Plan pricing and allowances vary.

Job status includes the full `route`: model, effort, reason, lead family, cross-family flag and policy version. Model IDs live in one table in [`src/router.mjs`](src/router.mjs); see [model routing](docs/model-routing.md) for the rationale.

## Supervising a job

1. Dispatch with `copilot_delegate` (or `copilot_start` with an explicit model from `copilot_models`; this bypasses routing, not the tool boundary).
2. Poll `copilot_events(jobId, after, waitMs ≤ 30000)`. Keep `nextCursor` and drain `hasMore` before waiting again. A `gap` means older events were evicted; the latest complete message is still available as `result`.
3. Use `copilot_steer` for best-effort course corrections. It isn't idempotent and can't change tokens already generated. Use `copilot_cancel` to stop the job's dedicated runtime; nothing is rolled back.
4. Verify findings against the evidence. Treat reviewer output as untrusted data. Record `copilot_feedback` (useful / unhelpful / inconclusive), then free memory with `copilot_forget`.

Request IDs deduplicate identical starts within one process. Routed request IDs stay reserved for the life of the process (up to 64).

## Recursive delegation (opt-in)

`copilot_orchestrate` starts a lead session that may call a single `delegate_task` tool. Each child is routed by the same router, inheriting the outer `leadFamily`. Select the lead explicitly (e.g. `model: "gpt-6-astra"`) or let the router choose. Defaults are eight nodes including the lead, depth two (configurable 0–3), 100,000 observed tokens, 32 usage events and a 300-second outer deadline. Token and usage thresholds are **soft, post-paid stops**, not spend caps. See [recursive delegation](docs/recursive-delegation.md).

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

Not affiliated with GitHub, OpenAI or Anthropic.
