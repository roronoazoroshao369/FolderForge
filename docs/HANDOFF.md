# HANDOFF

_Baseline verified: main SHA `d51fc61b31fe439cd7e7297fdb985bfb8fd4757b`; exact-SHA CI run `37428315441` passed all six matrix jobs. R20 is VERIFIED_CI after PR #39 and the follow-up documentation reconciliation in PR #40._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `d51fc61b31fe439cd7e7297fdb985bfb8fd4757b`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37428315441` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #39 merged the scoped Mission Control remediation after exact-head run `37424245809` passed 6/6; merge run `37425225414` also passed 6/6.
- PR #40 reconciled R20 to VERIFIED_CI across project state, status, and frontier. Its exact-head run `37427738806` and merge-SHA run `37428315441` both passed 6/6.
- No PRs were open at this run's discovery. The two managed isolations remain active and source-dirty and must not be modified or removed.
- R16 remains BLOCKED pending explicit approval to install/use a real Podman engine. R17 remains EXTERNAL. All release gates remain closed.
- R20 is VERIFIED_CI: Vite 6.4.4 plus `source-map-js@^1.2.2`, local audit 0 vulnerabilities, and 12/12 visual screens pixel-identical. No Vite 8 upgrade was taken.
- This baseline does not self-certify the current handoff-only branch; require exact-head CI before merge, then recheck live main by exact SHA.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37428315441` proves the checks that actually ran on exact inspected main SHA `d51fc61b31fe439cd7e7297fdb985bfb8fd4757b`. PR #40 exact-head run `37427738806` also passed all six jobs on `fcef2d6fdc532540968fa567f3cc692a2022cbe6`. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live `origin/main`, open PRs, and exact-SHA CI before any further edit. This handoff records inspected base SHA `d51fc61b31fe439cd7e7297fdb985bfb8fd4757b` and green run `37428315441`; any later revision requires its own exact-SHA evidence. If main CI is green, select one evidence-backed correctness/DX goal. R16 may proceed only after explicit user approval to install or provide a real Podman engine. R17 and every release gate remain closed. Do not infer Podman evidence from Docker success or routing mocks. Do not begin Vite 7/8 migration without a separate compatibility review.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.

## NEXT_RUN_PROMPT

Resume the FolderForge perpetual council on `roronoazoroshao369/FolderForge`. Repository truth overrides this handoff. Inspect clean status, fetch `origin/main`, list open PRs, and match CI to the exact live SHA before any edit. The recorded baseline is main `d51fc61b31fe439cd7e7297fdb985bfb8fd4757b`, run `37428315441` success 6/6; R20 is VERIFIED_CI. Preserve both managed active/source-dirty isolations.

Select exactly one goal. Fix red exact-main CI first. Otherwise, R16 remains BLOCKED until the user explicitly approves a real Podman engine; if approval is absent, discover a measurable correctness/DX item. Keep R17 and all release gates closed. Do not tag, publish, release, alter branch protection or secrets, retag/delete `v3.0.0`, or begin Vite 7/8 migration without a separate compatibility review. End with a verdict, evidence table, and a fresh NEXT_RUN_PROMPT.
