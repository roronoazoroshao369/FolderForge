# CURRENT FRONTIER

_Last verified: 2026-10-06 against live main SHA `19b146f16b09c0a952a0251546a1a61c5fb22abe` and exact-SHA run `37319345745`._

This frontier is derived from live git, GitHub Actions, and the current release contract. Repository evidence overrides historical roadmap text.

## P0 — Exact-main CI — RECHECK EACH LIVE REVISION

Verified main SHA `19b146f16b09c0a952a0251546a1a61c5fb22abe` has green `ci.yml` run `37319345745`. All six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. This proves only the steps that ran; skipped platform-specific checks are not evidence. The Windows/Node 22 pinned third-party child-MCP check succeeded in this exact-main run. A later documentation PR is not certified by this base run.

## P0 — Danger-mode containment — IMPLEMENTED, KEEP EVIDENCE-BOUND

Danger mode bypasses manual approval but not hard denies, authorization, path and Capsule containment, audit, rate limits, or terminal sandbox requirements. The terminal sandbox must fail closed unless Docker or Podman containment is actually active.

Current CI provides applicable Linux/Docker containment evidence. It does not establish Podman, macOS container-runtime, or Windows container-runtime parity.

## P1 — Reconcile release-state documents — DOCS-ONLY

This documentation-only goal refreshes the durable release snapshot against base main SHA `19b146f16b09c0a952a0251546a1a61c5fb22abe` and run `37319345745`, without changing product code, workflow gates, release settings, or external readiness. Its own PR head and any later merge SHA require separate exact-SHA CI evidence; this baseline does not certify them. `CHANGELOG.md` is intentionally unchanged because this goal ships no product/version change.

## P1 — Podman smoke selection — IMPLEMENTED AND MERGED

The child-MCP sandbox smoke previously hardcoded Docker when Podman was requested. The scoped fix now validates the existing selector and aligns generated config, prerequisites, and reported engine. Local verification and exact-head CI run `37278290277` passed. PR #30 merged at `27fc3e0aa7c79228f84a1f9b351c46c2af27713d`; match its main run `37279062422` and any subsequent documentation-only merge to live main before readiness claims.

Acceptance names the environment: Linux/Node 22 with Docker present and Podman absent must reject requested Podman without falling back to Docker. Real Docker smoke must still pass. Routing-only protocol mocks are not Podman containment evidence.

## P1 — Windows workflow claims — RECONCILED

PR #32 closed the false claim that every matrix job runs the full suite and package/stdio/HTTP smokes. The documented Windows contract is generated from `ci.yml` and locked by a regression test. No Windows gate was removed. Skipped Windows checks remain NOT_RUN.

## P1 — Real Podman and portability evidence — STILL OPEN

Run both child-MCP boundary smoke and terminal runtime tests in a real, explicitly recorded Podman deployment. Record exact SHA, runtime version, rootless/rootful mode, UID mappings, mounts, cgroups, command, exit code, and artifact. Docker success must not be reused as Podman proof. macOS/Windows VM mount semantics remain environment-specific.

## P2 — External release evidence

The following remain human-gated or external:

1. completed 24-hour soak on the eventual exact release SHA;
2. branch protection confirmation/change remains unmet: PR #34 recorded HTTP 404 `Branch not protected` and no repository rulesets at `2026-10-05T13:34:32Z`; no settings were changed;
3. protected `npm-publish` environment;
4. Danger Mode human sign-off;
5. beta/design-partner evidence;
6. explicit approval for tag, npm publish, and GitHub Release.

Short soak smoke, sample-volume simulation, a green workflow definition, or a skipped step cannot satisfy these gates.

## Feature frontier after stabilization

Major product work resumes only after the release evidence frontier is explicit and no higher-priority containment or portability claim is false. Potential later work includes Mission Control and Fleet completeness, marketplace maturity, and distributed operation. New public surfaces require an approved proposal.

## Decision rule

Select one goal per run using this order: red exact-main CI, reproducible safety risk, false supported-platform claim, measurable correctness/DX, release-decision documentation drift, then low-risk unblockers.
