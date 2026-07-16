# OAuth for the HTTP MCP transport

## Requirements matrix

| Requirement | Authoritative source | Repository state before this work | Gap | Final evidence |
|---|---|---|---|---|
| Protected Resource Metadata | MCP 2025-11-25; RFC 9728 | absent | endpoint and path variant missing | HTTP tests for root and path-specific metadata |
| `WWW-Authenticate` discovery | MCP; RFC 6750/9728; OpenAI Apps SDK | generic bearer realm only | no `resource_metadata` or scope | missing/invalid token HTTP tests |
| Authorization-server discovery | MCP; RFC 8414/OIDC Discovery | absent | issuer metadata not fetched or validated | local deterministic AS fixture |
| PKCE S256 | MCP; OAuth 2.1; RFC 7636 | not applicable to static token auth | external AS capability not checked | startup rejects metadata without `S256` |
| Client identification | MCP; OpenAI Apps SDK | absent | CIMD/DCR/predefined choice undocumented | ADR + discovery capability test |
| Redirect URI/state | OAuth 2.1; MCP | FolderForge is not an AS | operator guidance missing | external-AS checklist and threat model |
| Resource parameter/audience | MCP; RFC 8707 | absent | token audience not checked | wrong-audience negative test |
| Cryptographic token validation | OAuth 2.1; OpenAI Apps SDK | static equality only | JWT signature/claims not verified | valid/invalid signature, expiry, nbf, issuer tests |
| Scope enforcement | MCP; OpenAI Apps SDK | absent | read/write authorization missing | read transport scope + write pre-execution tests |
| Agent/admin boundary | FolderForge security architecture | principal boundary exists in working tree | OAuth integration could bypass it | OAuth principals always agent; dashboard regression tests |
| HTTPS deployment | MCP; OpenAI ChatGPT connection docs | HTTP transport may bind anywhere | no canonical HTTPS OAuth resource validation | config tests; explicit loopback-only unsafe override |
| Auth0 tenant/API automation | Auth0 CLI tenant/API commands | manual operator setup only | tenant, issuer, audience and scopes required expert input | `connect chatgpt` discovers active tenant and idempotently creates/reuses the exact API identifier |
| Quick registration/connectivity | OpenAI authentication/connection docs; MCP client registration | no workflow | DCR and public HTTPS required multiple manual steps | quick mode verifies DCR and starts an explicitly warned Cloudflare quick tunnel |
| Secure registration | OpenAI authentication; MCP client registration | no workflow | production client/redirect contract unspecified | secure mode requires stable HTTPS and predefined client; reports exact remaining external action |
| Connection lifecycle/receipt | product/security contract | absent | no status, repair, disconnect or evidence artifact | versioned secret-free receipt plus status/doctor/repair/start/stop/disconnect tests |
| Live ChatGPT validation | OpenAI Connect from ChatGPT | not performed | public HTTPS and user UI action required | exact manual checklist after automated acceptance |

## Architecture and milestones

1. Config/CLI/environment contract with compatibility validation.
2. OAuth discovery and JWT/JWKS verifier.
3. Protected-resource metadata and challenge integration.
4. Per-tool read/write scope metadata and pre-execution enforcement.
5. Deterministic OAuth fixtures and adversarial tests.
6. Auth0/ChatGPT one-command orchestration, receipt, lifecycle, and tunnel strategy.
7. Package/release smoke, docs, and live ChatGPT checklist.

## Automated versus live acceptance

Automated conformance uses a local authorization-server fixture and loopback-only insecure-development mode. It proves discovery, metadata, challenges, JWT verification, audience/scope checks, JWKS rotation, legacy authentication regression, packed-package startup, and protocol-level MCP calls.

Live ChatGPT validation additionally requires a publicly reachable HTTPS `/mcp` endpoint, an external IdP tenant configured for ChatGPT, redirect URI registration/consent, and a user action in ChatGPT Developer Mode. FolderForge does not claim that gate has passed without those observations.

## Production setup

### 1. Provision the external authorization server

FolderForge does not host login, consent, authorization, token, registration, or
revocation endpoints. Configure an established IdP so its discovery document:

- has an `issuer` exactly equal to the configured FolderForge issuer;
- exposes `authorization_endpoint`, `token_endpoint`, and `jwks_uri`;
- advertises `code_challenge_methods_supported: ["S256"]`;
- supports Authorization Code grants and preserves the RFC 8707 `resource`
  parameter in authorization and token requests;
- issues signed access JWTs whose `aud` contains the exact canonical FolderForge
  resource URL;
- places granted scopes in `scope` or `scp`;
- supports the selected client strategy:
  - `cimd`: `client_id_metadata_document_supported: true` and `none` or
    `private_key_jwt` token endpoint authentication;
  - `dcr`: a standards-compliant `registration_endpoint`;
  - `predefined`: ChatGPT client details are provisioned in the IdP out of band.

The IdP must validate redirect URIs exactly, require state, reject PKCE `plain`,
protect its metadata/client-document fetchers from SSRF, rate-limit registration
and authorization endpoints, and provide revocation/short token lifetimes. These
are authorization-server responsibilities and are not delegated to FolderForge.

### 2. Choose the canonical public resource

Use the most specific stable public HTTPS MCP URL, normally:

```text
https://mcp.example.com/mcp
```

Use this exact value in all three places:

