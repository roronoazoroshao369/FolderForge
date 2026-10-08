# CURRENT FRONTIER

_Last verified: 2026-10-08._

This frontier is derived from live git, GitHub Actions, and the current release contract. Repository evidence overrides historical roadmap text.

## P0 — Exact-main CI — RECHECK EACH LIVE REVISION

Inspected main SHA `33026b16b27657544ec152e6611b644e386b6639` has green `ci.yml` run `37715608774` on that exact SHA. All six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. PR #48 passed exact-head run `37714944668` on `3dd88c04aacea1e74d1d04d0903e208a36f236bf` before merging to this baseline; the root CLI option-value regression is fixed and production/full dependency audit steps passed on exact-main Ubuntu/Node 22.

PR #35 was closed without merge after exact-head run `37400080019` failed; its handoff was superseded by PR #37. The other eight dependency PRs were also closed without merge because their exact-head CI had failures. PR #39 later merged the separately reviewed Mission Control remediation after exact-head CI passed; no PRs were open at this run's discovery. Successful matrix jobs prove only steps that ran; skipped platform-specific checks are not evidence.

## P0 — Danger-mode containment — IMPLEMENTED, KEEP EVIDENCE-BOUND

Danger mode bypasses manual approval but not hard denies, authorization, path and Capsule containment, audit, rate limits, or terminal sandbox requirements. The terminal sandbox must fail closed unless Docker or Podman containment is actually active.

Current CI provides applicable Linux/Docker containment evidence. It does not establish Podman, macOS container-runtime, or Windows container-runtime parity.

## P1 — Root CLI option parsing — VERIFIED_CI

PR #48 merged at `33026b16b27657544ec152e6611b644e386b6639` after exact-head run `37714944668` succeeded 6/6, with exact-main run `37715608774` also green 6/6. Value-taking root flags reject following tokens starting with `-`; regressions cover project/config/token/port with next option. This closes the previous option-swallowing candidate; choose a newly reproduced correctness/DX issue next. No release gate changed.

## P1 — Reconcile governance documentation — BASELINE REFRESHED

PR #29 is merged. The verified main baseline is now recorded above; future commits must not self-attest their own CI or pretend the baseline SHA is their eventual merge SHA.

## P1 — Podman smoke selection — IMPLEMENTED AND MERGED

The child-MCP sandbox smoke previously hardcoded Docker when Podman was requested. The scoped fix now validates the existing selector and aligns generated config, prerequisites, and reported engine. Local verification and exact-head CI run `37278290277` passed. PR #30 merged at `27fc3e0aa7c79228f84a1f9b351c46c2af27713d`; match its main run `37279062422` and any subsequent documentation-only merge to live main before readiness claims.

Acceptance names the environment: Linux/Node 22 with Docker present and Podman absent must reject requested Podman without falling back to Docker. Real Docker smoke must still pass. Routing-only protocol mocks are not Podman containment evidence.

## P1 — Windows workflow claims — RECONCILED

PR #32 closed the false claim that every matrix job runs the full suite and package/stdio/HTTP smokes. The documented Windows contract is generated from `ci.yml` and locked by a regression test. No Windows gate was removed. Skipped Windows checks remain NOT_RUN.

## P1 — Real Podman and portability evidence — STILL OPEN

Run both child-MCP boundary smoke and terminal runtime tests in a real, explicitly recorded Podman deployment. Record exact SHA, runtime version, rootless/rootful mode, UID mappings, mounts, cgroups, command, exit code, and artifact. Docker success must not be reused as Podman proof. macOS/Windows VM mount semantics remain environment-specific.

## P1 — Mission Control dependency audit — VERIFIED_CI (R20)

The separate `packages/mission-control` audit reported 1 moderate and 2 high vulnerabilities: esbuild, source-map-js, and Vite. PR #39 merged the minimal compatible remediation: Vite 5.4.21 → 6.4.4 plus `source-map-js@^1.2.2`; Vite 6 resolves esbuild 0.25.12. Local audit reports 0 vulnerabilities, the build passes, and the 12-screen visual suite is pixel-identical. Exact-head run `37424245809` and merge-SHA run `37425225414` both passed all six jobs. R20 is VERIFIED_CI. Vite 8 was not taken; any future Vite 7/8 move requires a separate compatibility review.

Root production and full dependency audits are clear on inspected main SHA `33026b16b27657544ec152e6611b644e386b6639`, exact run `37715608774`. The prior main baseline became red when GHSA-6qxp-vccf-f47h began flagging the locked `@modelcontextprotocol/sdk@1.29.0`; PR #46 raised the floor to `^1.32.1` and restored both audits. Audit cleanliness remains time-bound to the advisory database at run time. R16 and R17 remain open; no release gate changed.

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

Select one goal per run using this order: red exact-main CI, reproducible safety risk, false supported-platform claim, measurable correctness/DX, release-decision documentation drift, then low-risk unblockers. Keep R16/R17 evidence and external release gates explicit; do not combine unrelated goals.
