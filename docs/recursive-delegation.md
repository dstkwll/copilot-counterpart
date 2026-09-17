# Recursive Copilot delegation

Implemented and tested on 2026-09-16. Installed runtime rollout is separate.

## User-visible contract

A lead can divide work and call the same model router used by the outer assistant. Explicitly choosing Astra affects the lead only. Each handoff states task, context, acceptance criteria, role, complexity, risk, and whether that child may delegate. Child leads may repeat the process within the original limits. Leaves receive no tools.

The opt-in MCP entry is `copilot_orchestrate`. Existing leaf APIs remain available. Completion, cancellation, steering and event polling use the outer job ID. The source skill explains how an assistant selects this path; installing source changes alone does not update an already-running MCP server or installed skill.

## Native capability finding

A synthetic SDK 1.0.13 probe successfully invoked native `task`, ran a configured Luna child with no tools, and emitted subagent lifecycle/model/usage events. Native metadata also advertised built-in agent types and model overrides. Basic subagents therefore work, but that probe did not establish enforceable transitive routing/admission for our policy.

The implementation uses a single SDK custom `delegate_task` tool with a strict structured schema and ordinary SDK child sessions. This makes routing inputs and lineage explicit without overloading the native task prompt or depending on experimental subagent settings. It does not implement a model generation loop. Native task and all other tools are excluded; runtime metadata must match the exact grant before inference.

## Bounds and accounting

- Maximum eight total admitted nodes, including the root; failed admissions consume their reservation.
- Default depth two, configurable zero through three. Further delegation is individually granted and cannot expand the tree allowance.
- Waiting parents count as resident sessions. Immediate admission/rejection avoids a queue deadlock; two outer jobs can own at most sixteen sessions.
- Root deadline controls the entire tree. Cancel closes admission, stops all registered runtimes and joins cleanup, including late startup.
- Child routing uses the root request's catalog snapshot. Each owned runtime revalidates its chosen model/effort before inference. No separate catalog client is launched for routing a child.
- Child briefs and returned results are size-bounded. Parent transcripts are not automatically copied.
- Per-node effective-model evidence comes from usage events. Missing/mismatched evidence prevents accepted completion. An unexpected model can already have incurred usage before detection.
- Aggregate observed input/output counts and usage-event thresholds stop the tree after reporting; these are soft post-paid limits, not an exact invoice or hard monetary ceiling. No paid fallback setting changes.
- Cleanup failure retains outer capacity. Request deduplication and routing feedback remain process-local.

## Verification

Forty offline tests cover existing leaf behavior and MCP negotiation, authorization, model validation, recursive routing, individually denied recursion, admission/depth limits, duplicate calls, result truncation, model/usage failure, active-grandchild cancellation, late startup, failed first stop, blocked-send interruption and cleanup capacity.

Live MCP synthetic proof: Astra/high -> Luna/medium -> Luna/medium; the grandchild computed 17+25 and returned 42 through its parents. Requested and effective model receipts agreed at all three levels. The first successful run reported 2,633 input and 279 output tokens across five usage events. This arithmetic test demonstrates capability, not economic benefit.

A second synthetic run cancelled after the depth-two node was admitted. The outer job reported cancelled and could be forgotten only after confirmed cleanup. Reproduce with:

```sh
node scripts/probe-tree.mjs --live
node scripts/probe-tree.mjs --live --cancel
```

Both are explicitly live, capped at three sessions/150 seconds and excluded from default tests. Next evaluation should compare representative delegated work with a lead-only baseline, using quality, total usage, latency and repair effort. No savings conclusion yet.

## Copilot review disposition

Copilot Sol/high provided implementation advice and an independent correctness review. Advice on atomic admission, isolated SDK sessions and startup registration informed the implementation. A proposed hard prepaid spend cap was rejected because available SDK controls do not establish it.

All four correctness findings were verified and addressed:

1. Policy failures must actively stop the tree rather than merely emit an error and clear its deadline. Fixed with immediate idempotent tree close and a blocked-send regression.
2. Cancelling an already-terminal job must still stop/join its outstanding work. Fixed with a per-job cancellation promise and cleanup join.
3. A failed initial stop must not skip startup joining and the final stop attempt. Fixed with independent cleanup attempts and error aggregation.
4. Child catalog lookups must not outlive tree cleanup. Removed those external lookups: routing uses the root snapshot; runtime revalidation occurs inside each owned child runtime.

No raw provider/session transcripts, credentials or model reasoning are retained in this document.
