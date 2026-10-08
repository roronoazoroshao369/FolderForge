# HANDOFF

_Product baseline verified: main SHA `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`; exact-SHA CI run `37720127758` passed all six matrix jobs. PR #50 fixed invalid root CLI policy fallback. This documentation revision must independently pass exact-head and post-merge CI._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37720127758` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #46 updated `@modelcontextprotocol/sdk` from locked `1.29.0` to `1.32.1`; exact-head run `37647956742` and merge-SHA run `37648701564` both passed 6/6, including production and full dependency audits.
- PR #39 merged the scoped Mission Control remediation after exact-head run `37424245809` passed 6/6; merge run `37425225414` also passed 6/6.
- PR #40 reconciled R20 to VERIFIED_CI across project state, status, and frontier. Its exact-head run `37427738806` and merge-SHA run `37428315441` both passed 6/6.
- PR #47 documentation merge `58cd43e43093cf8c0a7ee7d825e8b69f4dbc36c4` passed exact-main run `37714813520` 6/6. PR #48 product merge `33026b16b27657544ec152e6611b644e386b6639` passed exact-head run `37714944668` 6/6 and exact-main run `37715608774` 6/6. Managed isolation branches were not modified or removed.
- PR #50 exact head `1f70a77d3d59865652f03cedc5bf7b0d2e623d18` passed CI `37719460783` (6/6) and squash merged to main `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`; exact-main CI `37720127758` succeeded 6/6. Two regressions first failed on test-only head `0ed228e624e4005fcbf9979fbdd3eddcff4ef7c3` (CLI exited 0 instead of 1).
- Branch cleanup P0 is INCOMPLETE: 8 remote non-main branches at discovery; the local managed-isolation inventory is unavailable (MCP 404/429); no deletion performed. GitHub connector does not expose ref deletion. This docs PR creates a further temporary branch; re-inventory after merge.
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

Run `37720127758` proves checks actually run on exact inspected main SHA `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`. PR #50 exact-head run `37719460783` passed all six jobs on `1f70a77d3d59865652f03cedc5bf7b0d2e623d18`; historical PR #48 exact-head run `37714944668` passed all six jobs on `3dd88c04aacea1e74d1d04d0903e208a36f236bf`. Production and full dependency audit steps succeeded on exact-main Ubuntu/Node 22. Historical PR #46 exact-head run `37647956742` and post-merge run `37648701564` also passed 6/6. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live main, PRs, branch refs, and exact-main CI. Baseline `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`, run `37720127758` success 6/6 is for the PRODUCT merge only; documentation closeout must earn its own evidence. P0 branch cleanup remains blocked until managed isolation status and remote deletion access are available. Next, discover and reproduce one NEW Agent Loop/Mission Control reliability defect (especially resume/cancellation, duplicate runs, timeout, evidence). Do not claim a bug without direct reproduction.

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

Resume the FolderForge council on `roronoazoroshao369/FolderForge`. Repository truth overrides this handoff. Inspect live main, open PRs, branch refs and exact-main CI before changes. Verified product main `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`, run `37720127758` SUCCESS 6/6; PR #50 exact head `1f70a77d3d59865652f03cedc5bf7b0d2e623d18`, run `37719460783` SUCCESS 6/6; fixed invalid `--policy` fallback. Remote branch cleanup is BLOCKED pending managed isolation inventory and a branch-ref deletion capability. Documentation closeout must verify its own exact-head and merged-main CI before becoming the new baseline.

Select exactly one *new* goal and reproduce it first. Prioritize red exact-main CI, concrete safety risk, false platform claims, measurable correctness/DX. R16 real Podman remains BLOCKED until explicit approval; R17 and all external release gates remain closed. Do not tag, publish, release, change branch protection or secrets, retag/delete `v3.0.0`, or treat skipped Windows/Podman steps as passes. End with exact evidence, documented status, and a fresh handoff.
