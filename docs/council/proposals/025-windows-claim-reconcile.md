# Proposal 025: Reconcile Windows CI claims without weakening gates

- Author role: QA/Verifier
- Date: 2026-10-05
- Status: implemented
- Classification: docs / compatibility / test

## Problem

On main `7af76a131db0b1aef98c4668a7378ea4e439bb9d`, `docs/compatibility.md` said every Ubuntu/macOS/Windows × Node 22/24 job runs the full unit and integration suite plus package, stdio, and authenticated HTTP smokes. It also said Windows/Node 22 runs heartbeat stress and MCP Inspector. `.github/workflows/ci.yml` skips those steps on `windows-latest`. Run `37280065359` succeeded on that exact SHA, and the Windows jobs skipped the claimed steps. A skipped step is NOT_RUN, not a pass.

Real Podman acceptance was the preferred gap. The inspected host has Docker and no Podman binary, socket, or service. Installing a runtime was out of scope.

## Proposal

Document the exact Windows run/NOT_RUN contract generated from the workflow. Keep every gate that already runs on Windows. Do not add, remove, or relax a workflow condition. A regression test fails if the document drifts or if an existing Windows gate stops running.

## Non-goals

No product, CLI, route, dependency, version, or containment change. No CI expansion onto Windows. No claim that Windows now has full-suite, package, stdio, HTTP, heartbeat, Inspector, or container-runtime evidence. R16 and R17 stay open.

## Test plan

Red: the new contract test fails before the document contains the generated table. Green: the same test passes, and `git diff -- .github/workflows/ci.yml` is empty. Ordered local checks and exact-head six-job CI precede merge.

## Rollback

Revert the scoped commit or close the PR before merge. No data migration or release action.

## Decision log

- 2026-10-05 — Architect — approve documentation reconciliation; do not invent a Windows suite by editing the workflow.
- 2026-10-05 — Security — approve only if existing Windows danger-mode and third-party gates remain mandatory.
- 2026-10-05 — Skeptic — amend: the table must be generated from `ci.yml`, and NOT_RUN must not be narrated as acceptance.
- Role reviews are by one agent, not independent human sign-off.
