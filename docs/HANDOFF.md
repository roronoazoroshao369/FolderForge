# HANDOFF

_Last verified: 2026-10-05._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Verified main SHA: `3b1889e42cd236d80fd57f3cb6521ccc7700ef84`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37287594297` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #32 is merged. Head/run: `bda17ce160e93587043f5b95c814b0a3f0f0373e` / `37286780402`. R19 is fixed as a documentation contract, not as Windows full-suite evidence.
- R16 and R17 remain open. A documentation handoff after this SHA must be inspected live.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37287594297` proves the checks that actually ran on its exact SHA. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Read NEXT_RUN_PROMPT in `docs/project/PROJECT_STATE.md`; match live main to its exact run, then select one remaining evidence gap. R16 real Podman containment and R17 external release gates remain open. Do not reopen R19 unless the compatibility document and `ci.yml` diverge. Do not infer Podman evidence from Docker success or routing mocks.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
