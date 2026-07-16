# Connect FolderForge to ChatGPT with Auth0

`folderforge connect chatgpt` configures FolderForge as an OAuth resource server,
uses the active Auth0 tenant as the authorization server, starts the Streamable
HTTP MCP endpoint, and verifies the public metadata and unauthenticated challenge.
It does not turn FolderForge into an identity provider and does not store OAuth or
Auth0 secrets.

## Prerequisites

- Node.js and the installed FolderForge CLI.
- Auth0 CLI installed and logged in (`auth0 login`).
- One active Auth0 tenant (`auth0 tenants use <tenant-domain>` when needed).
- Quick mode: `cloudflared` installed, unless `--public-url` is supplied.
- Secure mode: a stable public HTTPS URL that forwards to local FolderForge.
- ChatGPT Developer Mode access for the final interactive connection.

The wizard discovers the tenant, issuer, authorization endpoint, token endpoint,
JWKS endpoint, PKCE support, and DCR endpoint from Auth0. It does not ask the user
to copy these values manually.

## Personal testing: quick mode

```bash
folderforge connect chatgpt --quick
```

For a one-command high-trust local coding setup:

```bash
folderforge connect chatgpt --quick --full-access --port 7443
```

`--full-access` persists `policy.defaultMode: danger` and `tools.preset: full` in
`.folderforge/chatgpt-config.yaml`. It does not bypass workspace boundaries, denied
secret globs, hard-blocked destructive commands, or explicit approval for CRITICAL actions.

Quick mode:

1. verifies Auth0 CLI and the active tenant;
2. verifies Auth0 discovery, issuer, PKCE S256, DCR, and JWKS; enables the Auth0 DCR tenant flag when needed unless explicitly disabled;
3. starts a Cloudflare quick tunnel when no public URL is supplied;
4. creates or reuses an Auth0 API whose identifier is the exact public `/mcp` URL;
5. enables offline access by default for ChatGPT refresh tokens and allows DCR clients to access the API in quick mode;
6. preserves unrelated scopes and their descriptions while appending missing
   `folderforge:read` and `folderforge:write` scopes;
7. writes a generated OAuth config and a secret-free connection receipt;
8. starts FolderForge on loopback;
9. verifies protected-resource metadata and the `401 WWW-Authenticate` challenge;
10. prints the exact MCP URL to add in ChatGPT.

Quick mode uses Dynamic Client Registration and a temporary tunnel URL. It is for
personal testing only. Restarting a quick tunnel can change the canonical resource
URL and therefore the Auth0 API audience. Re-run `folderforge chatgpt repair
--quick`, then reconnect the ChatGPT app when that happens. FolderForge never
silently promotes this development configuration to production.

A stable HTTPS URL can still be used with quick registration:

```bash
folderforge connect chatgpt --quick \
  --public-url https://mcp.example.com/mcp \
  --tunnel none
```

## Team or production: secure mode

```bash
folderforge connect chatgpt --secure \
  --public-url https://mcp.example.com/mcp
```

Secure mode requires a stable public HTTPS URL and selects a predefined OAuth
client strategy. The first run can finish Auth0 API provisioning and endpoint
verification without a client ID, but reports `ACTION REQUIRED` instead of
`READY TO CONNECT`.

During ChatGPT app creation, use the exact redirect URI shown by ChatGPT to create
or update the Auth0 application. Do not use a wildcard redirect. Then record the
public client identifier:

```bash
folderforge chatgpt repair --secure \
  --public-url https://mcp.example.com/mcp \
  --client-id '<auth0-client-id>'
```

FolderForge stores the client ID because it is public metadata. It never accepts,
prints, or stores a client secret. Auth0 remains responsible for redirect URI
validation, state, consent, Authorization Code + PKCE S256, token issuance,
refresh-token handling, and revocation.

## Commands

