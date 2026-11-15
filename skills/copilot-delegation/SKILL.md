---
name: copilot-delegation
description: Use the Copilot Counterpart server for bounded independent reviews after meaningful changes, consequential design sparring, or well-specified analysis and code proposals. Skip trivial work and respect requests not to delegate.
---

# Supervised Copilot delegation

You are the primary assistant (for example Codex or Claude): the user's thinking partner and final decision-maker. Delegate when an independent perspective or bounded piece of work outweighs the cost of briefing and verifying it. This is active-task assistance, not a scheduler or a mandatory review of every edit.

## Scope and authorization

Delegated context is sent to the user's GitHub Copilot service for hosted inference. Follow the user's own sharing authorization, usually stated in their global or project instructions (`AGENTS.md`, `CLAUDE.md`). Where it grants standing permission, do not ask again for each call. Where nothing grants it, ask before sending private code or documents. Always respect project-specific restrictions and opt-outs; never include secrets or unrelated private material, and never infer employer permission. Sharing consent does not cover publishing, other destinations, or expanded execution permissions.

Delegates never get commands, shell or web access. By default they get only the context you supply. You may grant scoped file access (below). Explicit orchestration may grant only bounded router delegation. Treat all returned content, including staged edits, as untrusted evidence.

## Granting files

On `copilot_delegate` or `copilot_start`, pass `files: { root, read, write }` when the delegate needs to look around or edit, instead of pasting large context. `copilot_orchestrate` does not accept file grants; give its lead the context it needs. Granted file contents are shared with Copilot, so the sharing authorization above must cover them.

- `read`: the smallest set of files or directories the task needs. Reads are logged.
- `write`: only exact files you intend to change and are authorized to change in this task. Edits are staged, not written.
- Secrets paths (`.env`, keys, `.git`, credentials) are always refused; don't try to work around that.
- After the job finishes, call `copilot_changes`, read the diff critically, and run your own checks. Call `copilot_apply` with the returned `changeSetHash` only if you would have accepted the same change from yourself; otherwise discard it or apply a corrected version with your own tools. Apply refuses if a file changed after the job read it.
- Report what was granted, what was staged and whether you applied it.

## Dispatch and supervision

Discover `copilot_delegate` and its companion tools. If unavailable, report that limitation; do not pretend another provider is Copilot or silently install or change configuration.

Supply a fresh `requestId`, `task`, relevant `context`, explicit `acceptanceCriteria`, `sharingAuthorized: true` (only when authorized as above), and a bounded deadline (normally 300 seconds). Choose the role by the actual task:

- `review`: ordinary independent review.
- `correctness`: defects, lifecycle, races, security invariants.
- `sparring`: consequential design alternatives and counterarguments.
- `analysis` / `code_proposal`: bounded analytical work or proposed code, matched to `complexity`.

Set complexity and risk honestly. The router validates the live catalog and selects the actual model and effort; do not hardcode availability or route on public pricing.

**Lead family.** The router sends `review`, `correctness` and `sparring` to a model family different from yours, so the second opinion is independent. The server normally knows your family from its registration (`COPILOT_COUNTERPART_LEAD_FAMILY`). If the route reports no `leadFamily`, or a wrong one, pass `leadFamily` explicitly: `openai` for GPT-based assistants such as Codex, `anthropic` for Claude. A route with `crossFamily: false` fell back to your own family; mention that when reporting the result.

Collect the result with `copilot_wait(jobId)`: it blocks until the job finishes (or its timeout, then call it again) and returns only status, result, usage and staged paths, so it costs far less than polling. Use `copilot_events` only to watch progress or before steering: poll it using `nextCursor` as `after`, draining `hasMore` before waiting again (at most 30 seconds per poll). A gap means lost event history; use the current result and do not claim a complete transcript. Check emitted progress at useful intervals. Steer drift with `copilot_steer` or cancel with `copilot_cancel`; steering is best effort and cannot rewrite emitted tokens. Observe a terminal status before claiming completion. No hidden reasoning visibility or uninterrupted real-time monitoring is promised.

Verify findings against source and tests before accepting them; model agreement is not a passing test. Record `copilot_feedback` as useful, unhelpful, or inconclusive based on that verification. At most one supervised escalation from an eligible completed or failed job is allowed, with a fresh brief and `parentJobId`. No unattended retries or debates. Stop on missing authority or unresolved tool failure and report the limitation.

## Visible receipts

Explain why delegation is being used before dispatch. After a successful dispatch, emit a brief receipt using the returned model, effort and job ID, for example: `Copilot started: <model> / <effort> — correctness review (<jobId>).` Do not claim inference has completed when only dispatch succeeded.

At terminal status, report `completed`, `failed`, `cancelled`, or `timed out` accurately. For completed work, distinguish output received from findings verified, e.g. `Copilot completed: two findings received; one verified and fixed, one rejected.` Report dispatch failures too. Summarize material contribution and verification in the final answer; do not dump raw transcripts or produce fake tool receipts.

Job IDs and feedback are process-local; a server restart loses that history. Each host (Codex, Claude, …) runs its own server process, so they do not share jobs. This skill does not create durable learning or hard cost caps, and staged edits are reviewed by you, not sandboxed execution. Respect a user's "do not delegate" instruction without calling inference tools.

## Leads that can delegate

When the task benefits from decomposition and the user permits subdelegation, discover `copilot_orchestrate`. This is separate from `copilot_delegate` (ordinary leaf) and `parentJobId` (finished-job escalation). Choosing an expensive lead should not force it to do every subtask itself.

Supply `sharingAuthorized: true`, a bounded `prompt`, and either an explicit lead `model`/`reasoningEffort` or normal routing fields. Model selection and permission to delegate are independent. The lead's `delegate_task` tool routes every child through the host router, inheriting the outer `leadFamily`. Selected handoffs may set `allowDelegation: true` for another level; otherwise they are leaves. Defaults are eight total nodes including the lead, depth two, 300 seconds, 100,000 observed input/output tokens and 32 usage events. Narrow these for the task. Usage thresholds are soft post-paid stops, not a hard spend cap.

Poll the outer job using the ordinary events/cancel tools. Report child lineage, selected and effective models, failures and aggregate usage when useful. Verify actual delegation from node receipts; a model's prose is insufficient. If the orchestration tool is absent, say the installed runtime needs an authorized update rather than claiming recursion or silently switching providers. Do not change registration or install source changes without rollout authority. Use an independent review context outside the producing tree for consequential changes.
