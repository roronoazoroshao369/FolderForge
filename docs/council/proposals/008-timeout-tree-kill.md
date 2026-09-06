# Proposal 008: natural timeouts kill the whole process tree

- Author role: Provisioner Engineer
- Date: 2026-09-06
- Status: implemented (2026-09-06, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Debt carried from proposal 004 (loop #29): the **cancel** path was fixed to
terminate the whole spawned process tree, but execa's **natural timeout** still
kills only the direct child. Shell-wrapped spawns (`bash -lc 'npm run …'`)
then leave orphaned grandchildren holding the stdio pipes, so the awaiting
call hangs past its timeout budget (the same mechanism that hung the cancel
path for 30.1s before #29; measured there, proven by code inspection here).

Affected call sites (verified by reading the code):

- `src/tools/agent-tools.ts` — verification checks: already spawn detached
  (#29) but still pass execa's `timeout` → on natural timeout execa SIGTERMs
  only the shell, orphaning the check's grandchildren.
- `src/tools/terminal-tools.ts` — `shell_exec`: same execa `timeout`, and not
  even detached → timeout kills the shell only. This is the hottest tool in
  the registry, so the blast radius is largest here.
- `src/tools/build-tools.ts` — synchronous `run_test`/`run_lint`/… path: same
  pattern (the `async:true` session path is unaffected — ProcessManager
  already spawns detached and tree-kills).

Reviewed and deliberately **deferred** (note, not fix): `coverage-tools.ts`,
`format-tools.ts`, `pkg-tools.ts` spawn binaries directly via execa **without
a login shell**, so there is no wrapper grandchild layer; the residual risk
(the binary itself forking, e.g. `npx`) is much smaller and will be listed as
follow-up debt rather than widening this patch.

## Proposal

1. **`src/core/process-tree.ts` gains `armTreeKillTimeout(child, timeoutMs)`**
   returning `{ timedOut, dispose }`. On fire it calls
   `terminateChildProcessTree(child, /* force */ true)` — POSIX group SIGKILL
   (the child is spawned detached, i.e. its own group leader) / Windows
   `taskkill /T /F`. `dispose()` clears the timer in the `finally` of the
   awaiting call. SIGKILL is deliberate for timeouts: the budget is already
   blown, and a trappable SIGTERM would let a grandchild keep the pipes open
   and re-hang the await. (The cancel path stays on gentle SIGTERM.)
2. **Call-site changes (behavior-preserving outward):**
   - Drop execa's `timeout` option at the three sites; arm the helper right
     after spawn instead; dispose in `finally`.
   - Add `detached: true` on POSIX where missing (terminal-tools, build-tools)
     so the group kill can reach grandchildren. Windows paths are unchanged
     (taskkill /T needs no group).
   - Timeout classification switches from `sub.timedOut` to the helper's
     `timedOut` flag, keeping the exact outward messages: verification checks
     keep `reason: 'Verification timed out after <ms>ms.'` + status `failed`;
     `build-tools` keeps the "re-run with async:true" hint; `shell_exec` keeps
     its timeout error text and `exitCode: null` schema compliance.
3. **Cancel/abort paths are untouched** (they already tree-kill via the #29
   listener).

Non-goals: the three direct-binary tools (deferred above); execa upgrades;
any change to ProcessManager (async path already correct); npm publish.

## Threat surface (Security hat)

No new tools, permissions, argv, or policy surface: identical commands, cwd
and timeout values, only the kill mechanics change. The group kill targets a
process group **we** created (detached spawn in the same call) — no foreign
pids, so no identity-gate like `terminatePidTree`'s is required. SIGKILL on
timeout cannot be trapped by the workload. `shell_exec` output schema is
unchanged (`exitCode: null` already permitted for signal deaths).

## Test plan (QA hat)

- Unit (`tests/unit/process-tree.test.ts`): timer fires →
  `terminateChildProcessTree(child, true)` semantics (fake child, POSIX ESRCH
  fallback to `child.kill('SIGKILL')`); `dispose()` before fire → no kill;
  no-op for an already-exited child.
- Integration (`tests/integration/agent-tools.test.ts`): a verification check
  whose command orphans a **marked** grandchild (unique argv marker,
  `bash -c 'exec -a ff35marker sleep 300 & wait'` shape) with a tiny
  `timeoutMs` → the run completes promptly with `failed` + the timed-out
  reason, and `pgrep -f ff35marker` proves the orphan is reaped. POSIX-only,
  skipped on win32. Existing cancel regressions from #29 must pass unchanged.
- Integration (`tests/integration/terminal-tools.test.ts`): `shell_exec` with
  the same orphaning command + 500ms timeout returns promptly (well under the
  old pipe-hang horizon), schema-valid output (`exitCode: null`), and the
  marked grandchild is gone.
- Gates: targeted + full suite (run_test async, disclosed per #27) +
  typecheck/lint/build; live proof on the built dist: real
  `shell_exec`-equivalent command `bash -c 'sleep 300 & wait'` with an 800ms
  timeout returns in ~1s and leaves no `sleep 300` behind (pgrep proof).

## Rollback

Revert the council branch commit; execa's natural timeout semantics return
(the orphan-hang bug returns with them; no data or state risk either way).

## Decision log

- 2026-09-06 — Provisioner Engineer — propose — initial draft (loop #35,
  candidate #1 from the queue; debt from proposal 004: natural execa timeout
  kills only the direct child).
- 2026-09-06 — Security Officer — **approve with amendments** — (1) group
  kills only ever target self-spawned detached groups — hard-require
  `detached:true` at every converted POSIX site; (2) SIGKILL only for the
  timeout path, cancel stays SIGTERM; (3) no new argv/permissions; (4)
  `shell_exec` output schema must stay valid for signal deaths (exitCode
  null). This approval does NOT cover merge/push — Git needs separate user
  approval.
- 2026-09-06 — QA/Verifier — **approve with amendments** — (1) the two
  orphan-reaping integration tests with unique pgrep markers are mandatory
  (they are the regression that proves the bug class is dead); (2) the
  existing #29 cancel tests must pass unchanged; (3) live proof must show both
  prompt return AND no stray grandchild; (4) evidence-method disclosure per
  #27 (run_test async).
- 2026-09-06 — QA/Verifier — **gates green on the final code** — targeted
  31/31 (process-tree 6→10, terminal-tools 2, agent-tools 18→19), typecheck/
  lint/build exit 0, full suite 132 files / 1070 tests PASS (76.76s, run_test
  async — disclosed per #27), built-code live proof PROOF_EXIT:0 (shell_exec
  with a real orphaning command + 800ms timeout returned in 850ms; pgrep
  proved the grandchild reaped). The one mid-loop failure was the council's
  own fixture (bash-only `exec -a` under the npm sh wrapper — diagnosed from
  the 269ms early-pass evidence, fixture switched to a node script file, no
  product change).
- 2026-09-06 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #35.
