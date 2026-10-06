# HANDOFF

_Baseline verified: main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6`; exact-SHA CI run `37408073201` passed all six matrix jobs. Require exact-head CI for this docs-only PR and recheck main after merge._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `d7d35f9d55a27d418ac9e5708aec3498680137b6`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37408073201` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #36 merged at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six matrix jobs; PR #37 later advanced main to the inspected base SHA.
- PR #35 was closed without merge after exact-head run `37400080019` failed; its handoff was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were also closed without merge after exact-head CI failures. Only this docs-only handoff remained open for exact-head verification; no dependency PRs remained open.
- R16 and R17 remain open. The separate Mission Control audit has 1 moderate and 2 high findings; do not claim all workspace audits are clean. A Vite 8 upgrade needs a compatible React Vite plugin and separate compatibility validation.
- The baseline run does not certify a later docs-only commit; require its exact-head CI before merge, then recheck live main by exact SHA.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37408073201` proves the checks that actually ran on exact inspected main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6`. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live `origin/main` and its exact-SHA CI before any further edits. This handoff records inspected base SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6` and green run `37408073201`; any docs-only PR must pass exact-head CI and then be checked against live main. Keep changes on a docs-only PR, run `npm run docs:check`, and merge only if exact-head CI is green and safe. PR #35 and the eight stale dependency PRs were closed unmerged after failed exact-head CI; no dependency updates were merged. R16/R17 and all release gates remain closed. R20 Mission Control audit findings need separate review; do not upgrade Vite to 8 without compatibility review. Do not infer Podman evidence from Docker success or routing mocks.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
