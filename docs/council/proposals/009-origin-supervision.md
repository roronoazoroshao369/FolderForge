# Proposal 009: supervised MCP origin + named-tunnel duplicate guard

- Author role: Provisioner Engineer
- Date: 2026-09-06
- Status: implemented (2026-09-06, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

The operator-facing MCP origin is flaky ("MCP origin chập chờn", queue debt
from #32; outages hit #14 and #32 as HTTP 502 origin_bad_gateway). Live
machine recon (read-only) found two independent mechanisms plus one security
wart:

1. **Unsupervised origin**: the origin behind the named tunnel
   (`folder-forge.musashishao.cc.cd` → 127.0.0.1:3112) runs as a manual
   `folderforge --http` process parented to a login shell — no supervisor, no
   boot persistence. Any crash or shell exit is a hard outage until a human
   restarts it (exactly what happened in #14/#32).
2. **Duplicate tunnel connections**: the same named tunnel is served by two
   long-lived cloudflared processes (~16h and ~2 days old) — Cloudflare routes
   some edge traffic to the stale connection, producing intermittent 502s even
   while the origin is healthy.
3. **Security wart**: the origin's bearer token is passed in argv and is
   visible to any local user via `ps`.

## Proposal

### 1. `folderforge origin install|uninstall|status` (supervised origin)

A systemd user unit `folderforge-origin.service` that runs the plain HTTP MCP
server with `Restart=on-failure` and `WantedBy=default.target` (boot
persistence), reusing the `control service` machinery after generalizing
`src/control/service.ts`:

- `renderUnit` gains an options bag (description, optional `environmentFile`);
  `unitFilePath`/`installService`/`uninstallService`/`serviceStatusInfo` are
  parameterized by unit name so plane and origin share one implementation. The
  plane's behavior must stay byte-identical (same unit name, same rendered
  unit text) — asserted by a regression test.
- `origin install --project <dir> --port <p> [--host 127.0.0.1]
  [--tools-preset full] [--policy <mode>] [--dangerously-allow-critical]
  [--auth token|api-key|none] [--token <v> | --token-env NAME] [--enable]
  [--replace]`: renders ExecStart WITHOUT any secret. When a token is supplied
  (directly, or read from the named environment variable at install time) it
  is written to `<projectRoot>/.folderforge/origin.env` (mode 0600) as
  `FOLDERFORGE_HTTP_TOKEN=…` (and/or `FOLDERFORGE_HTTP_API_KEYS=…`) and the
  unit references it via a REQUIRED `EnvironmentFile=` line — the existing
  config env overlay already honors and scrubs these variables, so no server
  change is needed for secrets.
- `origin status` prints installed/enabled/active + target project/port (and
  `--json`), mirroring `control service status`.
- Linux-only with the same clear unsupported message as `control service`;
  the unit file is mode 0600.

### 2. Named-tunnel duplicate guard

`TunnelManager.startNamed` gains a best-effort pre-flight: on POSIX, scan the
process table for `cloudflared` processes using `--config <file>` whose file
content maps the same `hostname:` — refuse with an actionable error naming
the pid and config path. The guard never signals or kills anything; a scan
failure warns and proceeds. A new optional `listProcessArgs` dependency on
the manager (default: `ps -eo pid,args` on POSIX, empty list on Windows)
keeps it unit-testable. Quick tunnels are untouched (ephemeral URLs —
duplicates are not a correctness issue there).

### Out of scope (ops step, separate user approval)

Adopting this on the live machine — installing the origin unit for the real
:3112 with the current flags, stopping the manual shell-origin, and removing
the duplicate cloudflared instances — changes how this very chat's MCP
connection is served (brief blip) and is NOT part of this proposal; it needs
its own explicit user approval after merge.

## Threat surface (Security hat)

- Secrets: the token leaves argv entirely (fixing the `ps` exposure); it is
  stored only in a 0600 env file under the project's `.folderforge/` (covered
  by the default denied globs) and referenced via `EnvironmentFile=`. The unit
  carries no secrets — same invariant as proposal 006.
- systemctl is always invoked with fixed argv (no shell) — unchanged.
- The duplicate guard only READS the process table and referenced config
  files; it never signals or kills anything.
- No MCP tool, schema lock, risk class, or policy engine changes — CLI-only
  surface plus an internal manager guard.

## Test plan (QA hat)

- Unit (new `tests/unit/origin-service.test.ts`): install renders a unit with
  no token in ExecStart, `EnvironmentFile=` present exactly when a token was
  given, the token file is 0600 with the value, cross-project `--replace`
  guard, idempotent uninstall, unsupported-platform message, status parses
  unit + is-active; the plane's `control service` rendering stays
  byte-identical after the generalization (regression assert).
- Unit (`tests/unit/tunnel-manager-named.test.ts`): startNamed refuses when a
  scanned cloudflared config maps the hostname (naming pid + config path);
  proceeds when the scan finds nothing or runs on Windows; scan failure warns
  and proceeds.
- Existing suites (`control-service.test.ts`, `tunnels.test.ts`,
  `tunnel-manager-named.test.ts`) must pass unchanged apart from the
  intentional additions.
- Gates: targeted + full suite (run_test async, disclosed per #27) +
  typecheck/lint/build; live proof on the built dist in an isolated
  XDG_CONFIG_HOME + fake project: install → unit content correct (no secret,
  env-file wired, Restart=on-failure, WantedBy) → `systemd-analyze verify`
  clean → status text + `--json` → uninstall idempotent; ZERO real system
  change (no enable/daemon-reload on the host — same discipline as #32's
  proof).

## Rollback

Revert the council branch commit; the plane's control service behavior is
unchanged either way, and no live machine state is touched by this proposal.

## Decision log

- 2026-09-06 — Provisioner Engineer — propose — initial draft (loop #36,
  queue debt "MCP origin chập chờn" from #32; live recon evidence:
  unsupervised origin under a login shell, duplicate cloudflared for the same
  named tunnel, token exposed in argv).
- 2026-09-06 — Security Officer — **approve with amendments** — (1) token
  never in unit/argv; env file 0600 under `.folderforge` (denied-glob
  covered) and `EnvironmentFile=` is REQUIRED (no `-` prefix: a missing
  secrets file must fail loudly); (2) the duplicate guard is read-only,
  best-effort, POSIX-scoped; (3) the generalization must keep the plane unit
  byte-identical; (4) ops adoption on the live machine needs separate user
  approval (it blips this chat's MCP connection).
- 2026-09-06 — QA/Verifier — **approve with amendments** — (1) the
  byte-identical plane-unit regression assert is mandatory; (2) the proof
  stays zero-system-change (isolated XDG_CONFIG_HOME, no enable/daemon-reload
  on the host); (3) full suite via run_test async disclosed per #27; (4) the
  live proof must show the token file is 0600 and the unit contains no token.
- 2026-09-06 — QA/Verifier — **gates green on the final code** — targeted
  69/69 (origin-service 12, tunnel-manager-named 9, control-service 12 +
  control-cli 30 + tunnels 6 regression), typecheck exit 0 (one mid-loop miss:
  a stale single-arg `unsupportedPlatform` call in `serviceStatus` — one-line
  fix, no design change), lint exit 0, build exit 0, full suite 133 files /
  1085 tests PASS (76.81s, run_test async — disclosed per #27), isolated live
  proof PROOF_EXIT:0 (no secret in the unit, required EnvironmentFile= wired,
  env file 0600 holds the token, systemd-analyze verify clean, status text +
  --json, uninstall idempotent ×2, zero host system change).
- 2026-09-06 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #36. The live-machine ops step (install the origin
  unit for :3112 + remove duplicate cloudflared) is NOT covered — separate
  approval.
