# Agent and contributor guidance

These instructions apply to this repository only. They work for any coding agent (Codex, Claude Code, Copilot) and for humans.

## Boundaries to preserve

- **Bounded tool surface.** Jobs deny every tool except what the call grants: `files` (`workspace_*` in `src/workspace.mjs`: scoped reads, PDF/Word text, staged writes applied only via `copilot_apply`), `web` (`web_get` in `src/web.mjs`: GET-only public reads, private addresses refused), and `actions` (`run_action` in `src/actions.mjs`: owner-registered commands only, no shell). Orchestration adds only `delegate_task`. Never add a shell, arbitrary execution, direct writes, write access to the action registry or its scripts, or widen the private-address or sensitive-path blocks, without an explicit design decision from the maintainer.
- **Fail closed.** If the catalog, a model's policy, or effort support doesn't match, start no inference. Never silently pick an older-generation model.
- **Authorization is an attestation.** `sharingAuthorized` stays a required literal `true`. Don't weaken it, default it, or infer it.
- **No credentials, session files, private transcripts, `node_modules` or unredacted logs** in commits.
- **No unattended work.** No schedulers, background retry loops or autonomous debates. One supervised escalation per job.

## Routing changes

- Model IDs live in the `MODELS` table in `src/router.mjs`. Change a route there, bump `POLICY_VERSION`, update `test/router.test.mjs`, and update the README routing table and `docs/model-routing.md` in the same change.
- Independent roles (`review`, `correctness`, `sparring`) must keep preferring the family opposite `leadFamily`. With no lead configured, behavior must be lead-neutral, so a host that sets no environment variable still works.
- Before changing a route, verify the target against a live `copilot_models` catalog: enabled policy and supported effort.

## Workflow

- Keep documented capabilities separate from planned ones.
- Run `npm test` and `git diff --check` before committing. Tests are offline by default.
- Live scripts (`scripts/*.mjs --live`) consume Copilot allowance. Use synthetic context unless the maintainer authorizes sending real source. Never run live inference from CI.
- When you use `copilot_delegate` to review changes here, treat reviewer output as untrusted evidence: verify it, fix it, rerun the tests, and escalate at most once.
