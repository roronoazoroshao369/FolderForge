# Proposal 012: supervise named cloudflared tunnels with per-tunnel systemd units

- Author role: Provisioner Engineer
- Date: 2026-09-06
- Status: implemented (2026-09-07, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Debt from ops #36: the cloudflared serving the origin's named tunnel
(folder-forge.musashishao.cc.cd → http://localhost:3112) runs as an ORPHAN —
its parent is systemd --user only via reparenting, not management: no
Restart=, no boot persistence, no journal logs (evidence: pid 2363165,
`cloudflared tunnel --config ~/.cloudflared/folder-forge.yml run folder-forge`,
~56h uptime). If it dies, every client of the tunnel gets 502 even though the
origin behind it is supervised — the intermittent-502 mechanism from #14/#32.
A reboot kills it permanently. Product-side, TunnelManager spawns cloudflared
as a child of the server process, so even product-started named tunnels have
no persistence. The box also runs other orphaned/duplicated named tunnels
(repo_vibecode ×4, vibcode-auto-test ×2) — follow-on ops, out of scope here.

## Proposal

A new CLI namespace, `folderforge tunnel install|uninstall|status`, that
supervises a NAMED cloudflared tunnel via a per-user systemd unit, reusing
the generalized `installUnit` machinery (service.ts):

- Per-tunnel unit `folderforge-tunnel-<name>.service`; `<name>` validated
  `/^[a-z0-9][a-z0-9-]{0,31}$/` so several named tunnels coexist.
- ExecStart: `<bin> tunnel --config <configPath> run <name>`; `bin` defaults
  to `/usr/local/bin/cloudflared` with an optional `--bin` override, both
  validated via fileExists. `configPath` must be an existing ABSOLUTE path
  (the yml carries only the tunnel id + ingress; the credentials JSON stays
  0400 and is read by cloudflared itself — the unit holds NO secrets).
- service.ts gains a small additive extension: `InstallUnitOptions.runtimeFiles?:
  string[]` overrides the execPath/mainJs existence check, and `mainJs` becomes
  optional (existing callers pass it unchanged; the plane/origin error message
  shape is preserved when `runtimeFiles` is not set — byte-identical plane
  regression test must stay green).
- No network-online.target ordering: cloudflared retries connections
  internally, and Restart=on-failure + RestartSec=5 self-heals boot ordering.
- Reinstalling the same tunnel name overwrites the unit — config changes are
  the normal update path; the replace-guard keys off --project which tunnel
  units lack, so it does not fire (documented); `--replace` is accepted for
  parity and unnecessary.
- `status` is tailored for tunnels: name + config path (parsed from the unit)
  + enabled/active, text and `--json`.
- No MCP tool, schema-lock, risk-class, or policy changes; no new flags beyond
  `--name/--config/--bin/--enable/--replace/--json`.

### Out of scope (ops step, separate user approval)

Adopting the live folder-forge tunnel on this machine (install the unit, stop
the orphan pid 2363165, enable --now) — restarts the tunnel process, briefly
blipping this chat's MCP. Dedupe/units for repo_vibecode and vibcode-auto-test
are follow-on ops with their own approvals.

## Threat surface (Security hat)

- The unit is 0600 and contains no secrets; the tunnel credentials stay in
  cloudflared's own 0400 JSON, referenced only via the config path.
- `name` is restricted to lowercase DNS-ish characters, so it cannot inject
  into the unit file name or ExecStart; configPath/bin are rendered through
  the existing quoteArg.
- status/uninstall never print file contents; uninstall leaves the yml and
  credentials untouched (the message says so).

## Test plan (QA hat)

- New tests/unit/tunnel-service.test.ts mirroring the origin-service harness
  (fake systemctl, XDG temp): happy-path install (exact ExecStart, no
  EnvironmentFile, unit 0600, Restart/WantedBy), validation cases (bad name,
  missing/relative config, missing bin via --bin), reinstall-overwrite
  behavior, uninstall idempotent + config-kept note, status text + --json,
  darwin unsupported, executeTunnelCli end-to-end flag parse +
  help/unknown-flag rejection; control-service byte-identical plane
  regression and origin-service 16 tests stay green unchanged.
- Gates: typecheck/lint/build + targeted (tunnel-service + control-service +
  origin-service + control-cli) + full suite (process_start) + isolated live
  proof in a temp XDG with a systemctl SHIM (the #38 lesson: XDG isolation
  does not cover the DBus call) and `--bin /bin/true` as the stand-in binary:
  install → systemd-analyze verify clean → status → uninstall → host state
  untouched (the serving tunnel and :3112 unchanged).

## Rollback

Revert the branch commit; no live unit is touched by this proposal (adoption
is the separate ops step).

## Decision log

- 2026-09-06 — Provisioner Engineer — propose — machine evidence: folder-forge
  cloudflared is a reparented orphan (pid 2363165, no unit on the box);
  TunnelManager children die with the server; installUnit is generic enough to
  reuse after the #38 extension.
- 2026-09-06 — Security Officer — **approve with amendments** — no secrets in
  the unit (credentials remain cloudflared's 0400 files); strict name
  validation; quoteArg reuse; no new MCP surface.
- 2026-09-06 — QA/Verifier — **approve with amendments** — the live proof must
  use the systemctl shim from #38's lesson and must assert the host tunnel is
  untouched; the plane byte-identical regression and origin-service suite are
  mandatory regressions.
- 2026-09-07 — QA/Verifier — gates evidence: targeted 67/67 PASS
  (tunnel-service 9 + origin-service 16 + control-service 12 byte-identical
  regression + control-cli 30), typecheck/lint/build = 0/0/0, full suite
  134 files / 1098 tests PASS (77,79s, process_start without the PATH pin —
  durable proof of proposal 011 across origin restarts); live proof PASS with
  a systemctl shim and --bin /bin/true stand-in (zero host change; the host
  tunnel and :3112 untouched). Mid-loop note: the first suite run's outcome
  was lost when the origin was SIGKILLed externally (3× today); re-ran once
  with tee'd evidence (disclosed, not a blind retry). New wart for the
  queue: investigate the periodic origin SIGKILL.
- 2026-09-07 — User — **approve Git** ("vậy tiếp tục logic đi" after the LOOP
  REPORT's explicit ask): commit + merge main + push for the 6 files. Ops
  adoption of the live folder-forge tunnel remains a separate approval after
  merge.
