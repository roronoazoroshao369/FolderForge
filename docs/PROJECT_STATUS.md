# PROJECT STATUS

_Last verified against inspected main SHA `863306eb46a4609a1f065f746ed3b94e6be20535`; exact-SHA CI run `37648701564` passed all six matrix jobs. This is the verified baseline; later revisions require their own exact-SHA CI._

## Authoritative snapshot

- Repository: `/home/devops/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `863306eb46a4609a1f065f746ed3b94e6be20535`
- Package: `@musashishao/folderforge` `3.0.1`
- Exact-SHA main CI: `ci.yml` run `37648701564` completed **success** on that SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. Skipped steps are NOT_RUN, not passes.
- PR #36 merged normally at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six jobs; PR #37 later advanced main to the inspected SHA above.
- PR #35 was closed without merge; its exact-head run `37400080019` failed. Its proposed handoff was superseded by merged PR #37.
- Root production and full dependency audits passed in exact-main run `37648701564`. PR #46 moved the locked `@modelcontextprotocol/sdk` from `1.29.0` to `1.32.1` after GHSA-6qxp-vccf-f47h made the former baseline fail; exact-head run `37647956742` and merge-SHA run `37648701564` both passed 6/6. The separate `packages/mission-control` remediation (R20) remains VERIFIED_CI. No Vite 8 upgrade was taken.
- `v3.0.0` remains public and abandoned; never retag, delete, or publish it.
- `v3.0.1` is not tagged or published by this status update.

## Working tree and delivery state

PR #46 merged at main SHA `863306eb46a4609a1f065f746ed3b94e6be20535` after exact-head run `37647956742` passed all six jobs on `9d5753c000e0fc0cc0b2fe5f8d03b4edc6db087a`. Exact-main run `37648701564` passed all six jobs, including root production and full dependency audits. This restores the root audit baseline after the MCP SDK advisory drift.

PR #36 merged at main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226` after exact-head run `37405842816` passed all six matrix jobs. Exact-main run `37406501278` also passed all six jobs on that merge SHA. Root production and full dependency audits passed in both the PR-head and exact-main CI evidence.

PR #35 was closed unmerged after exact-head run `37400080019` failed; it was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were also closed without merge after their exact-head CI failed. PR #39 later merged the scoped Mission Control remediation after exact-head run `37424245809` passed; merge-SHA run `37425225414` also passed. No PRs were open at this run's discovery. Recheck live main before further work.

## Verification truth

Run `37406501278` is historical exact-SHA evidence for main `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. The latest inspected main SHA `863306eb46a4609a1f065f746ed3b94e6be20535` passed run `37648701564` on all six Ubuntu/macOS/Windows × Node 22/24 jobs, including root production and full dependency audits.

It does **not** turn skipped platform-specific steps into passes. Container-runtime isolation ran only where the workflow enabled it; Docker evidence is not macOS, Windows, or Podman evidence. Short runtime-soak checks and sample-volume gates are not a completed 24-hour soak.

Earlier local verification on the merged implementation branch reported clean typecheck, lint, architecture, docs, full verify, relevant third-party probe, and high-level audit. Current branch-local evidence is recorded in `docs/project/PROJECT_STATE.md` and must be refreshed for each new change.

## Security and policy consistency

Danger mode remains zero manual approval after hard denies. Authorization, workspace and Capsule containment, policy deny, audit, rate limits, and fail-closed terminal sandbox requirements still apply.

The root production and full dependency audits are clear on inspected main SHA `863306eb46a4609a1f065f746ed3b94e6be20535` (run `37648701564`); PR #46 restored this state by moving `@modelcontextprotocol/sdk` to `1.32.1`. This is not a claim that every package is vulnerability-free at all times. The separate `packages/mission-control` audit (formerly R20: 1 moderate esbuild, 2 high source-map-js/Vite) is VERIFIED_CI after PR #39 merged the minimal compatible major Vite 5.4.21 → 6.4.4 — all three Vite advisories end at `<=6.4.2`, Vite 6 ships esbuild `^0.25.0`, and the locked `@vitejs/plugin-react` 4.7.0 declares Vite 6 peer support — plus a `source-map-js@^1.2.2` override. Local `npm audit` in that package reports 0 vulnerabilities and the 12-screen visual regression suite passes pixel-identical on the Vite 6 build. No Vite 8 upgrade was made. Exact-head run `37424245809` and merge-SHA run `37425225414` both passed all six jobs. This is not production certification and does not waive the remaining human gates.

## Open release gates

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- Explicit approval for `v3.0.1` tag, npm publish, and GitHub Release
- Evidence review for any claimed Podman support

See `docs/CURRENT_FRONTIER.md` for the prioritized next goal and `docs/project/PROJECT_STATE.md` for per-run evidence.
