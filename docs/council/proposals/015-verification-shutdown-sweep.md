# Proposal 015: server shutdown sweeps verification executors

- Author role: Provisioner Engineer
- Date: 2026-09-08
- Status: implemented (2026-09-08, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Debt carried from proposal 004 (loop #29, queue item 2): detached verification
children are **not** part of the `stopManagedProcessTrees` shutdown sweep.

Verified by reading the code (loop #43 recon):

- `src/runtime/shutdown.ts` sweeps exactly three legs: `fleet.shutdownAll()`,
  `tunnels.stopAll()`, `processes.stopAllAndWait(graceMs)`. No verification leg.
- `src/tools/agent-tools.ts` spawns each check via execa with
  `detached: true` on POSIX (own process group) and wires
  `signal.abort -> terminateChildProcessTree` (proposals 004/008). On SIGTERM the
  shutdown path never touches the run-scoped controllers, the host process exits,
  and the detached check tree **survives as an orphan** — holding CPU, ports and
  stdio pipes until its own natural timeout happens to fire (cap: 30 min).
- `VerificationManager.recoverInterrupted()` only heals the *record* at next
  boot (executorPid liveness); it never reaps the orphaned process tree itself.

So today: `systemctl --user stop/restart folderforge-origin` (or plane) while a
`project_verify run async:true` is in flight leaves a live `npm run <check>`
tree behind — the same orphan class that caused the 502/OOM incidents in the
#36–#41 saga, just smaller.

## Proposal

Reuse the proven cancel path; add exactly one new public method and one sweep
leg.

1. **`VerificationManager.stopAllExecutions(graceMs = 1_500)`** — abort every
   registered executor (sync and async alike) with a shutdown-specific reason
   (`FolderForge is shutting down.`), then wait until the executor registry
   drains (each executor loop calls `endExecution` in its `finally`; the
   manager notifies idle waiters when the map empties) or `graceMs` elapses.
   Resolves `{ aborted: number; drained: boolean }`; never rejects. The SIGTERM
   to each child process group is sent synchronously inside `abort()` via the
   existing `onAbort -> terminateChildProcessTree` listener, so even a
   grace-expired wait still leaves no un-signalled tree; a record that missed
   its terminal write heals as `interrupted` at next boot (existing behavior).
2. **`src/runtime/shutdown.ts`** — `ManagedProcessSurface` gains
   `verifications: { stopAllExecutions: (graceMs?: number) => Promise<unknown> }`
   and `stopManagedProcessTrees` awaits it **first**, wrapped in try/catch with
   a warn log: a broken evidence store must never block the fleet/tunnel/process
   sweep during shutdown (fail-safe ordering). The existing three legs keep
   their exact order and semantics.
3. **No call-site changes needed** — `Container` already exposes
   `verifications: VerificationManager` and satisfies the extended surface
   structurally, so `main.ts`, `control/cli.ts` (`control serve`), and
   `share/cli.ts` all gain the leg automatically.

Behavioral notes:

- Shutdown-aborted runs persist as `cancelled` with skipped evidence through
  the existing cancel path — no new state machine transitions.
- Sync runs are covered too: the sweep aborts every registered executor, so an
  in-flight synchronous verification no longer depends on transport request
  abortion to die with the server.
- Non-goals: SIGKILL escalation for shutdown aborts (kept SIGTERM, cancel
  parity — see Security amendment 3); reaping orphans from *previous* server
  lifetimes (would need `terminatePidTree`-style identity gates — separate
  proposal if ever wanted); any schema/tool-surface change.

## Threat surface (Security hat)

No new tools, permissions, argv, policy surface, or schema-lock changes — the
`project_verify` schema is untouched. The sweep only aborts run-scoped
controllers created in this process, and every kill targets a process group
**we** spawned detached in the same run — no foreign-pid lookup, so no
`terminatePidTree`-style identity gate is required. The abort reason is a plain
`Error` literal — no secret material. Evidence writes stay atomic + 0600 via
the unchanged save path. Owner-binding rules are unaffected: shutdown is a
local process lifecycle event, not a cross-principal action. The verification
leg is failure-isolated (try/catch + warn) so a corrupted store cannot hold the
rest of the shutdown sweep hostage.

Residual, accepted: a grandchild that *traps* SIGTERM could outlive the sweep
(grace-bounded). This matches the cancel path bit-for-bit (proposal 008 kept
SIGTERM for operator-initiated aborts; SIGKILL is reserved for blown time
budgets) and the record still heals to `interrupted` at next boot.

## Test plan (QA hat)

- Unit (`tests/unit/verification-manager.test.ts`, +4):
  `stopAllExecutions` aborts all registered executors (sync + async) with the
  shutdown reason; resolves immediately with `{ aborted: 0, drained: true }`
  when idle; resolves with `drained: true` once the last `endExecution` lands;
  resolves with `drained: false` after a tiny grace when an executor never
  ends (timer path, no real 1.5s wait); second call is a no-op.
- Unit (`tests/unit/runtime-shutdown.test.ts`, update +2): surface gains the
  verifications leg; assert order
  `['verifications', 'fleet', 'tunnels', 'processes:1700']`; a throwing
  `stopAllExecutions` still runs fleet/tunnels/processes (fail-safe) and the
  sweep resolves.
- Integration (`tests/integration/agent-tools.test.ts`, +1): start an async
  `project_verify` run whose check command spawns a marked grandchild
  (node fixture file, the #35 harness pattern), then call
  `stopManagedProcessTrees(container)` directly; assert the run record is
  terminal `cancelled` with the active check `skipped`, and the marked
  grandchild pid is gone (POSIX `kill -0` probe; skipped on win32).
- Regression: existing #29 cancel tests, #35 tree-kill tests, schema-lock suite
  all pass unchanged.
- Gates: typecheck + lint + build + targeted + full suite (run_test async,
  evidence method disclosed per the #27 convention).
- Live proof on the built `dist`: boot a throwaway server on a test port with
  a fixture project (never the user's plane/origin), start an async
  verification with a long-running check, SIGTERM the server, assert the
  grandchild tree is reaped and the run record is terminal — `PROOF_EXIT:0`,
  zero host change.

## Rollback

Revert the council branch commit; shutdown returns to the three-leg sweep (the
verification-orphan gap returns with it; no data or state risk either way).

## Decision log

- 2026-09-08 — Provisioner Engineer — propose — initial draft (loop #43,
  GOAL-1 from the post-#42 queue; debt #29 item 2: detached verification
  children missing from the shutdown sweep).
- 2026-09-08 — Security Officer — **approve with amendments** — (1) the sweep
  may only abort run-scoped controllers created in this process (self-spawned
  detached groups; no foreign-pid paths); (2) the verification leg must be
  failure-isolated so a broken evidence store can never block the
  fleet/tunnel/process sweep; (3) keep SIGTERM (cancel parity) — no SIGKILL
  escalation in this proposal; the SIGTERM-trapping-grandchild residual is
  documented, not fixed; (4) no schema-lock change, no new permissions, no
  secret material in the abort reason. This approval does NOT cover
  merge/push — Git needs separate user approval.
- 2026-09-08 — QA/Verifier — **approve with amendments** — (1) the shutdown
  integration test with a real marked grandchild is mandatory (proves orphan
  reaping, not just signal wiring); (2) the #29 cancel tests and #35 tree-kill
  tests must pass unchanged; (3) the runtime-shutdown unit test must assert
  the verification leg runs FIRST and that its failure does not skip the
  others; (4) full-suite evidence method disclosed (run_test async); (5) live
  proof on dist must show both a reaped grandchild AND a terminal run record.
- 2026-09-08 — QA/Verifier — **gates green on the final code** — targeted
  35/35 (verification-manager 8→12, runtime-shutdown 2→3, agent-tools 19→20
  including the mandatory shutdown-sweep integration test: 395ms, marked
  grandchild reaped, run terminal `cancelled`), typecheck exit 0, lint exit 0
  (eslint --max-warnings=0), build exit 0 (adapter tsc + SPA vite 1841 modules
  + main tsc), full suite **134 files / 1108 tests PASS** (75.87s, run_test
  async — disclosed per #27), live proof on the built dist **PROOF_EXIT:0**
  (real server booted with `--no-dashboard`, async run verify_2b6a49d205314a37
  spawned grandchild pid 1226093, SIGTERM → server exited, grandchild reaped,
  run record terminal `cancelled` with `test:skipped`). The one mid-loop
  failure was the council's own harness (proof server tried to bind the
  default dashboard port 7332 held by the user's live plane — the #31 lesson;
  fixed with `--no-dashboard`, no product change).
- 2026-09-08 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #43 (survey approval after the LOOP REPORT).
