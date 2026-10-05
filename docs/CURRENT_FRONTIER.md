# CURRENT FRONTIER

_Last verified: 2026-10-05._

This frontier is derived from live git, GitHub Actions, and the current release contract. Repository evidence overrides historical roadmap text.

## P0 — Exact-main CI — CLOSED

Main SHA `f9a6e32a6ab48db929682bc1662232021df5c96e` has green `ci.yml` run `37272090032`. All six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully.

The Windows/Node 22 pinned third-party child-MCP regression is closed on main. Successful matrix jobs prove only the steps that ran; skipped platform-specific checks are not evidence.

## P0 — Danger-mode containment — IMPLEMENTED, KEEP EVIDENCE-BOUND

Danger mode bypasses manual approval but not hard denies, authorization, path and Capsule containment, audit, rate limits, or terminal sandbox requirements. The terminal sandbox must fail closed unless Docker or Podman containment is actually active.

Current CI provides applicable Linux/Docker containment evidence. It does not establish Podman, macOS container-runtime, or Windows container-runtime parity.

## P1 — Reconcile governance documentation — ACTIVE GOAL

Update `docs/project/PROJECT_STATE.md`, `docs/PROJECT_STATUS.md`, `docs/CURRENT_FRONTIER.md`, and `docs/HANDOFF.md` so they identify the green main SHA and run while preserving the evidence boundaries above.

Exit condition: the documentation-only PR passes local repository gates and exact-head CI, then merges normally without bypassing checks.

## P1 — Audit Podman and portability claims — NEXT CANDIDATE

After documentation reconciliation, compare every current Podman and cross-platform sandbox claim with executable tests and CI evidence. Select one reproducible gap and close it without adding a public tool, command, route, or MCP API.

A useful acceptance check must name the environment, command, exact SHA, exit code or run id, and artifact. Docker success must not be reused as Podman proof.

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

Select one goal per run using this order: red exact-main CI, reproducible safety risk, false supported-platform claim, measurable correctness/DX, release-decision documentation drift, then low-risk unblockers.
