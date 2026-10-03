# Public MCP runbook — exposing FolderForge to the internet

Runbook for the "public MCP" operating mode: a FolderForge HTTP server or
dashboard reachable from outside localhost (quick tunnel, named tunnel, or a
public bind). Read fully before the first exposure.

## Threat model (what changes when you leave loopback)

- Anyone who reaches the endpoint can attempt tool calls. The policy engine
  gates risk, but **authentication is the perimeter**.
- Quick-tunnel URLs (`*.trycloudflare.com`) are unlisted-public: unguessable,
  but shared the moment the URL leaks (logs, screenshots, chat).
- A fleet instance token grants that folder's full tool preset at that policy
  mode. A dashboard token grants operator control of the whole control plane.

## Pre-flight checklist

1. **Auth**: bearer token set and non-loopback-safe (the server refuses
   non-loopback without one). For multi-user access use `--auth oauth`
   (RFC 9728 + PKCE), not a shared token.
2. **Policy mode**: `safe` (or stricter) so HIGH/CRITICAL tools require
   approval. Never run `danger` on a public endpoint.
3. **Tool preset**: narrowest workable preset (`readonly` / `vibe-lite`);
   avoid `full`/`godot` publicly.
4. **Exposure path**: start tunnels from the Tunnels panel or
   `tunnel_start` — both are HIGH risk and audited. Note the tunnel id.
5. **Audit**: confirm `audit_recent` shows the `tunnel_event` /
   `provision_event` entries you expect.
6. **Rate limits**: keep `rateLimit.enabled = true` on public endpoints.

## Operating rules

- Treat `policyMode: danger` itself as zero-manual-approval. On tunnel-exposed
  or otherwise public instances, use it only when the authentication, scope,
  workspace containment, hard-deny rules, audit, and rate-limit posture are
  intentionally strong enough for autonomous HIGH/CRITICAL execution.
- Rotate fleet tokens on suspicion or schedule; rotation restarts the
  instance (`restartRequired`).
- Keep auto-restart on for long-lived fleet instances, but treat repeated
  `failed` states as a signal, not noise — check `provision_logs` first.
- One tunnel per target port; the manager rejects duplicates.
- The dashboard token input stores the token in browser localStorage — use it
  only on machines/browsers you trust.

**Operator-origin posture** (decision record:
`docs/council/proposals/020-origin-policy-posture.md`). The operator's own
MCP origin may intentionally run `--policy danger` when it is a single-operator,
loopback + bearer-auth workhorse whose only public path is an authenticated
tunnel. This is now a zero-manual-approval posture by definition; the legacy
`--dangerously-allow-critical` flag is a deprecated no-op. Revisit the posture
when the host stops being single-operator or an incident traces to it.

## Incident response

1. **Cut exposure first**: stop the tunnel (`tunnel_stop <id>` or the Stop
   button in the Tunnels panel). This is fast and reversible.
2. **Freeze writes**: flip policy to `readonly` (Policy panel or
   `policy_set_mode`).
3. **Assess**: `audit_export` the window around the incident; check
   `provision_list` for unexpected instances and `process_list` for unknown
   sessions.
4. **Rotate**: rotate the fleet instance token; restart the instance. If the
   dashboard token leaked, restart the dashboard with a fresh token.
5. **Postmortem**: record what happened, which policy gate fired or should
   have fired, and any config change into the track log.
