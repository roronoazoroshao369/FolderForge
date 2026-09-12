# Proposal 022: tunnel CLI accepts underscore in tunnel names

- Author role: Provisioner Engineer
- Date: 2026-09-12
- Status: implemented (2026-09-12, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Context (product gap found in loop #51)

Loop #51 needed to supervise the operator's named tunnels
`repo_vibecode` and `vibcode-auto-test`. `folderforge tunnel install
--name repo_vibecode` refused: `Invalid tunnel name … (expected
^[a-z0-9][a-z0-9-]{0,31}$)`. Cloudflare allows underscores in tunnel
names (both tunnels exist and serve production traffic), and systemd
accepts underscores in unit names (the hand-rendered
`folderforge-tunnel-repo_vibecode.service` from #51 runs fine). The
regex is stricter than both upstreams it protects.

Until this lands, `tunnel install|status|uninstall` cannot manage
underscore-named tunnels at all — #51 had to hand-render units, and
`tunnel status` stays blind to them.

## Change (minimal)

`src/control/tunnel.ts:35` — widen `TUNNEL_NAME_RE` from
`^[a-z0-9][a-z0-9-]{0,31}$` to `^[a-z0-9][a-z0-9_-]{0,31}$` (underscore
allowed after the first character; the first character stays
alphanumeric so DNS-label-looking names are unaffected). The error
message embeds `TUNNEL_NAME_RE.source`, so it self-updates. Both call
sites (install options.name :88, status/uninstall name :116) share the
constant — one edit covers all three commands.

## Non-goals

- No change to unit rendering, ExecStart shape, or cloudflared flags.
- No uppercase names (Cloudflare lowercases anyway; keep it strict).
- No migration of the hand-rendered #51 units — once merged and the
  dist rebuilds, `tunnel status --name repo_vibecode` simply starts
  seeing them (same unit name convention).

## Tests

Extend `tests/unit/tunnel-service.test.ts` 'validates name, config
absoluteness, and runtime files before writing': assert an
underscore-bearing name (`repo_vibecode`) passes validation and an
install with it writes `folderforge-tunnel-repo_vibecode.service`;
keep asserting rejection of leading `-`/`_`, uppercase, and >32 chars.

## Live proof

XDG_CONFIG_HOME-pinned temp run on the built dist: `tunnel install
--name repo_vibecode --config <temp yml>` writes the unit in the temp
home (zero host change — no --enable, no daemon contact), then
`tunnel status --name repo_vibecode` reports it in text and --json.

## Rollback

Revert the regex change; nothing persists beyond the unit files
operators chose to install.

## Decision log

- 2026-09-12 — Provisioner Engineer — propose — gap evidence from loop
  #51 ops (`tunnel install` refused the operator's real tunnel names).
- 2026-09-12 — Security Officer — approve — wider charset stays within
  what cloudflared and systemd both accept; no new surface, no secret
  handling change.
- 2026-09-12 — QA/Verifier — approve with amendments — the extended
  validation test must keep the negative cases (leading dash/underscore,
  uppercase, overlong) pinned, and the live proof must be XDG-pinned
  with zero daemon contact.
- 2026-09-12 — QA/Verifier — gates green — targeted 9/9 (tunnel-service),
  typecheck/lint/build 0/0/0, full suite 136 files / 1129 tests PASS
  (90.62s, run_test async — disclosed per #27); live proof XDG-pinned:
  underscore install writes the unit, status text/--json report it,
  `_bad` still refused; zero daemon contact.
- 2026-09-12 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #52 (survey approval after the LOOP REPORT).
