# CURRENT FRONTIER

_Last verified: 2026-10-06._

This frontier is derived from live git, GitHub Actions, and the current release contract. Repository evidence overrides historical roadmap text.

## P0 — Exact-main CI — RECHECK EACH LIVE REVISION

Inspected main SHA `d063bf74f5b8c8261400e86fcea6f8778a4f11e3` has green `ci.yml` run `37413497510` on that exact SHA. All six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. PR #36 previously passed exact-head run `37405842816`; PRs #37 and #38 advanced main to this inspected baseline.

PR #35 was closed without merge after exact-head run `37400080019` failed; its handoff was superseded by PR #37. The other eight open dependency PRs were also closed without merge because their exact-head CI had failures. Only this docs-only handoff remained open for exact-head verification; no dependency PRs remained open. Successful matrix jobs prove only steps that ran; skipped platform-specific checks are not evidence.

## P0 — Danger-mode containment — IMPLEMENTED, KEEP EVIDENCE-BOUND

Danger mode bypasses manual approval but not hard denies, authorization, path and Capsule containment, audit, rate limits, or terminal sandbox requirements. The terminal sandbox must fail closed unless Docker or Podman containment is actually active.

Current CI provides applicable Linux/Docker containment evidence. It does not establish Podman, macOS container-runtime, or Windows container-runtime parity.

## P1 — Reconcile governance documentation — BASELINE REFRESHED

PR #29 is merged. The verified main baseline is now recorded above; future commits must not self-attest their own CI or pretend the baseline SHA is their eventual merge SHA.

## P1 — Podman smoke selection — IMPLEMENTED AND MERGED

The child-MCP sandbox smoke previously hardcoded Docker when Podman was requested. The scoped fix now validates the existing selector and aligns generated config, prerequisites, and reported engine. Local verification and exact-head CI run `37278290277` passed. PR #30 merged at `27fc3e0aa7c79228f84a1f9b351c46c2af27713d`; match its main run `37279062422` and any subsequent documentation-only merge to live main before readiness claims.

Acceptance names the environment: Linux/Node 22 with Docker present and Podman absent must reject requested Podman without falling back to Docker. Real Docker smoke must still pass. Routing-only protocol mocks are not Podman containment evidence.

## P1 — Windows workflow claims — RECONCILED

PR #32 closed the false claim that every matrix job runs the full suite and package/stdio/HTTP smokes. The documented Windows contract is generated from `ci.yml` and locked by a regression test. No Windows gate was removed. Skipped Windows checks remain NOT_RUN.

## P1 — Real Podman and portability evidence — STILL OPEN

Run both child-MCP boundary smoke and terminal runtime tests in a real, explicitly recorded Podman deployment. Record exact SHA, runtime version, rootless/rootful mode, UID mappings, mounts, cgroups, command, exit code, and artifact. Docker success must not be reused as Podman proof. macOS/Windows VM mount semantics remain environment-specific.

## P1 — Mission Control dependency audit — REMEDIATED LOCALLY, EXACT-HEAD CI PENDING (R20)

The separate `packages/mission-control` audit reported 1 moderate and 2 high vulnerabilities: esbuild, source-map-js, and Vite. The remediation on branch `council/mission-control-audit-remediation` upgrades Vite 5.4.21 → 6.4.4 — the minimal major whose patched line (`<=6.4.2` affected) stays within the declared peer ranges of the locked `@vitejs/plugin-react` 4.7.0 (`^4.2 || ^5 || ^6 || ^7`) and `@tailwindcss/vite` 4.3.3 (`^5.2 || ^6 || ^7 || ^8`) — and adds a `source-map-js@^1.2.2` override. Vite 6 resolves esbuild `^0.25.0` (0.25.12 locked), clearing the esbuild dev-server advisory. Local evidence: `npm audit` in the package reports 0 vulnerabilities, `tsc --noEmit && vite build` passes, and the 12-screen visual regression suite is pixel-identical (0.000% diff) on the Vite 6 build. Vite 8 was not taken because the locked React plugin does not declare Vite 8 support; any future Vite 7/8 move requires its own compatibility review. R20 closes only after this PR's exact-head CI passes and merges.

Root production and full dependency audits are clear on inspected main SHA `d063bf74f5b8c8261400e86fcea6f8778a4f11e3`, exact run `37413497510`. Audit cleanliness is time-bound to the advisory database at run time. R16 and R17 remain open; no release gate changed.

## P2 — External release evidence

The following remain human-gated or external:

1. completed 24-hour soak on the eventual exact release SHA;
2. branch protection confirmation/change;
3. protected `npm-publish` environment;
4. Danger Mode human sign-off;
5. beta/design-partner evidence;
6. explicit approval for tag, npm publish, and GitHub Release.

Short soak smoke, sample-volume simulation, a green workflow definition, or a skipped step cannot satisfy these gates.

## Feature frontier after stabilization

Major product work resumes only after the release evidence frontier is explicit and no higher-priority containment or portability claim is false. Potential later work includes Mission Control and Fleet completeness, marketplace maturity, and distributed operation. New public surfaces require an approved proposal.

## Decision rule

Select one goal per run using this order: red exact-main CI, reproducible safety risk (including open audit R20), false supported-platform claim, measurable correctness/DX, release-decision documentation drift, then low-risk unblockers. Keep R16/R17 evidence and external release gates explicit; do not combine unrelated goals.
