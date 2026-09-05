# Proposal 004: Async background execution + explicit cancel for project_verify

- Author role: Architect
- Date: 2026-09-05
- Status: approved (amended by Security + QA, see Decision log)
- ADR link: docs/adr-0012-mission-control-control-plane.md (council loop gate); contract doc: docs/structured-verification.md

## Problem

Tools-only MCP clients (plain `tools/call`, without the MCP task protocol)
cannot drive the 4-gate verification pipeline when the suite outlives a single
request: `project_verify run` executes synchronously bound to the request
`AbortSignal`, so a client/transport timeout aborts the run mid-flight and the
durable record ends `cancelled`. This happened twice during council #27 (full
suite ~73s exceeded the request window), forcing out-of-band evidence and an
documented gate exception. The durable run store, owner binding, `status`/`list`
reads, interruption recovery, and MCP native task support already exist. The
narrow gap: a tools-only way to (a) start a run detached from the request
lifecycle and (b) cancel a running run explicitly.

## Proposal

Additive contract change to the existing `project_verify` tool. No new tool, no
new runner, no second execution path, no persisted-schema change.

1. **New optional input `async: boolean`**, valid only with `action: "run"`
   (rejected with a clear error otherwise). With `async: true` the run is
   created and persisted exactly as today, then executed **detached from the
   request `AbortSignal`** inside the same governed server process. The call
   returns immediately (target < 5s for a > 60s fixture) with the standard run
   report (`id`, `state: "running"`, pending checks). Clients poll the existing
   owner-bound `status` / `list` actions until the run is terminal. Polling
   never creates or duplicates an execution.
2. **New action `cancel`** (requires `id`). Owner-checked with the same binding
   as `status` (admin bypass included). Idempotent: a terminal run returns its
   current report unchanged (`cancellation: "not-required"`). On a `running`
   run it aborts the run's execution controller; the loop records the active
   check as `skipped`, marks remaining checks `skipped`, and finishes the run
   `cancelled` — the exact semantics already used for request cancellation.
   Cancellation is acknowledged asynchronously (`cancellation: "requested"`);
   the terminal state is observed via `status`. A run reported `running` with no
   live executor in this process (defensive case) returns a clear error instead
   of silently succeeding.
3. **Unified per-run execution controllers.** Every run (sync or async)
   registers an `AbortController` with the `VerificationManager` for its
   lifetime (`beginExecution` / `endExecution` / `cancelExecution`). Sync runs
   link the request signal to the run controller, preserving current sync
   behavior exactly (request cancel → run cancelled) while making in-flight
   sync runs cancellable through `cancel` as well. Async runs ignore the
   request signal entirely. The registry is in-memory, process-local, and holds
   no args or output.
4. **Concurrency guard:** at most **1** async execution active per server
   process. A second `async: true` start fails fast and names the active run ID
   (client may poll or cancel it). Synchronous runs keep today's behavior — no
   new cap. The check-then-register sequence is fully synchronous (no interleave
   window).
5. **Interruption semantics unchanged:** if the server process dies, the next
   `VerificationManager` construction marks orphaned `running` runs
   `interrupted` via executor-PID liveness, without replay.
6. **Workspace pinning:** an async run executes against the project root
   captured at start (`ctx.projectRoot`) with the same captured shell, per-check
   timeout (unchanged, max 30 min), output bounds, and secret redaction as sync
   runs. Later workspace switches do not affect an in-flight run. The evidence
   store location (`.folderforge/verifications/` under the server default
   project) is existing behavior and unchanged.
7. **Schema-lock: NOT edited.** The freeze covers tool name + `mutates` +
   `risk` only. This change adds an optional input and a new action value while
   keeping name `project_verify`, `mutates: true`, risk `MEDIUM`. The registry's
   existing per-action classification maps any non-`plan`/`status`/`list`
   action (thus `cancel`, and any `async` run) to MEDIUM/mutating, so readonly
   mode denies them and OAuth requires the write scope — zero registry/policy
   edits, proven by tests.

Non-goals: no queueing, no cross-process workers, no MCP task-protocol changes,
no UI screen, no change to run-record `schemaVersion` (stays 1), no change to
`plan`/`status`/`list` responses or sync default behavior.

## Threat surface (Security hat)

- **New exposure:** execution continues after the caller disconnects.
  Mitigations: same per-check timeout ceiling; same shell/cwd/redaction path as
  sync; single-flight async cap; owner-bound `status`/`cancel`; `cancel` is a
  governed MEDIUM/mutating call (audited `tool_call`/`tool_result` as usual).
- **Secrets:** unchanged redaction before persistence; the state directory
  remains covered by denied globs; the executor registry stores no args/output.
- **Policy implications:** classification is inherited, not redefined —
  readonly/safe/dev/danger semantics and approval classes are untouched. No new
  principals, no transport/timeout changes, no audit-durability relaxation. The
  request `AbortSignal` is not dropped: it is linked into a run-scoped
  controller for sync runs (unchanged behavior) and intentionally not linked
  for `async: true` runs (the feature).
