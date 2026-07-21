# Connect FolderForge to ChatGPT with Auth0

`folderforge connect chatgpt` is the primary connection workflow. FolderForge
remains an OAuth resource server; Auth0 remains the authorization server that
owns login, consent, Authorization Code + PKCE, token issuance, refresh, and
revocation.

The normal quick-mode flow does not require copying a `tpc_*` client ID or
running Auth0 Management API commands manually.

## Quick start

Prerequisites:

- Node.js 22 or newer and the FolderForge CLI.
- Auth0 CLI installed and logged in with `auth0 login`.
- One selected Auth0 tenant.
- `cloudflared` when a stable public HTTPS URL is not supplied.
- ChatGPT access that can create a custom MCP connector.

Run from the project to expose:

```bash
folderforge connect chatgpt
```

In a non-interactive terminal this selects quick mode. In an interactive terminal
you can choose quick or secure mode. The explicit equivalent is:

```bash
folderforge connect chatgpt --quick
```

FolderForge prints the public MCP URL and then waits:

```text
Waiting for ChatGPT to register an OAuth client...
```

While the command remains open:

1. Open ChatGPT and create a custom MCP connector using the printed MCP URL.
2. Click **Connect**.
3. FolderForge detects the new Auth0 DCR client, repairs its login connection and
   user grant, and verifies the authorize endpoint.
4. When FolderForge prints the following message, return to ChatGPT:

```text
OAuth is ready. Return to ChatGPT and complete sign-in.
```

5. Complete Auth0 login or consent in the browser.
6. Call a FolderForge tool from ChatGPT. The lifecycle becomes `CONNECTED` only
   after FolderForge observes an authenticated MCP tool call from the exact
   verified OAuth client.

## What the command automates

The quick path performs these operations idempotently:

1. checks Node.js, Auth0 CLI, `cloudflared`, project paths, and the local port;
2. selects and verifies the active Auth0 tenant;
3. validates issuer discovery, PKCE S256, DCR metadata, token endpoint metadata,
   and JWKS;
4. enables Dynamic Client Registration when allowed and required;
5. creates or repairs the Auth0 resource server for the exact public `/mcp` URL;
6. preserves unrelated scopes and adds `folderforge:read` and
   `folderforge:write` when missing;
7. enforces RS256, the RFC 9068 token dialect, the configured token lifetime,
   offline access, and the user-grant subject policy;
8. starts or verifies the local MCP server;
9. starts or verifies a Cloudflare quick tunnel when no stable public URL is
   supplied;
10. verifies RFC 9728 protected-resource metadata;
11. verifies that an unauthenticated `/mcp` request returns the expected `401`
    `WWW-Authenticate` challenge;
12. captures the Auth0 client baseline for this connect session;
13. waits for a newly created ChatGPT DCR client;
14. accepts only a client whose DCR metadata, name, callbacks, creation boundary,
    and Auth0 resource log match the current FolderForge resource;
15. enables the selected Auth0 login connection only for that verified client;
16. creates or repairs a per-client grant with `subject_type=user`, the exact
    audience, and the required scopes;
17. probes `/authorize` with PKCE S256, the ChatGPT callback, scopes, and the
    OAuth `resource` parameter;
18. stores a secret-free lifecycle receipt shared by the CLI and dashboard.

The resource-server subject policy is:

```json
{
  "user": { "policy": "require_client_grant" },
  "client": { "policy": "deny_all" }
}
```

FolderForge then creates the required user grant for the one verified ChatGPT
client. It does not grant all third-party clients access to the API.

## Shared lifecycle state machine

The CLI and dashboard use the same domain evaluator:

```text
UNCONFIGURED
→ AUTH0_READY
→ RESOURCE_SERVER_READY
→ LOCAL_SERVER_READY
→ PUBLIC_ENDPOINT_READY
→ OAUTH_METADATA_READY
→ WAITING_FOR_CHATGPT_CLIENT
→ CHATGPT_CLIENT_DETECTED
→ LOGIN_CONNECTIONS_READY
→ USER_GRANT_READY
→ AUTHORIZE_READY
→ READY_TO_COMPLETE_LOGIN
→ CONNECTED
```

Important interpretations:

- `WAITING_FOR_CHATGPT_CLIENT`: open ChatGPT, create the connector, and click
  Connect while FolderForge is waiting.
- `READY_TO_COMPLETE_LOGIN`: Auth0 accepts the client, callback, connection,
  grant, PKCE request, scopes, and resource. Complete login in ChatGPT.
- `CONNECTED`: an authenticated MCP tool call from the exact verified OAuth
  client was recorded after the connection session began.
- `NEEDS ATTENTION`: at least one diagnostic failed and includes a repair action.
- `STOPPED`: the local server or required tunnel is not running.

