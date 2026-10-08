# HANDOFF

_Baseline verified: main SHA `33026b16b27657544ec152e6611b644e386b6639`; exact-SHA CI run `37715608774` passed all six matrix jobs. PR #48 fixed root CLI option-value swallowing after exact-head and exact-main CI success._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `33026b16b27657544ec152e6611b644e386b6639`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37715608774` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #46 updated `@modelcontextprotocol/sdk` from locked `1.29.0` to `1.32.1`; exact-head run `37647956742` and merge-SHA run `37648701564` both passed 6/6, including production and full dependency audits.
- PR #39 merged the scoped Mission Control remediation after exact-head run `37424245809` passed 6/6; merge run `37425225414` also passed 6/6.
- PR #40 reconciled R20 to VERIFIED_CI across project state, status, and frontier. Its exact-head run `37427738806` and merge-SHA run `37428315441` both passed 6/6.
- PR #47 documentation merge `58cd43e43093cf8c0a7ee7d825e8b69f4dbc36c4` passed exact-main run `37714813520` 6/6. PR #48 product merge `33026b16b27657544ec152e6611b644e386b6639` passed exact-head run `37714944668` 6/6 and exact-main run `37715608774` 6/6. Managed isolation branches were not modified or removed.
- R16 remains BLOCKED pending explicit approval to install/use a real Podman engine. R17 remains EXTERNAL. All release gates remain closed.
- R20 is VERIFIED_CI: Vite 6.4.4 plus `source-map-js@^1.2.2`, local audit 0 vulnerabilities, and 12/12 visual screens pixel-identical. No Vite 8 upgrade was taken.
- This baseline is exact-main evidence only for the SHA above; every later revision needs its own exact-head and exact-main evidence.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37715608774` proves checks actually run on exact inspected main SHA `33026b16b27657544ec152e6611b644e386b6639`. PR #48 exact-head run `37714944668` passed all six jobs on `3dd88c04aacea1e74d1d04d0903e208a36f236bf`. Production and full dependency audit steps succeeded on exact-main Ubuntu/Node 22. Historical PR #46 exact-head run `37647956742` and post-merge run `37648701564` also passed 6/6. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live main, open PRs, branch refs, and exact-main CI before new edits. This handoff records baseline `33026b16b27657544ec152e6611b644e386b6639` with `37715608774` success 6/6; later revisions require fresh exact-SHA evidence. Discover and reproduce a NEW measurable correctness/DX issue, or prioritize a red CI/security regression if present. The prior CLI option-token case was resolved by PR #48; do not repeat it as an open candidate.

R16 requires explicit approval and real Podman evidence. R17 and all release gates remain closed. Keep managed active task isolation intact. No release, tag, publish, protection or secrets actions without explicit approval.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.

## NEXT_RUN_PROMPT

Resume the FolderForge council on `roronoazoroshao369/FolderForge`. Repository truth overrides this handoff. Inspect live main, open PRs, branch refs and exact-main CI before changes. Verified main `33026b16b27657544ec152e6611b644e386b6639`, run `37715608774` SUCCESS 6/6; PR #48 exact head `3dd88c04aacea1e74d1d04d0903e208a36f236bf`, run `37714944668` SUCCESS 6/6; fixed root CLI option-token swallowing. Documentation closeout must verify its own exact-head and merged-main CI before becoming the new baseline.

Select exactly one *new* goal and reproduce it first. Prioritize red exact-main CI, concrete safety risk, false platform claims, measurable correctness/DX. R16 real Podman remains BLOCKED until explicit approval; R17 and all external release gates remain closed. Do not tag, publish, release, change branch protection or secrets, retag/delete `v3.0.0`, or treat skipped Windows/Podman steps as passes. End with exact evidence, documented status, and a fresh handoff.
