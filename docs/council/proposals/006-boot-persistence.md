# Proposal 006: Boot persistence for the Mission Control plane (systemd user service)

- Author role: Provisioner Engineer
- Date: 2026-09-05
- Status: approved (amended by Security + QA, see Decision log)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

The control plane (`control start`, optionally `--watchdog`) survives hangs and
crashes but not machine reboots: the 2026-08-27 reboot killed both plane and
watchdog, and the operator only noticed when the UI was gone (track log #25).
The watchdog guards a stuck process, not a rebooted host. Verified gap: zero
`systemd` matches in the repo; no launchd/Windows service support either.

## Proposal

Add `folderforge control service install|uninstall|status` — a per-user systemd
unit that starts `control serve` at login (Linux first; other platforms fail
with a clear message):

1. New module `src/control/service.ts`:
   - `unitFilePath(deps)`: `$XDG_CONFIG_HOME/systemd/user/folderforge-control.service`,
     defaulting to `~/.config/systemd/user/`.
   - `renderUnit(serveArgs, version)`: the exact unit text — `[Unit]` Description
     + `After=default.target`; `[Service]` `ExecStart=<execPath> <mainJs>
     control serve --project <root> --port <port> [--allow <dir>…]`,
     `Restart=on-failure`, `RestartSec=5`, `StartLimitIntervalSec=60`,
     `StartLimitBurst=5`; `[Install] WantedBy=default.target`. No secrets: the
     serve child already reads the 0600 credential file itself at boot, so
     nothing sensitive enters the unit.
   - The ExecStart argv is rebuilt from `control.json` (the same argv shape the
     watchdog already uses), so the unit reproduces the operator's chosen
     project/port/allow exactly.
2. CLI wiring (`src/control/cli.ts`): `service` command accepting commandArg
   `install|uninstall|status` (parseControlArgs learns to allow commandArg for
   'service' alongside 'auth'); new `--enable` and `--replace` flags validated
   as service-install-only; help text. New injected deps: `execPath` (default
   `process.execPath`), `homeDir` (default `os.homedir()`), `fileExists`
   (default `existsSync`), `execSystemctl` (default `spawnSync('systemctl',
   args)` — fixed argv, no shell).
3. `install` requires an existing `control.json` (run `control start` once
   first) so the unit mirrors a known-good configuration; verifies `execPath`
   and `mainJs` exist before writing (fails fast with a "re-install after
   upgrades" hint); refuses to overwrite a unit installed for a different
   projectRoot unless `--replace` is passed; writes the unit (mode 0600); then:
   - default: prints the exact `systemctl --user daemon-reload` + `systemctl
     --user enable --now folderforge-control.service` commands for the operator;
   - `--enable`: runs them itself via the injected exec dep, reporting each
     step's exit code.
4. `uninstall`: best-effort `systemctl --user disable --now`, removes the unit
   file, `daemon-reload`; idempotent (exit 0 when nothing is installed).
5. `status`: reports installed/not-installed, the unit's target project/port,
   and `is-enabled`/`is-active` when systemctl is available.
6. `control status` gains a read-only line (`Boot service: enabled|disabled|not
   installed`) and the `--json` output gains a `bootService` field.

Non-goals: macOS launchd / Windows service support (the platform guard errors
clearly; follow-up gap); enabling the service on the operator's machine during
this loop (real system mutation — requires separate operator approval per the
 #26 note); restarting the ChatGPT tunnel supervisor at boot (the unit manages
the `control serve` plane only); multiple planes per user (fixed unit name;
per-project template units are a follow-up).

## Threat surface (Security hat)

- New file write outside the repo (`~/.config/systemd/user/`): performed by the
  operator's own CLI invocation, never by an MCP tool; the MCP path policy is
  untouched. The unit contains absolute paths and no secrets (test-asserted:
  the credential value never renders). Boot persistence changes the failure
  model — the plane starts unattended at login — mitigated because
  `control serve` is loopback-only by design and dashboard auth (when
  configured) is unchanged; no new network exposure. `systemctl` is invoked
  with fixed argv via spawnSync (no shell string interpolation). The
  in-process `--watchdog` remains an independent opt-in layer; running both is
  redundant but harmless and documented. Rollback of an installed unit is
  `control service uninstall`.

## Test plan (QA hat)

- Unit (`tests/unit/control-service.test.ts`, reusing the control-cli fake
  harness): arg parsing (`service install|uninstall|status`; unknown
  subcommand → exit 2; `--enable`/`--replace` rejected without `service
  install`); install without control.json → exit 1 with guidance; unit content
  equals the exact ExecStart argv from state including the `--allow` list; file
  lands under the injected XDG_CONFIG_HOME with mode 0600; the stored
  credential value never appears in the unit; `--enable` records
  `daemon-reload` + `enable --now` via the fake exec dep; systemctl
  missing/failing → exit 1 with guidance; platform darwin → unsupported error;
  install fails fast when execPath/mainJs are missing; overwrite guard for a
  different projectRoot, `--replace` overrides; uninstall is idempotent
  (disable --now + rm + daemon-reload); status prints target + enabled/active;
  `control status` shows the boot-service line and the JSON field.
- Live proof (isolated; no real enable): temp project + `control start --port
  7571` on the built dist → `control service install` with
  `XDG_CONFIG_HOME=/tmp/ff32-proof` → assert unit path + content;
  `systemd-analyze verify` when the binary is available (structural assert
  otherwise); `control service status`; `control service uninstall` removes the
  file; `control stop`; nothing is enabled on the real machine.
- Gates: typecheck/lint/build + targeted suites + full suite.

## Rollback

Revert the council branch commit. `control service uninstall` removes any
installed unit; operators who never ran the command are unaffected.

## Decision log

- 2026-09-05 — Provisioner Engineer — propose — initial draft as above (loop
  #32, candidate #1 from the #31 loop report; user continued with "tiếp tục").
- 2026-09-05 — Security Officer — **approve with amendments** — (1) the unit
  file must be mode 0600 and must provably never contain the credential (test
  asserts absence); (2) install must fail fast when execPath/mainJs no longer
  exist (stale unit after upgrades) with a re-install hint; (3) systemctl
  invocations use fixed argv via spawnSync — no shell; (4) the plane stays
  loopback-only under systemd exactly as under `control start`; no tunnel or
  public bind is implied. This approval does not cover merge/push, nor enabling
  the service on the operator's machine.
- 2026-09-05 — QA/Verifier — **approve with amendments** — (1) idempotence
  evidence: install → status → reinstall (identical content) → uninstall →
  status-clean; (2) `control status` boot-service line must exist in both text
  and --json output; (3) the isolated live proof must include
  `systemd-analyze verify` when available and must leave zero system-level
  change (no enable, no daemon-reload on the real machine); (4) the existing
  control-cli suite must pass unchanged except intended additions.
- 2026-09-05 — QA/Verifier — **amendment from isolated live proof** —
  `systemd-analyze verify` on the proof host flagged `StartLimitIntervalSec`
  as an unknown key in `[Service]` (older systemd ignores it there; restart
  behavior itself unaffected). Fixed in-loop with the user's explicit
  approval: `StartLimitIntervalSec`/`StartLimitBurst` moved to `[Unit]`, the
  backwards-compatible placement. All gates re-verified on the fixed code
  before any Git operation.
- 2026-09-05 — User — **decisions via survey** — (1) apply the `[Unit]`
  placement fix now and re-verify every gate; (2) pre-approve commit +
  merge to main + push to origin for loop #32 once the MCP connection is
  back and all gates are green on the fixed code. Scope: the six loop files
  plus this fix only — npm publish and enabling the service on the
  operator's machine are NOT covered (separate approvals).
