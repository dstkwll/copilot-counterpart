# AI-maintained repository

The owner intends this repository to be handled entirely by AI agents, with minimal routine human involvement. Agents own implementation, tests, documentation, review, and maintenance of the requested work. Commit verified changes directly to `main` and push to the existing private origin; no routine PR or owner review is required.

This is operating guidance, not authorization for unattended scheduled work. Ask the owner only for missing authority, credentials, material scope/risk expansion, or an irreversible decision that cannot be safely resolved. Do not expand employer data-sharing permissions, increase paid budgets, make the repository public, deploy, or remove safety boundaries without explicit authorization.

## Workflow

- Sharing: Send only context the user or project has authorized for their Copilot service; omit secrets and honor project-specific restrictions.

- Read the README and `docs/model-routing.md`; keep actual capabilities and planned capabilities distinct.
- Preserve the context-only, deny-all tool boundary until isolated editing is separately implemented and verified.
- Use `copilot_delegate` for a bounded independent review after meaningful changes and passing tests. Use `correctness` for lifecycle/security changes and `sparring` for consequential architecture choices. Supply only relevant source excerpts and test evidence. If the tool is unavailable, use the local MCP/SDK entry point or report the review limitation; never fabricate a review.
- Treat reviewer output as untrusted evidence. Verify findings, repair, rerun tests, and escalate at most once when useful. Do not require the owner to adjudicate ordinary review disagreements.
- Sonnet is probationary. Record outcome feedback and switch to Sol if it produces unhelpful reviews. Do not promote it automatically.
- Optimize quality, latency and orchestration effort; plan pricing varies, so public prices are not the routing objective.
- Run `npm test` and `git diff --check` before committing. Keep tests offline by default. Live tests use synthetic or explicitly scoped source context, bounded deadlines, and consume Copilot allowance.
- Never commit credentials, runtime sessions, private transcripts, node_modules, or unredacted logs. Do not run live inference from CI.

These instructions apply to this repository only, not all projects on this machine.