- **Abuse case:** a caller starting an async run and never polling leaves a
  bounded (per-check timeout), single-flight, integrity-protected run —
  equivalent cost to an abandoned sync run.
- **Fail-closed:** the detached loop catches every rejection, best-effort
  persists `interrupted` with remaining checks `skipped`, and logs via the
  redacting logger; an orphaned async rejection can never crash the host.

## Test plan (QA hat)

Unit (`tests/unit/verification-manager.test.ts`):
- executor registry roundtrip: register → cancel → unregister;
- `cancelExecution` on unknown ID returns `false`;
- duplicate `beginExecution` for the same ID throws;
- async cap refuses a second concurrent async registration and names the active
  run.

Integration (`tests/integration/agent-tools.test.ts`, fixture `node -e` scripts
with short sleeps):
- **async start latency:** `async: true` returns in < 5s with `state: "running"`
  and the run `id`; polling `status` reaches `completed` / `overall: "passed"`
  with fixture commands recorded; no duplicate runs appear in `list`.
- **request-lifecycle isolation (the motivating regression):** abort the parent
  request signal immediately after an async start; the run still completes and
  terminal evidence is readable via `status`.
- **cancel lifecycle:** start an async run with a sleeping check → `cancel` →
  poll to `state: "cancelled"`, active + pending checks `skipped`,
  `overall: "incomplete"`.
- **cancel edges:** terminal run → idempotent `not-required`; unknown ID →
  error; non-owner → access denied; admin principal → allowed.
- **readonly/policy:** `cancel` and `async` run are `Denied:` in readonly mode;
  `plan`/`status`/`list` stay allowed.
- **busy guard:** second async start while one is active → `ok: false` naming
  the active run ID.
- **async stopOnFailure:** failing first check → later checks `skipped`,
  `overall: "failed"`, terminal `completed`.
- **sync contract:** the existing sync suite passes unchanged; an in-flight
  sync run can be cancelled via `cancel` (registered controller); request-signal
  abort still cancels a sync run exactly as before.
- **interrupt/no-replay:** existing recovery tests stay green (executor PID
  dead → `interrupted`, no replay).

Gate: targeted files green, then `project_verify` (typecheck/lint/test/build)
plus the full suite on the final revision; live proof harness against `dist/`
exercising start → poll → cancel without touching the connected MCP server.

## Rollback

Bounded revert of the council branch commits (proposal-listed files only). The
sync default path is preserved code, so a revert restores the exact prior
contract. No state migration: run records are unchanged (`schemaVersion` stays
1); any orphaned `running` record left by an async build self-heals to
`interrupted` on the next server start via existing recovery.

## Decision log

- 2026-09-05 — Architect — propose — initial draft as above.
- 2026-09-05 — Security Officer — **approve with amendments** — (1) async cap
  fixed at 1, not caller-configurable; (2) `cancel` idempotent and owner-bound
  exactly like `status`, including the admin bypass; (3) the detached loop must
  catch all rejections and never crash the host process; (4) the executor
  registry persists nothing and holds no args/output; (5) no transport-timeout
  or audit-durability changes to "make room" for async. Classification reuse
  (registry action branch) verified by reading `registry.ts` — `cancel`
  inherits MEDIUM/mutating without edits.
- 2026-09-05 — QA/Verifier — **approve with amendments** — (1) acceptance must
  include the request-abort isolation regression; (2) cancel is acknowledged
  asynchronously and the terminal state is observed via `status` polling;
  (3) the unchanged existing sync suite is itself a required regression signal;
  (4) gate evidence disclosure rule from #27 carries over: a 4/4 PASS is only
  claimed for a `project_verify` run that actually completed; full-suite
  evidence may come from `run_test` async with the method disclosed.
- 2026-09-05 — QA/Verifier + Provisioner Engineer — **amend (implementation
  finding)** — cancel-path kill hardened after failing-test evidence: check
  processes are spawned `detached` on POSIX (own process group) and aborts now
  terminate the whole tree via `terminateChildProcessTree`, because
  `npm run <check>` wraps the real command and killing only the direct child
  left orphaned grandchildren holding stdio pipes (cancel then appeared to
  hang until the command exited on its own: measured 30.1s natural exit vs
  0.35s raw kill). Shared-core touch, one word: the exit guard in
  `src/core/process-tree.ts` now uses loose null equality (`!= null`) so
  execa's `ResultPromise` — whose `exitCode` is `undefined` while running —
  is not mistaken for an exited process. Probe evidence: raw execa kill 350ms;
  registry-path cancel pre-fix 30,071ms natural exit; post-fix integration
  suite 18/18 with every cancel test completing in under 3s.
- 2026-09-05 — Security Officer — **approve amendment** — the group signal is
  scoped to the spawned check's own process group (detached leader); no new
  permissions, no persisted-state or transport changes; the core guard change
  is semantics-preserving for real `ChildProcess` (`null`) and strictly
  corrective for execa handles (`undefined`).
