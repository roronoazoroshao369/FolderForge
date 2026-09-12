# Proposal 021: OpenAI tunnel supervisor accepts --dangerously-allow-critical

- Author role: Provisioner Engineer
- Date: 2026-09-12
- Status: implemented (2026-09-12, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Context (user-reported bug, loop #50)

User report: "start OpenAI tunnel cứ bị lỗi" on fleet instance
`flt_8aa5f0dd` (Poker Master OS, port 7412, policy `danger`,
`allowCriticalInDanger: true`). The Fleet banner showed the generic
"OpenAI tunnel supervisor exited unexpectedly."

## Root cause (evidence, not speculation)

1. `FleetManager.openAiTunnelCommand` (fleet-manager.ts:1185) emits
   `--dangerously-allow-critical` when `policyMode === 'danger' &&
   allowCriticalInDanger === true` (proposal 005 semantics).
2. The supervisor's parser `parseOpenAiTunnelArgs`
   (chatgpt/openai-tunnel.ts:243) does not know that flag —
   `rg 'dangerously' src/chatgpt/openai-tunnel.ts` → 0 matches — and
   throws `Unknown OpenAI tunnel option` (line 402); the CLI prints help
   and exits 1 BEFORE opening any server log.
3. Bounded manual repro of the exact fleet-emitted argv (2026-09-12):
   exit 1 + help text in 0.7s. No fresh log in the project state dir;
   port 7412 free; plane journal silent → death happens at arg-parse.
4. `handleOpenAiTunnelExit` found no recognizable fatal line in the help
   output → the record kept the generic lastError (post-#42 honesty path
   had nothing to extract).

Instances without the opt-in (e.g. flt_2fe0fea8) are unaffected — the
flag is only emitted for danger + allowCriticalInDanger.

## Change

`src/chatgpt/openai-tunnel.ts`:

1. `OpenAiTunnelOptions.allowCriticalInDanger?: boolean` + parser case
   `--dangerously-allow-critical` + help line.
2. Guard mirroring the main CLI invariant: the flag combined with an
   explicit `--policy <mode>` other than `danger` is rejected at parse
   time (profile-driven resolution stays permissive — the fleet emit
   site already guarantees the combination).
3. Propagate into the embedded loopback MCP server:
   `buildFolderForgeServerArgs` accepts and appends
   `--dangerously-allow-critical` so the tunnel-served server honors the
   same CRITICAL-bypass opt-in the operator set on the instance
   (proposal 005 parity).

## Non-goals

- No fleet-manager change (its emit site is correct).
- No new approval/audit surface; no change for instances without the
  opt-in (argv byte-identical when the flag is absent).
- No retry-loop in the UI; the banner already reflects the record.

## Tests

- Unit (tests/unit/openai-tunnel.test.ts): parser accepts the flag and
  `buildFolderForgeServerArgs` propagates it; explicit non-danger
  `--policy` + flag is rejected; argv without the flag stays
  byte-identical.
- Cross-contract regression (tests/unit/provisioner.test.ts): the exact
  string `openAiTunnelCommand` builds for a danger + allowCriticalInDanger
  record parses cleanly through `parseOpenAiTunnelArgs` (prevents this
  bug class — fleet argv vs supervisor parser drift).
- CHANGELOG [Unreleased] ### Fixed.

## Live proof

Bounded manual run of the previously-failing argv (timeout 20s): must
get past arg-parse (no help text; either a dry-run launch plan or a live
supervisor that survives the timeout). Zero host state changes; the real
user-facing retry (click Start on the plane) happens after merge + plane
restart (separate ops approval — the running plane has pre-fix code in
memory).

## Rollback

Revert the proposal merge; instances without the opt-in are unaffected
either way.

## Decision log

- 2026-09-12 — Provisioner Engineer — propose — user-reported failure on
  flt_8aa5f0dd; root cause proven by bounded repro (help + exit 1 at
  arg-parse).
- 2026-09-12 — Security Officer — approve — propagates an existing
  operator opt-in (proposal 005) into the tunnel-served server; guard
  mirrors the main CLI; no new surface, no secret handling change (key
  file path untouched).
- 2026-09-12 — QA/Verifier — approve with amendments — the
  cross-contract regression test (fleet argv → supervisor parser) is
  mandatory; live proof must show the previous argv gets past parse.
- 2026-09-12 — QA/Verifier — gates green — targeted 59/59 (openai-tunnel 19
  + provisioner 40, incl. the cross-contract test), typecheck/lint/build
  0/0/0, full suite 136 files / 1129 tests PASS (89.82s, run_test async —
  disclosed per #27); live proof: the previously-failing argv survives the
  20s bounded run (MCP ready on :7412, tunnel client connecting, clean
  teardown). Two mid-loop failures were harness bugs in the new test
  (stray 'chatgpt' token; the stub's " @ <cwd>" suffix) — fixed in the
  harness, no product change.
- 2026-09-12 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #50 (survey approval after the LOOP REPORT).