1. `--oauth-resource` / `server.http.auth.oauth.resource`;
2. the `resource` parameter accepted by the IdP during authorization/token flow;
3. the JWT audience (`aud`) emitted by the IdP.

Do not use an internal container URL, tunnel-local URL, URL fragment, or a value
that redirects to the real endpoint.

### 3. Start FolderForge

```bash
folderforge --project /srv/project --http --host 0.0.0.0 --port 7331 \
  --auth oauth \
  --oauth-resource https://mcp.example.com/mcp \
  --oauth-issuer https://auth.example.com \
  --oauth-scopes folderforge:read,folderforge:write \
  --oauth-read-scope folderforge:read \
  --oauth-write-scope folderforge:write \
  --oauth-client-registration cimd \
  --no-dashboard
```

A reverse proxy or load balancer terminates HTTPS and forwards the public `/mcp`
path to FolderForge. Do not rewrite the public resource identifier. Keep the
admin dashboard private or configure a separate dashboard token; an OAuth user
token never grants dashboard authority.

### 4. Verify discovery before ChatGPT

```bash
curl -fsS https://mcp.example.com/.well-known/oauth-protected-resource/mcp

curl -i -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected observations:

- metadata contains `resource`, `authorization_servers`, and
  `scopes_supported`;
- the unauthenticated request is `401`;
- `WWW-Authenticate` contains the exact HTTPS `resource_metadata` URL and the
  read scope;
- the IdP discovery URL is reachable and advertises PKCE `S256`;
- a valid access token for the exact resource can call `tools/list`;
- a token for another audience receives `401 invalid_token`;
- a read-only token receives a tool-level `insufficient_scope` challenge before
  any mutating handler executes.

## Live ChatGPT Developer Mode checklist

This is the only acceptance layer that cannot be completed by repository tests.
It requires the operator's IdP tenant, public DNS/TLS, and ChatGPT UI session.

1. Confirm the public MCP endpoint is reachable over HTTPS and the two checks
   above pass from outside the deployment network.
2. In the IdP, enable the selected registration strategy. For predefined-client
   mode, register the exact ChatGPT redirect URI shown by the IdP/ChatGPT setup
   workflow; never use wildcard redirects. For CIMD, permit ChatGPT's HTTPS
   client metadata document and validate it according to the CIMD specification.
3. In ChatGPT, open **Settings → Security and login** and enable **Developer
   mode**. A workspace administrator may need to allow it.
4. Open **Settings → Plugins**, select the plus button, and create a
   developer-mode app.
5. Enter a name/description and the exact public MCP URL, for example
   `https://mcp.example.com/mcp`.
6. Click Create. ChatGPT should discover protected-resource metadata, open the
   IdP authorization flow, use Authorization Code + PKCE S256, request the
   challenged scopes/resource, and return to ChatGPT after consent.
7. Verify ChatGPT displays FolderForge's tool list. Inspect one read-only tool
   and one mutating tool; their OAuth security schemes should request read and
   read+write scopes respectively.
8. In a new chat, select the app and invoke a read-only tool. Then invoke a
   mutating tool with a token initially limited to read scope; ChatGPT should
   present a step-up/linking flow from `_meta["mcp/www_authenticate"]` before the
   handler runs.
9. Confirm the FolderForge audit log records only the hashed OAuth principal ID,
   not the access token or authorization code.
10. Record the date, ChatGPT app name, public resource URL, issuer, requested
    scopes, successful read/write observations, and any IdP-specific settings in
    the implementation log. Do not record credentials.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| ChatGPT says the MCP server is unreachable | public HTTPS certificate, DNS, firewall, reverse-proxy `/mcp` forwarding, `/healthz` |
| ChatGPT never opens OAuth | 401 has `resource_metadata`; metadata is public; every tool has OAuth `securitySchemes` |
| Discovery fails at FolderForge startup | issuer equality, well-known discovery path, HTTPS, PKCE S256, selected CIMD/DCR capability |
| `invalid_token` after login | JWT signature/key id, issuer, exact `aud`/resource, `exp`, `nbf`, algorithm allowlist |
| `insufficient_scope` | IdP consent/grant contains the challenged read or read+write scopes; refresh/relink the app |
| JWKS works until key rotation | publish old and new keys during overlap; use stable `kid`; check JWKS caching/proxy headers |
| Cross-host JWKS is rejected | prefer issuer-hosted JWKS; otherwise set an explicit `jwksUri` or tightly scoped `trustedJwksHosts` (exact `host[:port]` entries) |
| CIMD is rejected | IdP must advertise CIMD, accept HTTPS URL client IDs, validate the client document and exact redirects |
| DCR is rejected | discovery must include `registration_endpoint`; apply AS-side authentication/rate limiting |
| OAuth unexpectedly uses an API key | invalid configuration: OAuth mode rejects static credentials and ignores `X-API-Key` |
| Local HTTP configuration is rejected | use HTTPS, or loopback-only URLs plus `--unsafe-oauth-http` for tests only |

## What FolderForge does not own

FolderForge does not store users, passwords, consent grants, client secrets,
refresh tokens, authorization codes, private signing keys, or IdP sessions. It
does not implement DCR/CIMD endpoints because those belong to the external
authorization server and MCP client. It does not make an OAuth user a dashboard
administrator and does not replace the policy, approval, workspace, command,
secret, or audit controls applied after OAuth succeeds.