Known failures are classified instead of being exposed as opaque strings,
including:

- `AUTH0_LOGIN_REQUIRED`
- `AUTH0_SCOPE_MISSING`
- `DCR_DISABLED`
- `RESOURCE_SERVER_MISCONFIGURED`
- `LOCAL_SERVER_STOPPED`
- `PORT_IN_USE`
- `TUNNEL_STOPPED`
- `PUBLIC_ENDPOINT_502`
- `METADATA_INVALID`
- `CLIENT_NOT_AUTHORIZED`
- `NO_CONNECTIONS_ENABLED`
- `CALLBACK_MISMATCH`
- `TOKEN_EXCHANGE_FAILED`
- `MCP_TOOL_LIMIT_EXCEEDED`
- `MULTIPLE_CHATGPT_CLIENTS`
- `CHATGPT_CLIENT_TIMEOUT`

Every diagnostic records the check, status, check time, bounded evidence, whether
FolderForge can repair it, and the suggested next action.

## Safe DCR client detection

FolderForge never grants access merely because a client name contains
“ChatGPT”. Automatic mutation requires all applicable boundaries to pass:

- client name is exactly `ChatGPT`;
- Auth0 marks it as externally created through DCR;
- it is a public authorization-code client;
- every registered callback is under
  `https://chatgpt.com/connector/oauth/`;
- the client was created after the current connect-session baseline, unless an
  existing client was explicitly selected for repair;
- an Auth0 authorize log proves that the client requested the exact FolderForge
  resource/audience;
- the logged redirect URI matches a registered callback.

If more than one new client safely matches the same resource, FolderForge fails
closed with `MULTIPLE_CHATGPT_CLIENTS`. Review the candidates before explicitly
selecting one with `--client-id`.

## Login connections

When the tenant has one active database connection, FolderForge selects it. The
conventional `Username-Password-Authentication` connection is preferred when
available.

When no unique safe default exists, specify the intended connection:

```bash
folderforge connect chatgpt --login-connection Username-Password-Authentication
```

Repeat the flag or use a comma-separated list when the connector intentionally
supports multiple login methods:

```bash
folderforge connect chatgpt \
  --login-connection Username-Password-Authentication \
  --login-connection google-oauth2
```

Only the verified ChatGPT client is added to those connection memberships.
FolderForge does not enable a connection for every client in the tenant.

## Public URL modes

### Quick mode with a temporary tunnel

```bash
folderforge connect chatgpt --quick
```

This starts a Cloudflare quick tunnel and is intended for personal development.
If that tunnel restarts, its public hostname can change. A changed hostname means
a new OAuth resource identifier and audience. FolderForge will not silently reuse
or grant the old ChatGPT client access to the new resource; reconnect ChatGPT so
a new DCR client requests the new URL.

### DCR with a stable public URL

```bash
folderforge connect chatgpt --quick \
  --public-url https://mcp.example.com/mcp \
  --tunnel none
```

This keeps the automatic DCR lifecycle while an external reverse proxy or tunnel
owns the stable public endpoint.

### Predefined-client mode

```bash
folderforge connect chatgpt --secure \
  --public-url https://mcp.example.com/mcp
```

Secure mode selects a predefined OAuth client strategy. It exists for deployments
whose policy forbids DCR. Exact callback registration remains an operator-owned
Auth0 task. The one-command lifecycle described in this guide is the quick/DCR
path.

## CLI commands

| Command                                              | Purpose                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `folderforge connect chatgpt`                        | Provision, start, verify, wait for ChatGPT DCR, and repair the client lifecycle               |
| `folderforge connect chatgpt --wait`                 | Resume waiting for a new ChatGPT client while preserving the current runtime                  |
| `folderforge chatgpt status`                         | Verify runtime, public OAuth, Auth0 client, connection, grant, authorize, and MCP activity    |
| `folderforge chatgpt doctor`                         | Return the same lifecycle diagnostics in a read-only diagnostic workflow                      |
| `folderforge chatgpt repair`                         | Re-provision drift and restore runtime state idempotently                                     |
| `folderforge chatgpt repair --no-start`              | Repair Auth0 and verify the existing endpoint without restarting the local server             |
| `folderforge chatgpt start`                          | Start the configured local server and reuse a still-valid public endpoint                     |
| `folderforge chatgpt stop`                           | Stop FolderForge and a managed quick tunnel                                                   |
| `folderforge chatgpt disconnect`                     | Stop local processes and retain remote Auth0 resources                                        |
| `folderforge chatgpt disconnect --purge-local --yes` | Remove generated local config/logs after explicit confirmation; retain the receipt as history |
| `folderforge chatgpt prune-dcr`                      | Preview stale duplicate ChatGPT DCR clients without deleting remote Auth0 applications        |
| `folderforge chatgpt prune-dcr --yes`                | Irreversibly delete only the reviewed safe candidates and verify the application count drops  |

