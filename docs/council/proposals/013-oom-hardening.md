# Proposal 013: OOM protection for connection-critical supervised units

- Author role: Provisioner Engineer
- Date: 2026-09-07
- Status: implemented (2026-09-08, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

The supervised MCP origin runs with oom_score_adj=200 (observed live on the
operator box), i.e. the OOM killer ranks it ABOVE the default when the box
runs out of memory — and the box is under real memory pressure (16GB RAM,
swap 3866/4095MB used; evidence: loop #41 recon). If the kernel OOM-kills
the origin, every MCP client 502s until Restart=on-failure recovers; the
same applies to the supervised cloudflared tunnel. Loop #40 proved the
three recent SIGKILLs were manual operator kills, not OOM — but the memory
pressure makes a real OOM event a matter of time, and these two units are
the connection-critical processes on the box (their death = hard outage).

## Proposal

A small additive extension to the unit machinery (service.ts), same pattern
as proposals 011 (environment) and 012 (runtimeFiles):

- `InstallUnitOptions.oomScoreAdjust?: number` — when set, renderUnit emits
  `OOMScoreAdjust=<n>` in [Service] (after the EnvironmentFile= block,
  before Restart=). renderUnit throws on a non-integer or out-of-range
  value (kernel range -1000..1000) — internal misuse guard, not user input.
- `origin install` passes oomScoreAdjust: -500 (fixed constant — the
  supervised origin is the MCP entrypoint; protect-but-not-immune).
- `tunnel install` passes oomScoreAdjust: -500 (same criticality: tunnel
  death = 502 for every client).
- The plane unit (PLANE_UNIT / installService) passes NOTHING — its render
  stays byte-identical (the existing regression test must stay green).
- No new CLI flags, no MCP surface, no schema-lock/policy changes. The
  value is a fixed product decision, not user input (Security).

### Out of scope (host-level, no repo change)

- fs.inotify.max_user_watches is exhausted on the operator box (benign
  "No space left on device" journal noise on unit restarts) — user-level
  sudo sysctl bump, documented as a host note only.
- Swap pressure (3866/4095MB) — user-level capacity review (elasticsearch,
  gopls, VS Code server are the top residents), not a repo concern.
- Re-installing the live origin + tunnel units to pick up the new directive
  — ops step, separate user approval, blips this chat's MCP briefly.

## Threat surface (Security hat)

- No new user-controlled input: the constant -500 is compiled in; nothing
  reads it from argv/env/config.
- renderUnit validation (integer, -1000..1000) prevents internal callers
  from ever rendering an invalid directive.
- A negative adjust could theoretically starve OTHER processes of the OOM
  reprieve — mitigated by choosing -500 (moderate) over -1000 (near-immune)
  and applying it only to the two small, connection-critical units
  (origin ~70MB RSS, cloudflared ~40MB), not to the plane or fleet
  instances.

## Test plan (QA hat)

- control-service.test.ts: renderUnit with oomScoreAdjust emits
  OOMScoreAdjust=<n> after the EnvironmentFile block; throws on 1001 and
  1.5; plane unit render stays byte-identical (existing regression).
- origin-service.test.ts: installed origin unit contains
  OOMScoreAdjust=-500 (happy-path install assertion).
- tunnel-service.test.ts: installed tunnel unit contains
  OOMScoreAdjust=-500.
- Gates: targeted (origin-service + tunnel-service + control-service +
  control-cli), typecheck/lint/build, full suite (process_start, no PATH
  pin), isolated live proof (temp XDG + systemctl shim): install origin
  auth=none → unit has OOMScoreAdjust=-500 → systemd-analyze verify clean
  → uninstall; same for a tunnel install with --bin /bin/true.

## Rollback

Revert the branch commit; units already installed without the directive are
unaffected (the line is optional). Removing the line from a live unit is a
plain re-install.

## Decision log

- 2026-09-07 — Provisioner Engineer — propose — machine evidence: origin
  oom_score_adj=200 with swap 3866/4095MB used (loop #41 recon); the two
  connection-critical units have no OOM protection while hosting every MCP
  session.
- 2026-09-07 — Security Officer — **approve with amendments** — fixed
  constant (no new input surface), -500 not -1000, origin+tunnel only
  (plane and fleet untouched), renderUnit range/integer guard mandatory.
- 2026-09-07 — QA/Verifier — **approve with amendments** — plane
  byte-identical regression stays green; out-of-range throw tests
  mandatory; isolated proof uses the systemctl shim (#38 lesson) and must
  assert zero host change.
- 2026-09-08 — QA/Verifier — gates green on final code: targeted 68/68
  (control-service 13 incl. new renderUnit OOM guard test, origin 16,
  tunnel 9, control-cli 30), typecheck/lint/build 0/0/0, full suite
  134 files passed (0 fail, 82.35s, transient systemd-run service with
  captured PATH — evidence /tmp/ff41-suite4.log); isolated live proof
  PROOF_DONE (both units emit OOMScoreAdjust=-500 exactly once, PATH
  mirror intact, systemd-analyze verify clean x2, shim uninstall, zero
  host change). Mid-loop incident (manual origin kill + hand restart →
  EADDRINUSE StartLimit trip) recovered per user survey; runtime-soak
  failure in suite attempt 1 proven load-flake (3/3 in attempt 2).
- 2026-09-08 — User — **Git approved** via survey (sequencing choice:
  close loop #41 Git first, then open loop #42 on a clean tree).
