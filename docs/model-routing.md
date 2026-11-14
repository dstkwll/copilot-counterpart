# Model routing

Policy version 3. The router is in [`src/router.mjs`](../src/router.mjs).

## Principles

1. **The primary assistant stays in charge.** Codex, Claude or another host does the synthesis, adjudication and final decisions. Copilot models provide bounded second opinions and proposals.
2. **Independence comes from a different model family.** A reviewer from the lead's own family tends to share its blind spots. `review`, `correctness` and `sparring` therefore prefer the family opposite `leadFamily`. Provider diversity is a heuristic, not proof of independence; tests and evidence still decide.
3. **Workers aren't reviewers.** `analysis` and `code_proposal` produce work for the lead to verify. They route on capability and cost, whoever leads.
4. **Fail closed, report fallbacks.** Every route is an ordered candidate list. The first enabled model that supports the required effort wins. `fallback` and `crossFamily` make degradation visible. No candidate means no inference.
5. **No price-based routing.** Plan pricing, discounts and allowances differ by account, so routes optimize quality, latency and the lead's repair effort.

## Lead family

`leadFamily` is `openai` (e.g. Codex) or `anthropic` (e.g. Claude). It's resolved per call in this order:

1. The `leadFamily` argument on `copilot_delegate` or `copilot_orchestrate`.
2. The server's `COPILOT_COUNTERPART_LEAD_FAMILY` environment variable, set at registration. Unknown values are ignored with a warning on stderr.
3. Otherwise unset. The router then uses its lead-neutral table.

Children inside a `copilot_orchestrate` tree inherit the outer call's lead family. The family is set by registration rather than by the explicitly chosen tree lead, because the outer assistant is the one that adjudicates the results.

## Routes

| Role | anthropic lead | openai lead | unset |
| --- | --- | --- | --- |
| review | Sol → Sol (prev) | Opus → Sol → Sol (prev) | Sol → Sol (prev) |
| correctness | Sol → Sol (prev) → Astra | Opus → Sol → Sol (prev) | Sol → Sol (prev) → Opus |
| sparring / high-risk review | Astra → Sol → Sol (prev) | Opus → Sol → Sol (prev) | Opus → Sol → Sol (prev) |
| analysis / code_proposal, complex or high risk | Sol → Sol (prev) | same | same |
| analysis / code_proposal, normal (medium effort) | Sol → Sol (prev) | same | same |
| analysis / code_proposal, small (medium effort) | Luna → Sol → Sol (prev) | same | same |

In this table Sol is `gpt-6.1-sol`, Sol (prev) is `gpt-6-sol`, Luna is `gpt-6-luna`, Astra is `gpt-6-astra` and Opus is `claude-opus-5.5`. Effort is high unless the table says otherwise.

**Escalation** (`parentJobId`, once per job): Luna escalates to Sol, then to the ceiling. Sol escalates straight to the ceiling. The ceiling is Astra for an anthropic lead and Opus 5.5 otherwise. A job that already ran on Astra or Opus 5.5 can't be escalated; the lead adjudicates.

## Changes from policy v2

- Added lead-family routing (`leadFamily` argument and `COPILOT_COUNTERPART_LEAD_FAMILY`), plus `leadFamily` and `crossFamily` fields on the route.
- Sol tier moved to `gpt-6.1-sol`, with `gpt-6-sol` as a fallback.
- Removed the probationary Sonnet review trial and its process-local trial counters. Review now goes to the opposite family.
- Claude-led sparring uses GPT-6 Astra high. The escalation ceiling depends on the lead.

## Known limits and next steps

- Feedback is recorded per process and doesn't change routing. A future step is durable outcome tracking (useful findings, false positives, repair effort, latency) to tune routes with evidence.
- Findings come back as requested prose sections, not a validated schema.
- Not implemented yet: scoped repository snapshots, isolated editing worktrees and approval checkpoints.
- Model availability changes over time. Re-check `copilot_models` before changing the table.
