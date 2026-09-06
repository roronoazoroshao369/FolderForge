# Proposal 007: control serve writes its state + systemd-aware control stop

- Author role: Provisioner Engineer
- Date: 2026-09-05
- Status: implemented (2026-09-06, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Proposal 006 added boot persistence: the systemd user unit runs `control serve`
directly as its main process. But `control serve` never writes
`.folderforge/control.json` — only `control start` (and the watchdog/auth
respawn paths) do. Observed live on the operator machine in loop #33: the plane
was active under systemd (MainPID 2305217, HTTP 200 on /status and /app/) yet
`control status` reported `running:false` (only the `bootService:"enabled"`
hint was correct) and `control stop` could not stop it. Even with state
present, SIGTERM-ing a systemd-managed plane is wrong: `Restart=on-failure`
would bring it back seconds later.

## Proposal

1. **`control serve` owns its state file.** Right after the dashboard binds
   (after the CONTROL_READY line), write control.json with
   `{schemaVersion:1, pid: process.pid, port: boundPort, projectRoot,
   startedAt, version}` via a new exported helper `recordServeState()`,
   merge-preserving fields serve does not own (existing `watchdogPid`,
   `openaiTunnel`, `auth`, `allow`). On SIGINT/SIGTERM shutdown, a second
   helper `clearServeStateIfOurs()` removes the state file only when it still
   points at this process's pid — never clobbering a newer plane's state.
   `control start` keeps writing its richer state after spawn (same pid, adds
   watchdog/tunnel fields) — last write wins with an identical pid; no
   conflict.
2. **`control stop` becomes boot-service-aware.** Before the state/SIGTERM
   path: if the installed unit reports `is-active: active` AND the unit's
   ExecStart project equals the requested `--project` (guard against stopping
   another project's plane — one unit per user), stop it via
   `systemctl --user stop folderforge-control.service` through the existing
   injected `execSystemctl` dep (fixed argv, no shell), remove control.json,
   and report that the boot service remains enabled (starts again at login)
   with the uninstall/disable hint. systemctl failure → exit 1, state
   preserved. Unit absent/inactive or project mismatch → the existing SIGTERM
   path is unchanged, bit-for-bit.
3. **UX:** stop's systemd message makes the still-enabled semantics explicit;
   `control status` keeps the bootService label and now reports the
   systemd-managed plane correctly via (1).

Non-goals: changing the unit/ExecStart shape; spawning a watchdog under systemd
(proposal 006 documents systemd as the supervisor); altering `control start`
behavior for manually-started planes; npm publish.

## Threat surface (Security hat)

No new permissions; systemctl runs with fixed argv via the injected spawnSync
dep (no shell). The project-match guard (`serviceStatusInfo().projectRoot ===
--project`) prevents one project's stop command from killing another project's
systemd-managed plane. State writes stay inside the project's own
`.folderforge/`, atomic (tmp + rename), and secret-free (only `{mode}` for
auth, unchanged). `clearServeStateIfOurs` is pid-guarded so a stale child
cannot delete a successor's state.

## Test plan (QA hat)

- Unit (existing fake harness in control-cli.test.ts + control-service.test.ts):
  - recordServeState: writes pid/port/version/startedAt; preserves
    watchdogPid/auth/openaiTunnel from pre-existing state; `allow` from options
    wins when provided, preserved otherwise.
  - clearServeStateIfOurs: removes state when pid matches; leaves a different
    pid's state untouched; tolerates a missing file.
  - stop, unit active + matching project: calls execSystemctl
    ['--user','stop',UNIT]; never calls deps.terminate on the state pid;
    removes state; message mentions the service stays enabled.
  - stop, unit active + DIFFERENT project: falls through to the legacy SIGTERM
    path (guard test).
  - stop, unit installed but inactive / not installed: legacy path unchanged
    (regression).
  - stop, systemctl stop fails: exit 1, state preserved.
  - The existing 36 targeted tests pass unchanged.
- Live proof (isolated, no systemd mutation): foreground
  `node dist/main.js control serve --project /tmp/ff34 --port 7573` →
  control.json appears with the process pid → `control status` running:true →
  SIGTERM → state removed. Unit file unchanged; `systemd-analyze verify` stays
  clean.
- Gates: typecheck/lint/build + targeted + full suite (run_test async,
  disclosed method per #27).

## Rollback

Revert the council branch commit. The installed unit and running plane are
unaffected (ops state is independent); `systemctl --user restart
folderforge-control` picks up whatever dist is present.

## Decision log

- 2026-09-05 — Provisioner Engineer — propose — initial draft (loop #34,
  candidate #1 from the #33 loop report; wart observed live: systemd-active
  plane invisible to control status/stop).
- 2026-09-05 — Security Officer — **approve with amendments** — (1)
  project-match guard before any systemctl stop; (2) fixed argv, no shell; (3)
  state writes atomic and pid-guarded; (4) no secrets in state (unchanged).
  This approval does NOT cover merge/push, nor re-installing/restarting the
  real unit — that ops step needs separate user approval.
- 2026-09-05 — QA/Verifier — **approve with amendments** — (1) the unit tests
  above are mandatory, including the project-mismatch guard test; (2) the
  isolated foreground serve proof must show state appear AND disappear on
  SIGTERM; (3) existing suites pass unchanged; (4) evidence-method disclosure
  per #27 (run_test async).
- 2026-09-05 — Ops note: activating the fixed build on the operator machine
  (re-install unit from the new dist + `systemctl --user restart`) is a
  separate ops step requiring the user's approval at report time.
- 2026-09-06 — QA/Verifier — **gates green on the final code** — targeted
  42/42 (control-cli 24→30 + control-service 12), typecheck/lint/build exit 0,
  full suite 132 files / 1064 tests PASS (75.65s, run_test async — disclosed
  per #27), isolated live proof PROOF_EXIT:0 (serve writes state with its own
  pid → status running:true → SIGTERM removes state and the process exits; the
  one mid-proof failure was a harness race, diagnosed per HARD STOP #3 —
  harness fixed, no product change).
- 2026-09-06 — User — **Git approved** — commit + merge --no-ff to main + push
  origin for loop #34 (4 files: cli.ts, control-cli.test.ts, CHANGELOG.md,
  this proposal).
