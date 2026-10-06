# HANDOFF

_Baseline verified: main SHA `d063bf74f5b8c8261400e86fcea6f8778a4f11e3`; exact-SHA CI run `37413497510` passed all six matrix jobs. The R20 Mission Control audit remediation is on branch `council/mission-control-audit-remediation`; require its exact-head CI before merge and recheck main after merge._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `d063bf74f5b8c8261400e86fcea6f8778a4f11e3`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37413497510` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #36 merged at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six matrix jobs; PR #37 later advanced main to the inspected base SHA.
- PR #35 was closed without merge after exact-head run `37400080019` failed; its handoff was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were also closed without merge after exact-head CI failures. Only this docs-only handoff remained open for exact-head verification; no dependency PRs remained open.
- R16 and R17 remain open. The separate Mission Control audit (R20) is remediated on branch `council/mission-control-audit-remediation`: Vite 5.4.21 → 6.4.4 (compatible with the locked `@vitejs/plugin-react` 4.7.0 peer range) plus a `source-map-js@^1.2.2` override; local audit reports 0 vulnerabilities and the visual suite is pixel-identical. No Vite 8 upgrade was taken.
- The baseline run does not certify a later docs-only commit; require its exact-head CI before merge, then recheck live main by exact SHA.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37413497510` proves the checks that actually ran on exact inspected main SHA `d063bf74f5b8c8261400e86fcea6f8778a4f11e3`. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live `origin/main` and its exact-SHA CI before any further edits. This handoff records inspected base SHA `d063bf74f5b8c8261400e86fcea6f8778a4f11e3` and green run `37413497510`; the R20 PR must pass exact-head CI and then be checked against live main. Run `npm run docs:check` before opening any docs PR, and merge only if exact-head CI is green and safe. PR #35 and the eight stale dependency PRs were closed unmerged after failed exact-head CI. R16/R17 and all release gates remain closed. The R20 remediation used the Vite 6.4.4 minimal major, not Vite 8; any future Vite 7/8 migration still needs compatibility review. Do not infer Podman evidence from Docker success or routing mocks.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
