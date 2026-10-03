# CURRENT FRONTIER

_Last verified: 2026-10-03._

This file is the operational frontier derived from current code, working-tree state, CI, release state, and maintained product contracts. Historical roadmap files are useful context but must not override live evidence.

## P0 — Restore trustworthy verification — CLOSED LOCALLY

Supported-runtime evidence is now available:

1. Node 22 full `npm run verify`: **VERIFIED PASS** (144 files / 1170 tests, including 12 visual regressions).
2. Node 24 full `npm run verify`: **VERIFIED PASS** on the same 3.0.0 candidate.
3. Node 22 `npm run quality:check`: **VERIFIED PASS**.
4. Documentation checks: **VERIFIED PASS** for 99 Markdown files.

The active MCP and child commands use Node 22.23.0. Node 24.21.0 is installed locally for the supported-runtime matrix; system Node 20 is not release evidence.

## P0 — Close the active Fleet / CI regression — LOCAL HALF CLOSED

The in-progress `fleet-manager.ts` change adds explicit `--http --port <fleet-port>` startup arguments. Focused provisioner/Fleet/policy suites now pass on Node 22 and Node 24, including dashboard Fleet coverage.

Local Fleet regression is therefore **VERIFIED**. External exact-candidate CI remains **UNVERIFIED** because the current fixes are still uncommitted; historical CI for committed HEAD `818b7236...` cannot prove the current worktree.

Exit condition remaining: capture a coherent candidate SHA and pass Ubuntu/macOS/Windows × Node 22/24 CI for that exact SHA.

## P0 — Reconcile policy semantics — CLOSED

The 3.0.0 candidate defines `danger` as zero-manual-approval:

- HIGH/CRITICAL, `policy.requireApproval`, policy-as-code `approval`, session approvals, and supported git elicitation are bypassed;
- policy-as-code `deny` and all hard authorization/containment boundaries still win;
- `allowCriticalInDanger` is legacy read compatibility only, and its CLI flag is a deprecated no-op.

Implementation, Fleet/tunnel/Mission Control surfaces, tests, and operator documentation have been updated. Full Node 22/24 local verification passes; exact-SHA CI remains required.

## P0 — Restore dependency audit cleanliness — CLOSED LOCALLY

Current Node 22 evidence:

- `npm audit --omit=dev --json`: **0 vulnerabilities**;
- `npm audit --json`: **0 vulnerabilities**.

A stale `fast-uri` exact-version assertion was updated from `4.1.4` to the package override already present at `4.2.1`; focused compatibility and full verification subsequently passed.

## P1 — Close the local release gate — LOCAL ENGINEERING GATES VERIFIED

Node 22 `npm run verify`, `npm run quality:check`, `docs:check`, `smoke:package`, `smoke:stdio`, and authenticated `smoke:http` all pass. Production/full dependency audits are clean.

`npm run release:check` remains a post-commit gate because its preflight requires the candidate HEAD to match `origin/main` and tag `v3.0.0` to point at that exact commit.

## P1 — Commit and certify the 3.0.0 checkpoint

The coherent candidate preserves the prior stabilization work and adds the zero-approval danger contract, Node runtime PATH fix, docs, tests, and major-version metadata. Local Node 22/24 verification is green. Commit/push, exact-SHA CI, and the release tag remain the final certification sequence.

## P1 — Reconcile governance documentation

- Refresh stale release inventory data.
- Update ADR-0012 status to match implemented reality or record the remaining decision explicitly.
- Keep `docs/PROJECT_STATUS.md` and this file current after each material frontier change.
- Historical roadmap and implementation-log files should remain historical and should point readers to current truth.

## P2 — External production evidence

After the exact candidate commit is locally green:

1. pass Ubuntu/macOS/Windows × Node 22/24 CI for that exact SHA;
2. retain a completed 24-hour runtime-soak chain for the exact revision/environment;
3. obtain independent clean-machine reproduction;
4. obtain independent third-party MCP compatibility evidence;
5. run the beta/design-partner evidence program and satisfy its documented graduation gates.

## Feature frontier after stabilization

Only after P0/P1 stabilization should major feature work resume. Current known feature gaps include:

- natural-language objective -> deterministic plan/context compiler;
- process sandbox integration with autonomous/capsule execution;
- non-Git filesystem checkpoint fallback for isolation;
- production-grade distributed/multi-tenant operation;
- hosted marketplace operational maturity.

## Decision rule

Do not choose a new feature merely because it is easy to implement. Select the next item from the highest unresolved priority whose completion materially increases correctness, security, reproducibility, or release evidence.
