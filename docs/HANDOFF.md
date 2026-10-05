# HANDOFF

_Last verified: 2026-10-05._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Main SHA: `f9a6e32a6ab48db929682bc1662232021df5c96e`
- Package version: `3.0.1`
- Main CI: run `37272090032` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #28 is merged; the Windows/Node 22 pinned third-party child-MCP regression is fixed on main.
- Current council goal: reconcile stale project-state documents on branch `docs/reconcile-green-main`.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37272090032` proves the checks that actually ran on its exact SHA. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Resume the documentation reconciliation PR if it exists. Verify its exact head with local gates and `ci.yml`; merge only if every relevant gate is green. If it has already merged safely, confirm main and select the Podman/cross-platform sandbox evidence audit as the next single goal.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
