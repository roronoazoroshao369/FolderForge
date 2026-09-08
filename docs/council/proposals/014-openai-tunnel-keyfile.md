# Proposal 014: Durable OpenAI tunnel key delivery + honest failure surfacing + plane env file

- Author role: Provisioner Engineer
- Date: 2026-09-08
- Status: implemented (2026-09-08, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

The Fleet "OpenAI Secure MCP Tunnel" supervisor resolves the OpenAI API key
from the SPAWNING plane's environment (`--api-key-env CONTROL_PLANE_API_KEY`
→ resolveApiKeyRef throws "No runtime API key found…" when unset). Evidence
(loop #42 diagnostics, 2026-09-08, read-only): two operator start attempts
(09:11:44/49 +07) failed because the optional key field was left empty and
the plane process (manually restarted 09:10:20 after the systemd plane was
stopped 09:10:03) carries zero CONTROL_PLANE_* / OPENAI_* variables — and
the systemd unit never had one either. The supervisor throws BEFORE opening
its log, and handleOpenAiTunnelExit (fleet-manager.ts) only special-cases
EADDRINUSE, so the UI shows a bare "OpenAI tunnel supervisor exited
unexpectedly." with no actionable cause. Worse, the supervisor reports
fatals as plain-text "✗ <message>" sink lines (openai-tunnel.ts main
catch), which the existing exitFatalReason extractor cannot match — it only
scans pino JSON lines. Operator ask (survey-approved 3-item scope):
durable + precise fix — key-file delivery, honest failure surfacing,
boot-persistent env for the systemd plane.

## Proposal

### 1. Key-file spawn for the Fleet OpenAI tunnel (root fix)

- Delivery precedence (unchanged semantics): an EXPORTED env var wins over a
  stored key. New behavior only for the case "stored key exists AND the env
  var is absent in the plane env": the plane writes the key to
  `<fleetDir>/<instanceId>.openai-key` (0600, direct write with a symlink
  guard, no concurrent reader — the write completes before spawn) and spawns
  the supervisor with `--api-key-file <path>` INSTEAD of `--api-key-env`.
  (resolveApiKeyRef checks apiKeyEnv FIRST and would throw before ever
  reading the file, so the env flag must be omitted when the file is used.)
- Env var present → unchanged: `--api-key-env`, no file written.
- No key anywhere → unchanged: `--api-key-env`; the supervisor's error is
  now surfaced verbatim (see 2).
- The fleet record gains `apiKeyFile?: string` (a PATH, not a secret);
  the raw key keeps never appearing in argv, API responses, audit, or logs
  (public-instance clone strips apiKeyFile alongside apiKey).
- Why file over the existing env injection: an injected env var is readable
  via /proc/<pid>/environ by any same-uid process for the supervisor's whole
  lifetime (the supervisor only scrubs the INNER server env,
  openai-tunnel.ts:1348); a 0600 file read once at startup removes that
  window and decouples tunnel start from the plane's env entirely.

### 2. Honest failure surfacing (UX fix)

- handleOpenAiTunnelExit gains the fatalReason suffix like handleExit:
  `OpenAI tunnel supervisor exited unexpectedly: <reason>`.
- exitFatalReason is extended to ALSO recognize the supervisor's plain-text
  fatal marker `✗ <message>` (single bottom-up scan, both patterns per line,
  trimmed, same 240-char cap). EADDRINUSE handling unchanged (still wins).

### 3. Optional EnvironmentFile for the plane unit (boot persistence)

- renderUnit/InstallUnitOptions gain `optionalEnvironmentFile?: string` →
  emits `EnvironmentFile=-<path>` (systemd '-' prefix = boot normally when
  absent) immediately after the required-EnvironmentFile position.
- The plane install passes `<projectRoot>/.folderforge/control.env`.
  Operators who want the GPT tunnel to survive under the systemd plane
  create that file (0600) with CONTROL_PLANE_API_KEY=... — one help-text
  line in `control service install --help` + CHANGELOG note.
- The plane unit's byte-identical regression expectation is updated
  DELIBERATELY (survey-approved scope); origin/tunnel units must NOT gain
  the optional line (asserted absent).
- SPA copy fix (Fleet.tsx banner): "injected into the supervisor's
  environment" → "delivered via a 0600 key file" (honest docs).

## Threat surface (Security hat)

- Key file: 0600 inside the fleet state dir (covered by DEFAULT_DENIED_GLOBS
  like the config store); symlink guard before write; never in argv (only
  the path), never in API responses, never audited (audit keeps the existing
  non-secret "key=pasted" style markers).
- No tool-surface change: provision_openai_tunnel_start inputSchema is
  UNCHANGED (schema-lock safe); no new flags on MCP tools; no policy or
  permission changes.
- /proc environ exposure window eliminated for the stored-key path.
- Dash-prefixed EnvironmentFile cannot break plane boot when control.env is
  absent (systemd ignores missing files with '-').

## Test plan (QA hat)

- provisioner.test.ts (extend the 4 existing startOpenAiTunnel cases):
  stored key + env absent → key file written (0600, exact content, no
  symlink follow), argv carries --api-key-file <path> and NOT
  --api-key-env, neither argv nor spawn env contains the raw key; env
  present + stored key → argv keeps --api-key-env and NO file is written
  (precedence); no key anywhere → argv unchanged vs today; public clone
  strips apiKeyFile.
- Exit surfacing: buffered pino level-50 err → suffix shown; buffered
  "✗ No runtime API key found…" plain line → suffix shown; EADDRINUSE still
  maps to the port message; empty output → bare message (unchanged).
- control-service.test.ts: renderUnit optionalEnvironmentFile emits the
  dash-prefixed line at the right position; plane unit expected string
  updated (contains EnvironmentFile=-…/.folderforge/control.env); origin
  and tunnel renders assert ABSENCE of the optional line.
- Gates: targeted (provisioner + control-service + control-cli),
  typecheck/lint/build (incl. SPA build), full suite via transient
  systemd-run service with captured PATH (#41 lesson), isolated live proof:
  dist `connect chatgpt --openai-tunnel --api-key-file <dummy>` gets PAST
  key resolution (fails later, proving the fix) vs no-key run failing with
  the key error; `control service install` in temp XDG + systemctl shim →
  unit carries the optional line → systemd-analyze verify clean → zero host
  change.

## Rollback

Revert the branch commit. Existing fleet records keep working (env path
unchanged); a stale 0600 key file is reused-or-ignored; plane units
installed without the optional line are unaffected.

## Decision log

- 2026-09-08 — Provisioner Engineer — propose — operator hit
  "OpenAI tunnel supervisor exited unexpectedly" twice (fleet.json evidence);
  root cause chain proven read-only: env-var-only key resolution + plane env
  lacks the var + fatal swallowed by the exit handler.
- 2026-09-08 — Security Officer — approve with amendments — key file 0600
  inside the denied-globs fleet dir, symlink guard, raw key never in
  argv/env/API/audit (public clone strips apiKeyFile too); env-var precedence
  preserved (exported wins → no file written); provision_openai_tunnel_start
  schema unchanged (no schema-lock touch); dash-prefixed EnvironmentFile
  cannot break plane boot when control.env is absent.
- 2026-09-08 — QA/Verifier — gates green on final code: targeted 108/108
  (provisioner incl. rewritten key-file test + env-wins + exit-surfacing
  ✗/pino/bare; control-service incl. new renderUnit optional-env-file test +
  plane install assertion; origin/tunnel absence asserted),
  typecheck/lint/build 0/0/0 (incl. SPA build), full suite 134 files / 1102
  tests PASS (75.95s, transient systemd-run service with captured PATH —
  attempt 1 died on a council harness slip (cd outside systemd-run → wrong
  cwd), attempt 2 green; evidence /tmp/ff42-suite2.log); isolated proof
  PROOF_DONE (plane unit carries the optional env-file line, systemd-analyze
  verify clean, shim uninstall clean; negative control fails with the exact
  key error while --api-key-file proceeds past key resolution into the
  tunnel-client stage; host untouched, verified via /usr/bin/systemctl).
- 2026-09-08 — User — Git approved — "tiếp tục" after the LOOP REPORT whose
  only pending step was Git (standing interpretation per proposal 012's
  decision log).
