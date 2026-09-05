# Proposal 005: Opt-in allowCriticalInDanger for fleet instances

- Author role: Provisioner Engineer
- Date: 2026-09-05
- Status: implemented
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Council #29 review finding (user-reported): an MCP instance provisioned with
`policyMode: danger` still approval-gates CRITICAL tools, because
`allowCriticalInDanger` is only reachable as a CLI flag
(`--dangerously-allow-critical`, which itself requires `--policy danger`) and
the fleet provisioner has no way to set it. Fleet children run with
`dashboard: enabled: false`, so a pending approval on such an instance is
practically unresolvable — a danger-mode fleet instance hits a dead end on
CRITICAL tools (`git_push`, `game_eval`, `marketplace_sync`, ...). Operators
who intentionally run an isolated, autonomous instance have no governed way to
express that choice.

## Proposal

Add an explicit, default-off opt-in that lets a fleet instance run CRITICAL
tools without per-call approval:

1. `FleetInstance` gains optional `allowCriticalInDanger?: boolean` (absent =
   off). `FleetManager.create` accepts it and rejects it when the resolved
   policy mode is not `danger` (`allowCriticalInDanger requires policyMode
   "danger"` — mirrors the CLI guard). New setter
   `setAllowCriticalInDanger(id, allow)` applies the same validation against
   the instance's current mode. `setPolicyMode` drops the flag when switching
   away from `danger`, keeping the invariant (flag ⇒ danger) at all times.
2. Spawn path: `startCommand` (and `openAiTunnelCommand` for consistency)
   append `--dangerously-allow-critical` only when both the flag and
   `policyMode === 'danger'` hold. The argument is rebuilt from the current
   record on every start, so changes apply on the next start/restart — the
   same contract as preset/policy changes. No config-YAML change: the CLI flag
   is the live path (same as `--policy`).
3. Tools: `provision_create` and `provision_update` accept optional
   `allowCriticalInDanger: boolean`. Additive input only — schema-lock
   untouched (name/mutates/risk unchanged, per the #16 precedent). Audit
   `provision_event` summaries note the flag when set or changed.
4. Dashboard: `POST /fleet/:id/policy` additionally accepts
   `allowCriticalInDanger` (optional boolean) and applies both setters in one
   call.
5. SPA Configure modal: an "Allow CRITICAL tools" toggle appears only when
   policy = danger, with a red warning banner stating that CRITICAL actions
   will run without approval on this instance. Fleet cards show a persistent
   badge while the flag is on. The instance type gains the optional field.
6. Runbook: `docs/public-mcp-runbook.md` explicitly forbids the flag on
   tunnel-exposed/public instances.

Non-goals: no change to the policy engine itself, no new risk classes, no
change to the parent plane's own `allowCriticalInDanger` handling, no
config-YAML emission (CLI flag only), no approval queueing on children.

## Threat surface (Security hat)

- This is the "autonomous CRITICAL execution" switch. Mitigations: default
  off; explicit operator opt-in per instance; invalid unless
  `policyMode === 'danger'` (fail-closed validation mirrors the CLI guard);
  every change hits the audit log; the UI shows a red warning and a persistent
  badge so the state is visible, not silent; the runbook forbids it on public
  endpoints. No secrets involved. The parent plane's own policy is untouched —
  the flag governs only the child instance it is set on.
- Abuse case: an agent with fleet write access could enable it. Fleet
  mutations are already MEDIUM-gated tool calls through the policy pipeline
  (approval-gated in safe/dev modes), and the dashboard routes live on the
  operator plane. Risk accepted with the audit + visibility mitigations. The
  flag is not enabled by any preset or default.

## Test plan (QA hat)

- Unit (`tests/unit/provisioner.test.ts`): create with flag+danger persists
  across reload; flag without danger throws; `setAllowCriticalInDanger`
  validation in both directions; `setPolicyMode` away from danger drops the
  flag; `startCommand` includes/excludes `--dangerously-allow-critical` via
  the stub spawner; `openAiTunnelCommand` likewise.
- Integration (provision tools level): create/update with the flag through the
  governed tool path; the error surfaces on flag + non-danger; the dashboard
  route applies both fields in one call.
- Live proof after build: provision a temp-folder instance with danger+flag,
  start it, call `policy_get` on the child over HTTP with the one-time token,
  assert `allowCriticalInDanger: true`; negative control: danger without the
  flag shows false. Destroy both instances after.
- Gates: typecheck/lint/build + targeted suites + full suite.

## Rollback

Revert the council branch commits. Instances created before the change carry
no field and behave exactly as before (flag absent = off).

## Decision log

- 2026-09-05 — Provisioner Engineer — propose — initial draft as above.
- 2026-09-05 — Security Officer — **approve with amendments** — (1) CLI-flag-only
  emission (no config-YAML change) to avoid a stale-config foot-gun; (2) the
  flag ⇒ danger invariant must hold under `setPolicyMode` (drop the flag on a
  mode change away from danger); (3) the UI must show the state persistently
  (badge), not only inside the modal; (4) the runbook must forbid the flag on
  tunnel-exposed instances. This approval does not cover merge/push.
- 2026-09-05 — QA/Verifier — **approve with amendments** — (1) spawn-level
  evidence via the stub spawner is mandatory (record assertions alone are not
  enough); (2) the live proof must include the negative control (danger without
  the flag → hatch off); (3) the existing provisioner/dashboard suites must
  pass unchanged except for intended updates.
- 2026-09-05 — User (council survey, loop #31) — **approve Git handoff** —
  pre-approved commit + merge --no-ff into main + push origin/main, conditional
  on every gate re-verified green on the current revision. Publish stays out of
  scope.
- 2026-09-05 — QA/Verifier — loop #31 re-verification evidence: scope matched
  the approved patch exactly (9 files, +224/−7, plus this proposal); lint exit 0;
  typecheck exit 0; targeted 45/45; full suite 131 files / 1046 tests PASS in
  81.14s via run_test async (disclosed method per #27 — no synchronous 4/4
  project_verify claim); build exit 0. Live proof on fresh dist: child A
  (danger + hatch) policy_get allowCriticalInDanger=true and policy_explain
  git_push → allow with factor 'allowCriticalInDanger is enabled'; child B
  (danger, no hatch) → false + decision approval + dashboard-disabled warning
  (absent on A). Two harness-side probe failures (port 7332 collision without
  --no-dashboard; escape-blind grep on the MCP envelope) were diagnosed via
  code reading and fixed before the passing run; no product change resulted.