| Command | Purpose |
| --- | --- |
| `folderforge connect chatgpt` | Interactive mode choice, or quick mode when non-interactive |
| `folderforge connect chatgpt --quick` | Personal/development connection using DCR |
| `folderforge connect chatgpt --secure --public-url …` | Stable production-oriented connection |
| `folderforge chatgpt status` | Check process state, public metadata, and the 401 challenge |
| `folderforge chatgpt doctor` | Check Auth0 CLI, tenant, discovery, JWKS, receipt, and endpoint |
| `folderforge chatgpt repair` | Re-run idempotent provisioning and restore local runtime state |
| `folderforge chatgpt start` | Start the configured FolderForge server when the public URL is still valid |
| `folderforge chatgpt stop` | Stop locally managed FolderForge and quick-tunnel processes |
| `folderforge chatgpt disconnect` | Stop local processes and mark the connection disconnected |
| `folderforge chatgpt disconnect --purge-local --yes` | Also remove generated config and logs; receipt is retained as non-secret history |

Useful options:

```text
--project <dir>       project exposed through FolderForge
--tenant <domain>     explicit Auth0 tenant instead of the active CLI tenant
--public-url <url>    canonical stable HTTPS MCP URL
--tunnel cloudflared  quick tunnel (default when quick mode has no public URL)
--tunnel none         use an externally managed reverse proxy or tunnel
--host <addr>         local bind host, default 127.0.0.1
--port <n>            local MCP port, default 7331
--profile <id>         safe|developer|full; default developer
--full-access          shortcut for profile full (danger + full built-in tools)
--policy <mode>        readonly|safe|dev|danger; persisted to generated YAML
--tools-preset <id>    vibe|vibe-lite|readonly|full|godot
--adapters <list>      playwright,serena,desktop-commander,godot,all,none
--dashboard            enable local dashboard; disabled by default for ChatGPT
--dashboard-port <n>   local dashboard port, default 7332
--offline-access       allow refresh tokens; default for ChatGPT
--dcr-client-policy    allow-all|require-grant; quick default allow-all
--force-config         rebuild generated YAML from CLI/defaults instead of prior values
--no-start            provision and write config without starting processes
--dry-run             discovery and planned-diff only; no Auth0 or local writes
--json                machine-readable receipt/status output
```

CLI values have highest precedence and are persisted into the generated YAML. Without
`--force-config`, omitted values are preserved from the prior generated config/receipt.
`repair` and `start` reuse those persisted values; passing runtime options to `start`
rewrites the YAML and restarts the server.

All subprocess arguments are passed without a shell. Tenant, URL, port, and mode
values are parsed as structured arguments rather than interpolated into command
strings.

## Generated local state

The wizard writes files under the selected project's `.folderforge` directory:

```text
.folderforge/chatgpt-config.yaml
.folderforge/chatgpt-connection.json
.folderforge/chatgpt-server.log
.folderforge/chatgpt-tunnel.log       # quick tunnel only
.folderforge/chatgpt-connect.lock     # exists only during an operation
```

The repository's `.folderforge/.gitignore` ignores all runtime state. Config and
receipt files are created with mode `0600` on POSIX systems.

Receipt schema version 1 contains only non-secret connection evidence:

```json
{
  "version": 1,
  "status": "ready",
  "provider": "auth0",
  "mode": "quick",
  "registration": "dcr",
  "tenant": "tenant.example.auth0.com",
  "issuer": "https://tenant.example.auth0.com/",
  "resource": "https://mcp.example.com/mcp",
  "mcpUrl": "https://mcp.example.com/mcp",
  "metadataUrl": "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  "scopes": ["folderforge:read", "folderforge:write"],
  "checks": {
    "issuerDiscovery": "pass",
    "resourceMetadata": "pass",
    "unauthorizedChallenge": "pass",
    "jwks": "pass",
    "tokenValidation": "pending_user_login",
    "mcpInitialize": "pending_user_login"
  }
}
```

The full receipt also records local paths, process IDs, connectivity type, Auth0
API ID/name, timestamps, and warnings. It is rejected before write/read if it
contains secret-shaped field names or a JWT-shaped value.

FolderForge does not persist:

- Auth0 Management API tokens;
- access or refresh tokens;
- authorization codes;
- client secrets or private keys;
- PKCE verifiers;
- bearer/API keys, passwords, cookies, or browser sessions.

