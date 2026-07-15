# ADR-0004: OAuth resource-server mode for Streamable HTTP

- Status: Accepted
- Date: 2026-07-15
- Decision owners: Engineering, OAuth, MCP, Security

## Context

FolderForge already exposes a stateless Streamable HTTP MCP endpoint and supports static bearer/API-key credentials. ChatGPT OAuth interoperability requires RFC 9728 protected-resource metadata, an RFC 6750 challenge, authorization-server discovery, Authorization Code + PKCE S256 at the authorization server, resource/audience binding, and cryptographic token validation.

FolderForge is a local development control plane. Building a bundled identity provider would add account storage, login and consent UX, key management, revocation, refresh-token handling, client registration abuse controls, and a substantially larger attack surface.

## Decision

Choose **Option A — Resource Server Only**.

FolderForge will:

1. expose `none`, `token`, and `oauth` HTTP authentication modes;
2. preserve the legacy omitted-mode behavior for backward compatibility;
3. publish RFC 9728 metadata at both the path-specific well-known URL and the root fallback;
4. return RFC 6750 `WWW-Authenticate` challenges containing `resource_metadata` and scopes;
5. discover an explicitly configured external authorization server using RFC 8414/OIDC discovery;
6. require metadata to advertise PKCE `S256`;
7. validate JWT access tokens cryptographically using the discovered or explicitly configured JWKS;
8. enforce issuer, audience/resource, `exp`, `nbf`, allowed algorithms, and scopes;
9. map read-only tools to `folderforge:read` and mutating tools to `folderforge:write` before execution;
10. keep OAuth principals in the agent plane; dashboard admin authentication remains separate;
11. reject mixed OAuth + static credential configuration and never fall back from OAuth to token/API-key auth.

The authorization server remains responsible for Authorization Code flow, exact redirect URI validation, state handling, consent, token issuance, refresh-token rotation, revocation, and preserving the `resource` parameter through authorization and token requests.

## Client identification strategy

Default: **CIMD** (`client_id_metadata_document_supported=true`) because the current MCP specification prefers it for clients and servers without a prior relationship and OpenAI documents it as the preferred path.

Configurable alternatives:

- `dcr`: require an authorization-server `registration_endpoint`;
- `predefined`: operator pre-registers ChatGPT at the IdP; FolderForge does not store the client secret.

FolderForge validates that discovered metadata supports the selected strategy but does not implement a registration endpoint because it is not the authorization server.

## Data flow

```text
ChatGPT MCP client
  | GET protected-resource metadata
  v
FolderForge resource server ---- configured issuer ----> External authorization server
  ^          |                                            | authorize + PKCE S256
  |          | discovery/JWKS                             | token (aud=FolderForge resource)
  |          v                                            v
  +---- Authorization: Bearer JWT <---------------- ChatGPT
             |
             +-- signature/alg/iss/aud/exp/nbf validation
             +-- read scope before MCP access
             +-- write scope before mutating tool execution
             +-- agent principal -> policy/approval/audit pipeline
```

## Trust boundaries

- Public HTTP boundary: untrusted request headers and JSON-RPC payloads.
- OAuth trust boundary: only the operator-configured issuer is trusted; discovery URLs are derived from it.
- JWKS boundary: same-origin with issuer by default, or an explicitly configured/allowlisted host.
- Agent/admin boundary: OAuth credentials create `agent` principals only; dashboard tokens create `admin` principals.
- Workspace/policy boundary: OAuth scope is necessary but not sufficient; existing policy, approval, path, command, and audit controls still apply.

## Threat model and controls

| Threat | Control |
|---|---|
| authorization-code interception / PKCE downgrade | external AS must advertise `S256`; startup fails otherwise; FolderForge does not handle codes |
| redirect URI manipulation / CSRF-state failures / open redirect | external AS responsibility; exact redirect URI and state requirements documented |
| token replay | TLS required in production, short-lived JWTs expected, every request revalidated; no token persistence/logging |
| token/issuer confusion | exact configured issuer check and signature verification |
| audience/resource mismatch | exact configured resource must match `aud` |
| scope escalation | transport requires read scope; mutating tools require write scope before registry execution |
| unsigned/wrong-alg JWT | explicit asymmetric algorithm allowlist; `none` and symmetric algorithms rejected |
| JWKS rotation / stale cache | standards library remote JWKS cache; unknown `kid` refetch; bounded cache/cooldown |
| discovery/JWKS poisoning or SSRF | issuer is explicit; no redirects; HTTPS required; loopback HTTP only with explicit development override; discovered JWKS must match exact issuer or allowlisted `host[:port]`, or use an explicit URI |
| DCR abuse / CIMD SSRF | handled by external AS; selected strategy is validated and deployment guidance requires AS-side rate limits and SSRF controls |
| secret leakage | access tokens, codes, secrets, private keys and PKCE verifiers are never logged or persisted by FolderForge |
| OAuth fallback bypass | OAuth mode rejects token/API-key config and ignores `X-API-Key`; validation fails closed |
| admin privilege escalation | OAuth principal role is always `agent`; dashboard auth remains independent |
| localhost/non-loopback mistakes | production resource and issuer require HTTPS; insecure HTTP is limited to loopback with an explicit unsafe-development flag |

## CLI/config contract

CLI precedence: CLI > environment > YAML > built-in/legacy behavior.

```bash
folderforge --http --auth oauth \
  --oauth-resource https://mcp.example.com/mcp \
  --oauth-issuer https://auth.example.com \
  --oauth-scopes folderforge:read,folderforge:write \
  --oauth-client-registration cimd
```

YAML:

```yaml
server:
  transport: http
  http:
    auth:
      mode: oauth
      oauth:
        resource: https://mcp.example.com/mcp
        issuer: https://auth.example.com
        scopes: [folderforge:read, folderforge:write]
        readScope: folderforge:read
        writeScope: folderforge:write
        clientRegistration: cimd
```

Legacy `server.http.token`, `server.http.apiKeys`, and `server.http.requireAuth` remain supported when `server.http.auth.mode` is omitted or set to `token`.

## Consequences

Positive: small implementation, no custom OAuth server or crypto, compatible with enterprise IdPs, preserves existing authorization boundaries.

Trade-offs: operators must provision an external IdP; opaque tokens are not accepted in the first implementation; live ChatGPT acceptance requires a public HTTPS endpoint and user interaction.
