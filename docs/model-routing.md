# Model routing

Status: automatic model/effort selection implemented for context-only delegation. Triggered by an active orchestrator, not a background scheduler. Updated 2026-09-09.

## Objective

Keep Astra in Codex as the thinking partner, orchestrator, and final decision-maker. Use the work-funded Copilot subscription for bounded reviews, counterarguments, and eventually implementation. Optimize accepted work and reduced orchestration/repair effort, not simply price per generated token.

Send only context the user or project has authorized for their Copilot service; omit secrets and honor project-specific restrictions.

## Starting roles

| Role | Proposed model / effort | Escalation |
| --- | --- | --- |
| Intent, architecture synthesis, adjudication | Astra in Codex | Keep the user-facing relationship unchanged |
| Small deterministic work, fixtures, repetitive tests | Luna medium | Terra when behavior or context is ambiguous |
| Ordinary bounded implementation | Terra medium | Sol high for cross-cutting work or difficult debugging |
| Routine review trial | Sonnet 5 high | Sol high for correctness; Opus 5 for consequential design concerns |
| Correctness review and difficult invariants | Sol high | Astra verifies unresolved findings against evidence |
| Architecture sparring and alternative designs | Opus 5 high | One focused follow-up, then Astra adjudicates |
| Experimental inexpensive worker | MAI-Code-1.1-Flash | Compare against Luna before any promotion |

These are starting hypotheses, not measured model rankings. GitHub's [model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) supports the broad task categories, not superiority on this user's projects.

### Sonnet is explicitly probationary

The user has had poor experiences with Sonnet but is willing to try it initially. Do not treat its output as trusted or make it a required quality gate. Start with a few bounded, low-risk reviews; record useful findings, false positives, missed defects, and Astra's verification effort. Stop using it as a routine reviewer if its output creates more work than it saves. Use Sol or Opus when stronger evidence or a different perspective is needed. Do not claim the trial has happened yet.

## Orchestrator triggers

1. Before a consequential design decision, request one focused Opus challenge: strongest alternative, questionable assumptions, and evidence that would change the recommendation.
2. Delegate implementation only once requirements, allowed files, acceptance tests, and stop conditions are clear. Match the starting tier to complexity rather than always starting at the cheapest tier.
3. After a meaningful change passes its checks, request one independent review. Prefer a different provider when useful, without treating provider diversity as proof of independence.
4. After a failed repair or demonstrated misunderstanding, inspect the task brief and missing context, then escalate once. Do not loop through repeated speculative fixes.
5. Skip delegation for trivial changes where briefing and checking cost more than doing the task.

Give reviewers the requirements, diff, relevant context and test evidence, without a persuasive defense of the implementation. Require concrete findings, consequences and verification steps. Tests and evidence decide; model agreement is not a vote to approve.

Keep long polls bounded, review emitted progress at useful checkpoints, and cancel drift. No automatic deployments, pushes, destructive actions, privilege expansion, or unbounded reviewer debates.

## Availability snapshot

The authenticated SDK catalog on 2026-09-09 advertised:

- OpenAI: GPT-6 Astra; GPT-5.6 Sol, Terra and Luna; GPT-5.5; GPT-5.4 and 5.4 mini; GPT-5.3-Codex; GPT-5 mini.
- Anthropic: Claude Opus 5, 4.8, 4.7 and 4.6; Claude Sonnet 5; Claude Haiku 4.5.
- Other providers: MAI-Code-1.1-Flash, MAI-Code-1-Flash, Grok 4.5 and 4.6.
- Auto was available, but explicit routing is preferable when evaluating a model's contribution. An internal-only variant is deliberately excluded from the routing proposal.

Gemini 3.8 Flash was absent from this SDK catalog, despite appearing in GitHub's public model list. Do not assume it is selectable, or guess why it is absent. Refresh the catalog before dispatch and validate reasoning effort against the selected model's capabilities. Catalog visibility is not a successful inference test of every model.

## Pricing and budget uncertainty

Plan pricing and allowances vary by account. Do not optimize Sol routing around public prices or equate those prices with what an account is charged. Prioritize quality, latency, and reduced supervision/repair work; retain bounded usage and policy controls.

Rechecked GitHub's [published Copilot pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) on 2026-09-09:

| Model | Standard-context input / output USD per million tokens |
| --- | --- |
| Luna | 0.20 / 1.20 |
| MAI-Code-1.1-Flash | 0.20 / 1.20 |
| Sonnet 5 | 2.00 / 10.00 |
| Terra | 2.00 / 12.00 |
| Sol | 4.00 / 20.00 |
| Opus 5 | 5.00 / 25.00 |

Cache read/write rates and long-context rates are separate. Sol's published cached-input rate is 0.40 per million tokens. Business/Enterprise AI-credit allowances are pooled; legacy annual individual plans differ. No claim is made about which arrangement applies here. SDK usage fields must have their units validated before being presented as dollar spend.

## Current implementation versus next increments

Implemented: authenticated SDK access, role/model selection with availability fallback, validated reasoning-effort propagation, structured task briefs, context-only reviews/proposals, streaming events, steering, cancellation, deny-all tool policy, timeouts, bounded concurrency/history, one supervised escalation and process-local feedback. Token usage is aggregated without assuming internal billing rates.

Sonnet trial is capped at three dispatches per process. One unhelpful review disables it for that process; helpful feedback does not promote it. These counters reset on server restart; durable evaluation remains planned. Code proposals do not edit or execute files.

Not implemented:

1. Durable project eligibility policy and explicit allowance/budget settings. Current authorization is a required orchestrator attestation, not an independent policy lookup.
2. Machine-validated findings (currently requested sections in the prompt, not guaranteed output schema).
3. Durable outcome and usage tracking, with no stored secrets or raw private transcripts.
4. Scoped repository snapshots, then isolated editing worktrees and approval checkpoints.
5. Measured routing adjustments based on accepted patches, useful findings, false positives, repair effort, latency and consumption.

Start with reviews, sparring and code proposals. Actual implementation remains proposed until file isolation and verification are ready. Automatic routing does not grant additional tool permissions. A real MCP Sol-high synthetic test has succeeded.
