# Proposal 019: self-describing control CLI state errors + ops doc note (--project)

- Author role: DX/UI Designer (error UX)
- Date: 2026-09-09
- Status: implemented (2026-09-09, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

OPS #44 evidence: ops scripts calling `folderforge control stop` and
`folderforge control service install` from the wrong cwd silently targeted
the cwd's (nonexistent) state — the errors
(`No Mission Control plane state found; nothing to stop.` /
`No control plane state found. Run \`folderforge control start\` once first…`)
never said WHERE state was expected or how to retarget, which cost a failed
leg and a fix-forward. The queue item from #44 was a doc note; this proposal
covers the doc note AND the failure-class fix at the source: the errors
self-describe.

## Proposal

1. **`src/control/cli.ts` (stop path)**: when no state exists, the output
   names the exact expected state file (`controlStatePath(projectRoot)`) and
   the remedy: pass `--project <dir>` if the plane lives elsewhere.
2. **`src/control/service.ts` (`installService`)**: same remedy sentence,
   naming the convention `<project>/.folderforge/control.json` (no interface
   change — `InstallOptions` gains nothing).
3. **README control section**: one note — control state is per-project
   (`<projectRoot>/.folderforge/control.json`); scripts and non-interactive
   shells MUST pass `--project` explicitly or the CLI targets the current
   working directory.
4. **Tests**: the existing `toContain("nothing to stop")` and
   `No control plane state found` assertions stay green (both phrases kept
   byte-identical); new assertions pin the hint in both paths.

Non-goals: no state auto-discovery across directories (a wrong guess would
be worse than a clear error); no interface changes; no behavior change —
only message text and docs.

## Threat surface (Security hat)

Two error strings + one README paragraph. No behavior, schema, policy, or
permission changes. The state path is not a secret — it is the operator's
own project directory, already printed by `control status`.

## Test plan (QA hat)

- Targeted: `tests/unit/control-cli.test.ts` (30→31) and
  `tests/unit/control-service.test.ts` (17→18) — new hint assertions.
- Gates: typecheck/lint/build = 0/0/0; full suite (run_test async,
  disclosed per #27).
- Live proof: `control stop` from a temp cwd prints the temp path + the
  `--project` hint; `control service install` without state prints the
  convention + the remedy; both exit codes unchanged (0 / 1).

## Rollback

Revert the branch commit; the messages and docs return to the previous
wording.

## Decision log

- 2026-09-09 — DX/UI Designer — propose — loop #48, candidate #1 from the
  post-#47 queue (the ff44 lesson). Research evidence: `src/control/cli.ts:746`
  (stop; `projectRoot` in scope, `controlStatePath` at :207),
  `src/control/service.ts:364` (`installService`; `InstallOptions` at :397
  has no projectRoot → convention wording, no interface change), README
  documents `control start|stop` without the per-project note (lines
  77–94/128/136), and existing tests assert via `toContain` — safe to
  extend the strings without breaking them.
- 2026-09-09 — Security Officer — **approve** — no surface or behavior
  change; the disclosed path is operator-local and already shown by
  `control status`. This approval does NOT cover merge/push — Git needs
  separate user approval.
- 2026-09-09 — QA/Verifier — **approve with amendments** — (1) keep
  `nothing to stop` and `No control plane state found` byte-identical
  (existing tests and operator scripts may match them); (2) new assertions
  pin the hint text in both paths; (3) full-suite evidence disclosed per
  #27; (4) live proof covers both exit codes (stop=0, install=1).
- 2026-09-09 — QA/Verifier — **gates green on the final code** — targeted
  47/47 (control-cli 30 + control-service 17, hint assertions in both
  paths), typecheck/lint/build = 0/0/0, full suite **136 files / 1126
  tests PASS** (89.41s, run_test async — disclosed per #27). Live proof
  PROOF_DONE (dist CLI, zero host change): `control stop` from a temp cwd
  → names the exact state file + the --project remedy, exit 0;
  `control service install` without state → convention + remedy, exit 1.
  Implementation note: the install-path assertion rides the existing
  CLI-level no-state test (stronger than a direct unit test — the import
  added then reverted); the proposal's 30→31/17→18 counts became
  extended-in-place assertions. One mid-loop anchor failure on
  control-service.test.ts (diff-view phantom indent — the known lesson),
  retried with the nearest-candidate text; no product change.
- 2026-09-09 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #48 (survey approval after the LOOP REPORT).
