# ChatGPT connection lifecycle implementation plan

This file tracks the one-command Auth0/DCR lifecycle shared by the CLI and
dashboard.

## State machine

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

Known failures are represented as typed states rather than free-form strings:
Auth0 login/scope failures, disabled DCR, resource-server drift, stopped local or
tunnel processes, public 502, invalid metadata, unauthorized client, missing
login connections, callback mismatch, token exchange failure, tool-limit
rejection, DCR timeout, and multiple matching clients.

## Milestones

- [x] Baseline repository, Auth0 CLI, tenant-schema, and protocol discovery
- [x] Shared lifecycle, diagnostics, timeline, actions, and redaction model
- [x] Session-bounded DCR watcher with exact ChatGPT callback and resource-log proof
- [x] Dedicated login-connection membership provisioning and verification
- [x] Per-client `subject_type=user` grant provisioning and idempotent scope repair
- [x] Authorize probe with PKCE S256, callback, scopes, and resource indicator
- [x] CLI one-command wait/repair/status/doctor/start/stop lifecycle integration
- [x] Receipt v1 to v2 migration without credentials
- [x] Dashboard shared status, timeline, diagnostics, actions, configuration, and logs
- [x] Exact OAuth-client audit correlation before reporting `CONNECTED`
- [x] Unit and integration regression coverage for known production failures
- [x] Quick start, expected flow, troubleshooting, security, and migration docs
- [ ] Final full release check and Definition of Done audit

## Safety boundaries

FolderForge never stores Management API tokens, access/refresh/ID tokens,
authorization codes, PKCE verifiers, cookies, client secrets, private keys, or
complete JWTs.

Automatic client mutation requires a session-bounded DCR client whose name,
external DCR markers, public-client behavior, ChatGPT callbacks, and exact
FolderForge resource log all match. A reviewed existing client can be supplied
explicitly for repair. Multiple matches fail closed.

FolderForge adds a client only to selected login connections and creates a
per-client user grant for the exact audience and scopes. It never enables a
connection for every tenant client, never grants an unknown client, and never
deletes remote Auth0 resources automatically.

## Implemented test evidence

Targeted lifecycle suite covers:

- delayed DCR client appearance;
- DCR timeout;
- changed/new client IDs;
- multiple matching clients;
- callback and resource mismatch rejection;
- unique and ambiguous login-connection selection;
- connection membership repair and post-verification;
- user-grant creation, scope repair, subject type, and idempotency;
- no-connection and unauthorized-client authorize errors;
- resource-server policy repair without restarting the server;
- OAuth metadata, `401` challenge, issuer/audience/scope rejection, valid JWT,
  MCP initialize, tools/list, and tool call;
- CLI/dashboard state consistency;
- exact-client authenticated activity before `CONNECTED`;
- dashboard action failures and textual log redaction.

Release-gate evidence is recorded after the final typecheck, lint, test, build,
package, packed CLI, stdio/HTTP MCP, audit, secret scan, and Git-diff checks.