## Idempotency and recovery

Provisioning always lists Auth0 APIs before creation and matches the exact API
identifier/resource. A second run reuses the API and appends only missing
FolderForge scopes while preserving unrelated scope values and descriptions. It
does not create a duplicate API for the same canonical resource.

A PID lock rejects concurrent wizard operations. A stale lock is recovered only
when its owning process is no longer alive. If a newly started server or tunnel
fails before setup completes, the wizard sends stop signals to processes it
started during that attempt.

`repair` rechecks dependencies, tenant metadata, JWKS, Auth0 API configuration,
generated config, processes, public metadata, and the unauthenticated challenge.
Remote Auth0 APIs are never deleted automatically. This prevents a local
disconnect from destroying a resource shared by other clients or environments.

## ChatGPT connection steps

After the command reports `READY TO CONNECT`:

1. Open ChatGPT **Settings → Security and login** and enable **Developer mode**.
2. Open **Settings → Plugins**, select **+**, and create a developer-mode app.
3. Enter the exact MCP URL printed by FolderForge.
4. Complete the Auth0 login and consent flow.
5. Confirm the tool list appears.
6. Call one read-only tool, then one mutating tool.
7. Confirm FolderForge audit output contains a hashed OAuth principal, not a token.

These UI and login actions are the live acceptance gate. Repository tests and the
wizard can prove discovery, JWT verification, scope enforcement, metadata, and
MCP behavior, but they cannot claim a successful ChatGPT account connection
without observing this user-owned flow.

## Status interpretation

- `READY TO CONNECT`: automated setup, public metadata, and 401 challenge passed.
  A real token and ChatGPT tool call still require the user login/UI flow.
- `ACTION REQUIRED`: secure endpoint setup passed, but a predefined client ID or
  exact redirect-URI registration remains.
- `CONFIGURED`: local/Auth0 configuration exists but the server was not started.
- `STOPPED`: managed process or public endpoint is unavailable.
- `DISCONNECTED`: local processes were stopped intentionally; Auth0 resources remain.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `Auth0 CLI is not logged in` | Run `auth0 login`, approve the browser prompt, then retry |
| `No active Auth0 tenant` | Run `auth0 tenants list`, then `auth0 tenants use <domain>` |
| PKCE or DCR discovery failure | Confirm the selected Auth0 tenant exposes S256 and, for quick mode, `registration_endpoint` |
| Auth0 API create/update denied | Re-authenticate Auth0 CLI with resource-server read/create/update permissions |
| Cloudflare quick tunnel not ready | Inspect `.folderforge/chatgpt-tunnel.log`, then run `folderforge chatgpt repair --quick` |
| Public metadata fails | Check DNS/TLS/reverse proxy and ensure `/mcp` plus `/.well-known/oauth-protected-resource/mcp` reach the same FolderForge instance |
| `invalid_token` after login | Check exact issuer, JWT signature/key ID, RS256, `aud` equal to the full MCP URL, expiry, and not-before |
| `insufficient_scope` | Relink/consent with `folderforge:read` and, for mutations, `folderforge:write` |
| Quick URL changed | Repair creates/reuses the API for the new URL; remove obsolete Auth0 APIs manually only after confirming they are unused |
| Secure mode remains action-required | Register the exact ChatGPT redirect URI and rerun repair with `--client-id` |

## Official specifications used

- OpenAI Apps SDK authentication: <https://developers.openai.com/apps-sdk/build/auth>
- OpenAI Connect from ChatGPT: <https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>
- MCP Authorization specification: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- OAuth Protected Resource Metadata (RFC 9728): <https://www.rfc-editor.org/rfc/rfc9728>
- OAuth Authorization Server Metadata (RFC 8414): <https://www.rfc-editor.org/rfc/rfc8414>
- Resource Indicators (RFC 8707): <https://www.rfc-editor.org/rfc/rfc8707>
- PKCE (RFC 7636): <https://www.rfc-editor.org/rfc/rfc7636>
- Auth0 CLI API commands: <https://auth0.github.io/auth0-cli/auth0_apis_create.html>
