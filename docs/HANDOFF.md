# HANDOFF

_Last verified: 2026-10-05._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Pre-goal verified main baseline SHA: `aa8c5e97683ccde5b2a8aefac4b99b21c0fd08ed`
- Package version: `3.0.1`
- Baseline main CI: run `37275833749` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #28 is merged; the Windows/Node 22 pinned third-party child-MCP regression is fixed on main.
- PR #29 and implementation PR #30 are merged. R18 is fixed. PR #30 head/run: `816a98aedd55538d8315036b1c6ada486a754bd6` / `37278290277` (six jobs success). Implementation merge/run: `27fc3e0aa7c79228f84a1f9b351c46c2af27713d` / `37279062422` (check live). A documentation-only follow-up may advance main.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37275833749` proves the checks that actually ran on its exact SHA. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Read the post-merge update and NEXT_RUN_PROMPT in `docs/project/PROJECT_STATE.md`; match live main to its exact run, then select one remaining evidence gap. R16 real Podman containment, R17 external release gates, and R19 Windows compatibility-document drift remain open. Do not replay the completed R18 smoke-selector fix or infer Podman evidence from its mocked routing tests.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
