# Proposal 002: Fleet authentication + OpenAI tunnel exposure

- Author role: Architect / Provisioner Engineer
- Date: 2026-08-29
- Status: implemented
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Mission Control can provision one MCP server per folder, but every Fleet instance is hard-wired to one generated bearer credential. The core HTTP runtime already supports unauthenticated loopback, static bearer/API-key credentials, and OAuth, while the ChatGPT CLI already supervises OpenAI Secure MCP Tunnel. Operators therefore have to leave Mission Control and reconstruct these capabilities by hand.

## Proposal

1. Extend the Fleet record with an explicit operator-facing auth mode: `none`, `token`, `api-key`, or `oauth`. Keep the runtime mapping correct: `api-key` is a Fleet credential UX over core static `token` auth, using `server.http.apiKeys` and `X-API-Key` support.
2. Generate bearer/API-key credentials server-side by default, return them exactly once, persist only a SHA-256 fingerprint in Fleet state, and keep plaintext only in the existing mode-0600 per-instance config. Allow an operator-supplied API key without ever copying it into `fleet.json`.
3. Store OAuth resource-server configuration (resource, issuer, scopes, read/write scopes, registration mode) as non-secret Fleet metadata and emit the existing HTTP OAuth YAML shape.
4. Reject Cloudflare publication of a Fleet instance whose auth mode is `none`.
5. Add a governed OpenAI Secure MCP Tunnel lifecycle to each Fleet instance. The control plane stores only tunnel ID and API-key environment-variable name; the API-key value must already exist in the Mission Control process environment and is inherited by the supervised `connect chatgpt --openai-tunnel` child. The value never enters Fleet state, HTTP responses, or process argv.
6. Surface all of the above in the React Mission Control Fleet screen, including auth-aware client snippets and one-time credential copy UI.

## Threat surface (Security hat)

- `none` is limited to loopback Fleet use; Fleet Cloudflare exposure fails closed.
- OpenAI tunnel launch never accepts the control-plane API-key value over the dashboard API. It accepts only an environment variable name and verifies that it is present before launch.
- Static credentials remain separate from OAuth credentials, preserving ADR-0004.
- OpenAI tunnel mode reuses the existing supervisor and its per-run local guard/static credential or OAuth guard model rather than creating a second tunnel implementation.
- Secret-bearing Fleet config remains mode 0600 and covered by the existing `.folderforge/fleet/**` denied glob.

## Test plan (QA hat)

- Unit: create all auth modes; verify YAML mapping and secret persistence discipline; rotate token/API-key credentials; validate OAuth requirements; OpenAI tunnel command/state/env validation.
- Integration: dashboard create/auth/rotate routes, no-auth Cloudflare rejection, OpenAI tunnel governed lifecycle.
- Existing OAuth HTTP and OpenAI tunnel tests stay green.
- Gate: typecheck, lint, architecture check, full tests, Mission Control build, root build.

## Rollback

Revert this proposal and the Fleet/auth/tunnel implementation changes. Existing persisted Fleet records remain backward-compatible because missing `authMode` is normalized to legacy `token` behavior.

## Decision log

- 2026-08-29 — Architect — approve — model auth and exposure as independent concerns.
- 2026-08-29 — Security Officer — amend/approve — never accept OpenAI control-plane API-key values through Fleet HTTP APIs; use environment references only; block public Cloudflare exposure for `none`.
- 2026-08-29 — DX/UI Designer — approve — auth selector at provision time, advanced OAuth fields, auth-aware Connect modal, dedicated OpenAI Tunnel action.
- 2026-08-29 — Provisioner Engineer — approve — reuse mode-0600 instance config and existing `connect chatgpt --openai-tunnel` supervisor.
- 2026-08-29 — QA/Verifier — approve — require focused unit/integration suites plus full project verification before done.