Useful lifecycle options:

```text
--tenant <domain>             explicit authenticated Auth0 tenant
--public-url <url>            canonical public HTTPS MCP resource
--tunnel cloudflared|none     managed quick tunnel or external connectivity
--login-connection <name>     login connection to enable for the verified client
--wait / --no-wait            enable or disable DCR polling
--wait-timeout <seconds>      DCR wait timeout, 1-3600; default 300
--poll-interval <seconds>     DCR poll interval, 0.1-60; default 3
--client-id <id>              explicit existing client for a reviewed repair path
--host <address>              local bind address; default 127.0.0.1
--port <number>               local MCP port; default 7331
--profile safe|developer|full runtime profile persisted into generated YAML
--full-access                 shortcut for full profile
--policy <mode>               readonly|safe|dev|danger
--tools-preset <id>           vibe|vibe-lite|readonly|full|godot
--adapters <list>             enabled child adapters
--dashboard                   enable the local dashboard
--dashboard-port <number>     dashboard port; default 7332
--offline-access              enable refresh-token capability
--dcr-client-policy require-grant
--force-config                rebuild generated YAML from explicit/default values
--no-start                    provision or repair without starting/restarting processes
--dry-run                     discovery and planned changes only
--json                        machine-readable output
```

## Dashboard

Enable the dashboard for the ChatGPT runtime:

```bash
folderforge connect chatgpt --dashboard
```

The dashboard and CLI read the same lifecycle receipt and call the same evaluator.
The ChatGPT page contains:

- overall status;
- connection timeline from tenant through authenticated MCP;
- diagnostics with evidence and repair guidance;
- actions for verification, Auth0 repair, DCR waiting, login connection repair,
  and user-grant repair;
- project and runtime configuration;
- bounded, redacted server and tunnel logs;
- the existing process, approval, policy, and audit views.

Auth0-only repairs run without restarting the process serving the dashboard.
Actions that would terminate or replace that process return a copyable terminal
command instead of self-terminating the dashboard.

## Generated local state

FolderForge writes runtime state below the selected project:

```text
.folderforge/chatgpt-config.yaml
.folderforge/chatgpt-connection.json
.folderforge/chatgpt-server.log
.folderforge/chatgpt-tunnel.log       # managed quick tunnel only
.folderforge/chatgpt-connect.lock     # only while an operation holds the lock
.folderforge/audit/audit.v2.jsonl
```

Config and receipt files use mode `0600` on POSIX systems. The version 2 receipt
stores non-secret evidence such as:

- tenant, issuer, resource, scopes, and public URLs;
- generated config and bounded log paths;
- managed process IDs;
- lifecycle checks, stage, diagnostics, and timestamps;
- verified public client ID and callback metadata;
- selected login connection IDs/names;
- user-grant ID, audience, scopes, and `subject_type=user`;
- authorize probe status and outcome.

The public OAuth client ID is not a secret. The receipt rejects secret-shaped
field names and complete JWT-shaped values before writing.

FolderForge does not persist or display:

- Auth0 Management API tokens;
- access, refresh, or ID tokens;
- authorization codes;
- client secrets or private keys;
- PKCE verifiers;
- API keys, passwords, cookies, or browser sessions;
- complete JWTs.

Dashboard and CLI output redact bearer credentials, JWTs, common token/secret
assignments, and API-key-shaped values.

## Idempotency and repair behavior

Re-running the primary command or `repair` is supported:

- the resource server is matched by its exact identifier before creation;
- unrelated scopes and descriptions are preserved;
- policy, token dialect, signing algorithm, lifetime, and offline-access drift are
  updated only when needed;
- connection membership is added only when absent and verified after mutation;
- the exact user grant is reused and receives only missing scopes;
- no Auth0 API, client, connection, or grant is deleted automatically;
- tenant boundaries are checked against the receipt;
- a PID lock prevents concurrent lifecycle mutations;
- `repair --no-start` leaves an already running process in place.

A local disconnect does not delete remote Auth0 resources because they may still
be shared by another environment or client.

## Troubleshooting

