# Proposal 011: capture the operator PATH in the supervised origin unit

- Author role: Provisioner Engineer
- Date: 2026-09-06
- Status: implemented (2026-09-06, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Wart discovered in loop #37 (follow-up of ops #36): the supervised origin
(`folderforge-origin.service`) runs under systemd's minimal default PATH.
The unit pins the node binary in ExecStart, so the server itself is fine —
but every child the origin spawns (shell_exec, run_test, process_start,
verification checks) resolves `node`/`npm` from that minimal PATH, landing
on the system node 20 (`/usr/bin/node` v20.20.2) instead of the operator's
toolchain (nvm node v22.23.0). Anything importing execa crashes at import
time (`TEXT_ENCODINGS.union is not a function` — Set.prototype.union needs
Node 22+): in #37 the full suite failed 46 files / 8 tests under the
origin-spawned environment and passed 133/1085 with PATH pinned to nvm
node 22. The pre-#36 manual origin never had this problem because it
inherited the login shell's PATH.

## Proposal

`origin install` captures the installer process's `PATH` (via
`deps.getEnv('PATH')`) and renders it into the unit as an
`Environment="PATH=…"` line in [Service]:

- `renderUnit` gains an optional 5th parameter
  `environment?: Record<string, string>`; entries render as
  `Environment=KEY=VALUE` lines right after ExecStart, quoted by the
  existing `quoteArg` (bare when safe, double-quoted with escapes
  otherwise). The plane never passes it — the byte-identical plane-unit
  regression test stays green unchanged.
- `installUnit` forwards the option; `installOrigin` passes `{ PATH }`
  when the installer's PATH is defined and non-empty (graceful skip
  otherwise — no Environment line at all).
- No new CLI flag: mirroring the installer's environment is the same
  philosophy as mirroring argv. Secrets stay exclusively in origin.env
  (0600) — PATH is not a secret and belongs in the readable unit.
- Works for `--auth none` installs too (no dependence on the env file).

### Out of scope (ops step, separate user approval)

Re-installing the live :3112 origin so its unit gains the captured PATH —
that restarts this chat's MCP origin (brief blip) and needs its own
approval after merge.

## Threat surface (Security hat)

- PATH is environment config, not a credential: it goes in the unit,
  never in origin.env. The unit stays 0600 and gains no secrets.
- Quoting reuses quoteArg's escape rules (" \ $ `). No new CLI flags, no
  policy / schema-lock / risk-class changes.

## Test plan (QA hat)

- New origin-service cases: PATH captured alongside secrets (Environment
  and EnvironmentFile both present); auth=none gets Environment=PATH
  without any env file; a PATH containing a space renders quoted; a
  missing PATH renders no Environment line. All 12 existing tests keep
  passing with the current harness (which defines no PATH).
- Gates: typecheck/lint/build + targeted (origin-service + control-service
  byte-identical regression + control-cli) + full suite (process_start
  with the PATH pin — the workaround stays necessary until the live
  origin is re-installed) + isolated live proof in a temp XDG: install
  with a sentinel PATH → unit contains the Environment line →
  systemd-analyze verify clean; zero host change.

## Rollback

Revert the branch commit; the live origin unit is untouched by this
proposal (re-install is the separate ops step).

## Decision log

- 2026-09-06 — Provisioner Engineer — propose — wart evidence from #37
  (execa import crash under the origin-spawned node 20; 133/1085 green
  under pinned node 22; systemd minimal PATH proven by env probe).
- 2026-09-06 — Security Officer — **approve with amendments** — PATH is
  environment config, not a secret: it goes in the unit, never in
  origin.env; quoteArg reuse is mandatory; no new flags.
- 2026-09-06 — QA/Verifier — **approve with amendments** — the auth=none
  coverage case is mandatory; the plane byte-identical regression test
  must pass unchanged; the live proof stays zero-host-change.
- 2026-09-06 — QA/Verifier — gates evidence: targeted 58/58 PASS
  (origin-service 16 + control-service 12 + control-cli 30),
  typecheck/lint/build = 0/0/0, full suite 133 files / 1089 tests PASS
  (78,34s, process_start with the PATH pin — disclosed); live proof v2
  PASS with a systemctl shim (zero host change truly). Two mid-loop
  council-side defects fixed and re-verified on the final code: a
  redaction placeholder pasted into a new test (harness), and quoteArg
  covering the Environment= directive name instead of only the
  KEY=VALUE assignment (caught by the new quoting test).
  Note for future proofs: any isolated proof invoking a unit-managing
  CLI must shim systemctl — XDG isolation does not cover the DBus call.
- 2026-09-06 — User — **approve Git** (survey): commit + merge main +
  push for the 5 files. Ops (re-install the live :3112 origin so its
  unit gains PATH, restore the supervised origin, dedupe cloudflared)
  remain a separate approval after merge.
