# HANDOFF

_Last verified: 2026-10-06 against live main SHA `19b146f16b09c0a952a0251546a1a61c5fb22abe` and exact-SHA run `37319345745`._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Verified base main SHA: `19b146f16b09c0a952a0251546a1a61c5fb22abe`
- Package version: `3.0.1`
- Exact-SHA main CI: `ci.yml` run `37319345745` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs; skipped steps remain NOT_RUN.
- PR #34 (`docs: record branch protection audit`) is merged at that SHA. Its audit found `main` unprotected and no repository rulesets; R17 remains open and no settings changed.
- The Windows/Node 22 pinned third-party child-MCP check succeeded in run `37319345745`; R16 remains open. R11–R14 are fixed historically but were not re-proved in that run.
- Eight unrelated Dependabot PRs (#14, #15, #16, #18, #20, #21, #23, #27) were open at inspection.
- This is the verified base snapshot for a docs-only reconciliation; inspect any new PR head and eventual merge SHA independently.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.
5. For R15 or Windows-claim work, inspect `scripts/child-mcp-third-party.mjs`, `tests/unit/child-mcp-third-party.test.ts`, and the exact CI run/artifact.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37319345745` proves the jobs and steps that actually ran on exact main SHA `19b146f16b09c0a952a0251546a1a61c5fb22abe`. Do not cite skipped platform-specific steps as passes. The Windows/Node 22 third-party child-MCP check succeeded; the full-suite, package, stdio, HTTP, heartbeat, and Inspector checks skipped on Windows remain NOT_RUN. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Read NEXT_RUN_PROMPT in `docs/project/PROJECT_STATE.md`; inspect `git status`, fetch `origin/main`, inspect `gh run list`, and match CI to the exact live SHA. This handoff records the base snapshot only; a documentation PR's head and eventual main merge SHA need their own exact-SHA checks. R16 real Podman containment and R17 external release gates remain open. Do not reopen R19 unless the compatibility document and `ci.yml` diverge. Do not infer Podman evidence from Docker success or routing mocks. Select one evidence gap only; do not repeat the branch-protection audit without new evidence.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection remains unmet: PR #34 recorded HTTP 404 `Branch not protected` and no repository rulesets at `2026-10-05T13:34:32Z`; no settings were changed.
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.