| Error or symptom                            | Meaning and action                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH0_LOGIN_REQUIRED`                      | Run `auth0 login`, select the tenant, then rerun repair.                                                                                                       |
| `AUTH0_SCOPE_MISSING`                       | Reauthenticate Auth0 CLI with the Management API scopes required to read/update tenant settings, resource servers, clients, connections, grants, and logs.     |
| `DCR_DISABLED`                              | Permit FolderForge to enable DCR or enable it in the tenant, then rerun.                                                                                       |
| `RESOURCE_SERVER_MISCONFIGURED`             | Run `folderforge chatgpt repair`; FolderForge repairs non-destructive drift.                                                                                   |
| `PORT_IN_USE`                               | Stop the conflicting process or choose `--port <number>`.                                                                                                      |
| `TUNNEL_STOPPED`                            | Inspect the redacted tunnel log and run repair. A new quick URL requires reconnecting ChatGPT.                                                                 |
| `PUBLIC_ENDPOINT_502`                       | The tunnel is reachable but the local origin is stopped or on the wrong port. Start the local server and verify the tunnel origin.                             |
| `METADATA_INVALID`                          | Ensure the public `/.well-known/oauth-protected-resource/mcp` and `/mcp` routes reach the same FolderForge instance.                                           |
| `CHATGPT_CLIENT_TIMEOUT`                    | Keep FolderForge waiting while clicking Connect. When the output reports ten counted applications, preview stale clients with `folderforge chatgpt prune-dcr`. |
| DCR registration returns `403` entity limit | The Auth0 tenant cannot create another application. Run `folderforge chatgpt prune-dcr` first; deletion requires a second reviewed run with `--yes`.           |
| `MULTIPLE_CHATGPT_CLIENTS`                  | More than one new client safely matched. Review them and explicitly select the intended public client ID.                                                      |
| `CALLBACK_MISMATCH`                         | Recreate the connector so Auth0 and ChatGPT use the exact `https://chatgpt.com/connector/oauth/...` callback.                                                  |
| `NO_CONNECTIONS_ENABLED`                    | Select a login connection with `--login-connection`, then run repair.                                                                                          |
| `CLIENT_NOT_AUTHORIZED`                     | Run repair so FolderForge creates or fixes the exact `subject_type=user` client grant.                                                                         |
| `TOKEN_EXCHANGE_FAILED`                     | Review Auth0 logs for callback, PKCE, consent, resource, and refresh-token policy errors. Tokens are never written to FolderForge logs.                        |
| `invalid_token` from `/mcp`                 | Check exact issuer, signature/key ID, asymmetric algorithm, expiry/not-before, and `aud` equal to the full public MCP URL.                                     |
| `insufficient_scope`                        | Reconnect or consent with `folderforge:read`; mutations also require `folderforge:write`.                                                                      |
| Too many tools in ChatGPT                   | Use a smaller `--tools-preset`, such as `vibe-lite`.                                                                                                           |

Useful commands:

```bash
folderforge chatgpt status
folderforge chatgpt doctor
folderforge chatgpt repair
folderforge chatgpt repair --no-start
```

## Security model

The OAuth grant is necessary but never sufficient to execute a tool. Every call
still passes through FolderForge workspace boundaries, command policy, risk
classification, approvals, rate limits, and append-only audit.

Additional boundaries:

- OAuth principals are agents, never dashboard administrators.
- Dashboard authentication remains separate from OAuth MCP authentication.
- Only the configured issuer and allowed JWKS origin are trusted.
- Access JWTs are checked for signature, asymmetric algorithm, issuer, audience,
  expiry, not-before, and scopes.
- DCR polling is bounded by tenant, session baseline, timeout, and interval.
- Automatic mutations target only the exact verified public client.
- Remote destructive cleanup is never automatic.
- Logs and receipts contain evidence, not credentials.

## Migration from receipt v1

Version 1 receipts are read and upgraded in memory to version 2. The next write
persists the new checks and lifecycle record. No token, secret, or user credential
is introduced by migration.

Behavior changes from the earlier quick-mode implementation:

- quick mode now defaults to `require-grant`, not `allow-all`;
- FolderForge creates a per-client user grant with `subject_type=user`;
- the machine/client subject policy is `deny_all`;
- the CLI waits for the ChatGPT DCR client and repairs its connection/grant;
- the normal DCR flow no longer asks the user to copy a `tpc_*` client ID;
- a changed temporary tunnel resource does not reuse the old client;
- status and dashboard expose the full shared lifecycle rather than only
  process/metadata readiness.

Existing generated YAML and unrelated Auth0 scopes are preserved unless
`--force-config` is used. Review deployments that intentionally relied on broad
third-party-client access before upgrading.

## Live acceptance boundary

Repository tests can prove discovery, policy repair, DCR matching, connection and
grant idempotency, authorize request construction, JWT validation, scope
enforcement, MCP initialize/list/call, dashboard rendering, and redaction.

The final Auth0 browser login/consent belongs to the user and ChatGPT. FolderForge
therefore reports `READY_TO_COMPLETE_LOGIN` before the browser step and only
reports `CONNECTED` after the verified client performs an authenticated MCP tool
call.
