# HANDOFF

_Last verified: 2026-10-06T03:01:57Z._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Live main SHA: `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37406501278` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #36 merged normally at this SHA after exact-head run `37405842816` passed all six matrix jobs; root production and full dependency audits passed.
- PR #35 remains open and unmerged at `74db9c298943482093b2a2aaef63ff8b4b466545`; exact-head run `37400080019` failed. Do not merge it.
- R16 and R17 remain open. The separate Mission Control audit has 1 moderate and 2 high findings; do not claim all workspace audits are clean. A Vite 8 upgrade needs a compatible React Vite plugin and separate compatibility validation.
- A later documentation handoff is not certified by this run; recheck live main and exact-SHA CI.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37406501278` proves the checks that actually ran on exact main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live `origin/main` and its exact-SHA CI before any further edits. This handoff records main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` and green run `37406501278`; a later docs-only commit is not certified by that run. Keep documentation changes on a docs-only branch/PR, run `npm run docs:check`, and wait for exact-head CI before merging. PR #35 remains open with failed run `37400080019`; do not merge it. R16/R17 and all release gates remain closed. R20 Mission Control audit findings need separate review; do not upgrade Vite to 8 without compatibility review. Do not infer Podman evidence from Docker success or routing mocks.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
