# PROJECT STATUS

_Last verified against inspected main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6`; exact-SHA CI run `37408073201` passed all six matrix jobs. This is the verified baseline; later revisions require their own exact-SHA CI._

## Authoritative snapshot

- Repository: `/home/devops/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `d7d35f9d55a27d418ac9e5708aec3498680137b6`
- Package: `@musashishao/folderforge` `3.0.1`
- Exact-SHA main CI: `ci.yml` run `37408073201` completed **success** on that SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. Skipped steps are NOT_RUN, not passes.
- PR #36 merged normally at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six jobs; PR #37 later advanced main to the inspected SHA above.
- PR #35 was closed without merge; its exact-head run `37400080019` failed. Its proposed handoff was superseded by merged PR #37.
- Root production and full dependency audits passed in exact-main run `37408073201`. The separate `packages/mission-control` audit remains unresolved: 1 moderate and 2 high findings; the suggested Vite 8.3.2 fix is a major upgrade.
- `v3.0.0` remains public and abandoned; never retag, delete, or publish it.
- `v3.0.1` is not tagged or published by this status update.

## Working tree and delivery state

PR #36 merged at main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six matrix jobs. Exact-main run `37406501278` also passed all six jobs on that merge SHA. Root production and full dependency audits passed in both the PR-head and exact-main CI evidence.

PR #35 was closed unmerged after exact-head run `37400080019` failed; it was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were also closed without merge after their exact-head CI failed. Only this docs-only status handoff remained open for exact-head verification; no dependency upgrades were merged. PRs #28, #30, #36, and #37 are merged. Recheck live main before further work.

## Verification truth

Run `37406501278` is historical exact-SHA evidence for main `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. The latest inspected main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6` passed run `37408073201` on all six Ubuntu/macOS/Windows × Node 22/24 jobs, including root production and full dependency audits.

It does **not** turn skipped platform-specific steps into passes. Container-runtime isolation ran only where the workflow enabled it; Docker evidence is not macOS, Windows, or Podman evidence. Short runtime-soak checks and sample-volume gates are not a completed 24-hour soak.

Earlier local verification on the merged implementation branch reported clean typecheck, lint, architecture, docs, full verify, relevant third-party probe, and high-level audit. Current branch-local evidence is recorded in `docs/project/PROJECT_STATE.md` and must be refreshed for each new change.

## Security and policy consistency

Danger mode remains zero manual approval after hard denies. Authorization, workspace and Capsule containment, policy deny, audit, rate limits, and fail-closed terminal sandbox requirements still apply.

The root production and full dependency audits are clear on inspected main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6` (run `37408073201`); this is not a claim that every package is vulnerability-free. The separate `packages/mission-control` audit remains open as R20 with 1 moderate and 2 high findings (esbuild, source-map-js, and Vite). Its suggested Vite 8.3.2 remediation is a major upgrade: the lock currently has Vite 5.4.21 and `@vitejs/plugin-react` 4.7.0, whose declared peer range ends at Vite 7. A compatible plugin/toolchain migration and validation are required before upgrading. No Mission Control dependency changes were made. This is not production certification and does not waive the remaining human gates.

## Open release gates

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- Explicit approval for `v3.0.1` tag, npm publish, and GitHub Release
- Evidence review for any claimed Podman support

See `docs/CURRENT_FRONTIER.md` for the prioritized next goal and `docs/project/PROJECT_STATE.md` for per-run evidence.
