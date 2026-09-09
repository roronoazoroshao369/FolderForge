# Proposal 016: warn when a negative OOMScoreAdjust will be inert

- Author role: Provisioner Engineer
- Date: 2026-09-09
- Status: implemented (2026-09-09, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

OPS loop #44 applied proposal 013 on the real host and produced decisive
evidence of an honesty gap in the unit machinery:

- `folderforge origin install` / `tunnel install` render
  `OOMScoreAdjust=-500` into the unit (verified: `systemctl --user show` sees
  the directive as loaded), install output says success — but the running
  process keeps its default OOM score (origin 200, tunnel 100).
- Root cause (verified on the operator box): lowering `oom_score_adj`
  requires `CAP_SYS_RESOURCE`; an unprivileged `systemd --user` manager
  cannot apply a negative `OOMScoreAdjust`. Decisive probe:
  `echo -500 > /proc/self/oom_score_adj` → `Permission denied`; the user
  manager's `DefaultOOMScoreAdjust=200`.
- systemd treats the failure as non-fatal: the unit starts anyway and
  nothing in the install output tells the operator the protection is inert.
  The unit file claims a protection the runtime silently does not provide.

So today `origin install` / `tunnel install` can print an unqualified
success while the flagship OOM hardening of proposal 013 is a no-op on
exactly the host class it was designed for (unprivileged user units).

## Proposal

One additive, output-only change in the shared install path
(`src/control/service.ts`) — no schema, no argv, no new flags:

1. `capEffHasSysResource(capEffHex: string): boolean` — exported pure helper;
   tests bit 24 (CAP_SYS_RESOURCE) of a capability hex mask via BigInt;
   unparseable input → false.
2. `defaultCanLowerOomScore(): boolean` — reads `/proc/self/status` `CapEff:`
   as the user-equivalent capability proxy (the installing CLI process runs
   with the same capability set as the user's systemd manager). Any read/
   parse failure → false (fail-safe: warn rather than stay silent).
3. `ServiceDeps` gains optional `canLowerOomScore?: () => boolean` (test
   seam; existing dep factories stay unchanged and get the default probe).
4. `installUnit` pushes a warning line into the install output when ALL of:
   `oomScoreAdjust !== undefined`, the value is negative (only decreases need
   the capability — raising the score always works), `platform === 'linux'`,
   and the probe says the capability is missing. The unit file is still
   written WITH the directive unchanged — it is correct for privileged
   setups and inert-but-harmless otherwise; only the messaging changes.

Warning text (single line):
`Note: OOMScoreAdjust=-500 needs CAP_SYS_RESOURCE to take effect — an
unprivileged systemd --user manager keeps the default OOM score at runtime
(verified on this host class). The directive stays in the unit for
privileged setups.`

Behavioral notes:

- The plane path passes no `oomScoreAdjust` → the plane install output stays
  byte-identical (existing regression contract holds).
- Existing origin/tunnel tests do not inject the probe; their output
  assertions are `toContain`-style, so the extra line cannot break them on
  either host class. New tests inject the stub for determinism.
- Non-goals: dropping the directive when inert (wrong — it is valid for
  privileged setups and for the day the host gains the capability);
  attempting a sudo/system-level install (operator decision, documented in
  the track log queue); any change to renderUnit's range/integer guard.

## Threat surface (Security hat)

- No new input surface: the probe takes no arguments and reads a fixed
  kernel pseudo-file (`/proc/self/status`) of the CLI's own process — no
  foreign-pid or user-controlled path. Nothing secret is read or printed.
- Output-only change: install exit codes, unit contents, daemon interactions
  (daemon-reload / enable --now) are all unchanged.
- Fail-safe direction: unreadable capability state → warn. A false warning
  is harmless guidance; a false silence is the bug being fixed.
- The capability hex is parsed as BigInt from a fixed `/proc` field — no
  injection surface into the unit (the value never enters the unit text).

## Test plan (QA hat)

- Unit (`tests/unit/control-service.test.ts`, new describe on `installUnit`
  with a minimal spec): negative value + probe false → output contains
  `CAP_SYS_RESOURCE` warning AND the unit file still contains
  `OOMScoreAdjust=-500` (directive not dropped); probe true → no warning;
  positive value + probe false → no warning; no oomScoreAdjust → no warning.
- Pure helper tests: `capEffHasSysResource('0000000000000000')` → false;
  bit-24 mask (`'0000000001000000'`) → true; full mask
  (`'000001ffffffffff'`) → true; garbage → false.
  `defaultCanLowerOomScore()` returns a boolean on the test host.
- Wiring test (`tests/unit/origin-service.test.ts`): `installOrigin` with
  `canLowerOomScore: () => false` → output warns AND unit keeps the
  directive (proves the option flows origin → installUnit).
- Regression: plane byte-identical render contract + all existing
  control/origin/tunnel service tests pass unchanged on this unprivileged
  host (proves toContain-style robustness).
- Gates: targeted (control-service + origin-service + tunnel-service +
  control-cli), typecheck/lint/build 0/0/0, full suite (run_test async,
  disclosed per #27).
- Live proof on the built dist, isolated: `XDG_CONFIG_HOME=/tmp/ff45-proof
  node dist/main.js origin install --project <tmp> --port <n> --auth none`
  (no `--enable` → zero systemctl calls, zero daemon contact — the #38
  lesson makes shim unnecessary here); assert the output carries the warning
  on this host (no CAP_SYS_RESOURCE — same probe evidence as #44) and the
  written unit still carries `OOMScoreAdjust=-500`; then `rm -rf` the temp
  XDG dir. Zero host change.

## Rollback

Revert the branch commit; install output loses the warning line, units and
behavior otherwise unchanged. No data or state risk either way.

## Decision log

- 2026-09-09 — Provisioner Engineer — propose — OPS #44 evidence: directive
  present in unit (as-loaded) but runtime oom_score_adj unchanged
  (origin 200 / tunnel 100); `echo -500 > /proc/self/oom_score_adj` →
  EPERM; `DefaultOOMScoreAdjust=200`. Honesty gap: install prints success
  while the protection is silently inert on unprivileged user managers.
- 2026-09-09 — Security Officer — **approve with amendments** — (1) the
  probe must be read-only against the CLI's own `/proc/self/status` (no
  foreign pids, no user-controlled path); (2) nothing secret read/printed;
  (3) fail-safe = warn on unreadable state; (4) the probed value must never
  enter the unit text or argv. This approval does NOT cover merge/push —
  Git needs separate user approval.
- 2026-09-09 — QA/Verifier — **approve with amendments** — (1) tests must
  be deterministic across host classes: new tests inject the probe stub,
  existing untouched tests must be proven `toContain`-robust; (2) the unit
  file must be asserted to KEEP the directive in the warning case (no
  silent drop); (3) the isolated proof must make zero systemctl/daemon
  contact (no --enable, temp XDG, rm cleanup); (4) full-suite evidence
  method disclosed per the #27 convention.
- 2026-09-09 — QA/Verifier — **gates green on the final code** — targeted
  73/73 (control-service 13→17 incl. the new installUnit OOM-warning
  describe: warns + keeps directive / silent when capable, positive, or
  unset / CapEff bit-24 helper; origin-service 16→17 wiring test through
  installOrigin), typecheck exit 0, lint exit 0 (eslint --max-warnings=0),
  build exit 0 (dist contains the probe), full suite **134 files / 1112
  tests PASS** (75.76s, run_test async — disclosed per #27; 1112 = 1108 +
  exactly the 4 new tests), live proof PROOF_DONE (XDG-temp origin install
  --auth none --port 7433, no --enable → zero daemon contact: output
  carries the CAP_SYS_RESOURCE warning AND the unit keeps
  OOMScoreAdjust=-500; real host unit and origin pid 3834033 untouched;
  temp dirs removed). The one mid-loop failure was the council's own edit
  anchor (diff-view indentation) — harness, no product change.
- 2026-09-09 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #45 (survey approval after the LOOP REPORT).
