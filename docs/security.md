# Security

FolderForge assumes the agent is capable but not fully trusted. Security is
enforced server-side; the agent can request anything, but the policy engine
decides.

## Policy modes

Set at startup via `policy.defaultMode` or changed at runtime through the dashboard admin endpoint `POST /policy/mode`. The frozen `policy_set_mode` definition is admin-only and is not exposed to agent MCP clients.

| Mode | Mutations | HIGH risk | CRITICAL |
| --- | --- | --- | --- |
| `readonly` | denied | denied | denied |
| `safe` | allowed (LOW/MEDIUM) | approval | denied |
| `dev` | allowed | approval | denied |
| `danger` | allowed | approval | approval |

The decision logic lives in `PolicyEngine.evaluate` (`src/policy/policy-engine.ts`).
Use the `policy_explain` tool to dry-run any call and see the decision
(`allow`/`deny`/`approval`) and contributing factors **without** executing it or
creating an approval request (backed by `PolicyEngine.explain`).

## Path policy

`src/policy/path-policy.ts` guarantees that every file path:

1. resolves **inside** an allowed directory (`workspace.allowedDirectories`);
2. is **not** matched by a denied glob (`workspace.deniedGlobs`, e.g. `**/.env`,
   `**/*.pem`, `**/node_modules/**`);
3. does **not** escape via symlink (the nearest existing ancestor is
   `realpath`-resolved and re-checked);
4. does not touch protected credential folders (`~/.ssh`, `~/.aws`, `~/.gnupg`,
   `~/.config/gcloud`, `~/.kube`).

Violations throw `PathEscapeError` and surface as a structured tool error.

## Command policy

`src/policy/command-policy.ts` classifies shell commands:

- **CRITICAL** (always blocked): `rm -rf /`, `sudo`, `mkfs`, `dd if=`,
  `chmod -R 777 /`, `curl ... | bash`, `git reset --hard`, `git push --force`,
  fork bombs, `docker system prune`, `kubectl delete`, `terraform apply`, ...
- **HIGH** (approval): `git push`, `git reset`, `docker rm`, `npm publish`,
  `rm -rf ...`.
- **MEDIUM** (allowed, audited): package installs, `docker compose up`, builds.
- **LOW**: everything else.

Config `policy.blockedCommands` adds project-specific substring/wildcard rules
on top of the built-in regex set.

## Secret policy

`src/policy/secret-policy.ts` detects and redacts common credentials (OpenAI,
Anthropic, AWS, GitHub, Google, Slack tokens, private-key blocks, generic
`key=value` secrets). It powers:

- `secret_scan` for explicit scans;
- terminal env redaction when `terminal.envPolicy: redact`;
- output redaction before content leaves the server.

## Approvals

HIGH/CRITICAL actions (and tools listed in `policy.requireApproval`) create a
pending `ApprovalRequest` (`src/policy/approvals.ts`). Agent-facing MCP clients
may create and inspect requests but cannot approve, deny, or elevate policy.
Resolution is restricted to the dashboard admin endpoints
`POST /approvals/:id/approve|deny`.

Every request records a requester principal and `expiresAt`; the default lifetime
is `policy.approvalTtlMs = 900000` (15 minutes). The requester cannot approve its
own request, even if the same credential is presented through another plane.
A distinct admin principal is recorded as `approverId` when resolving it.

Approvals are **persisted across restarts** in
`<project>/.folderforge/approvals.jsonl` (or the explicit
`FOLDERFORGE_APPROVALS_PATH` override). A `once` approval matches requester,
exact tool, and canonical arguments, is consumed by one retry, and cannot be
replayed or used by another principal. Exact matching uses a SHA-256 fingerprint
of the canonical unredacted arguments; persisted records retain only recursively
redacted argument evidence and are written mode `0600`. A `session` approval is
scoped to requester + tool for the current process and is not re-armed after
restart. Audit summaries use the same key-aware, regex, and entropy-based
redaction path.

## MCP HTTP authentication

`server.http.auth.mode` supports `none`, `token`, and `oauth`.

- `none` is accepted only on loopback.
- `token` accepts explicitly configured static credentials through
  `Authorization: Bearer` or `X-API-Key`; comparisons are constant-time.
- `oauth` accepts only a Bearer JWT from the configured external authorization
  server. Static token/API-key configuration is rejected rather than used as a
  fallback.

OAuth mode is a resource-server implementation, not a bundled identity
provider. Startup discovers the explicitly configured issuer, requires PKCE
`S256` support and the selected CIMD/DCR/predefined client strategy, validates
endpoint schemes, and constrains discovered JWKS to the issuer host or an
explicit trust configuration. Production issuer/resource/JWKS URLs require
HTTPS. The unsafe HTTP escape hatch permits loopback URLs only.

Every OAuth request verifies signature, allowed asymmetric algorithm, exact
issuer, exact resource audience, `exp`, `nbf`, access-token JWT type when present,
and scopes. Missing/invalid tokens
return `401` with RFC 9728 `resource_metadata`; insufficient transport scope
returns `403` with `error="insufficient_scope"`, the required scope, and the
same metadata URL. Tool-level step-up errors include
`_meta["mcp/www_authenticate"]` for ChatGPT.

Read-only tools require `folderforge:read`; mutating tools require both
`folderforge:read` and `folderforge:write`. Enforcement occurs before the tool
registry invokes the handler and is repeated inside the registry as defense in
depth. OAuth principals always have role `agent`. They cannot advertise or call
admin-only tools, approve their own requests, change policy mode, or inherit
dashboard authority.

FolderForge does not log or persist access/refresh tokens, authorization codes,
client secrets, private keys, PKCE verifiers, or cookies. OAuth request failures
return generic messages so crypto/discovery internals are not reflected to the
client. Issuer/resource URLs may appear in startup logs because they are public
metadata, not credentials.

See `docs/oauth.md` and `docs/adr-0004-oauth-resource-server.md` for deployment,
threat-model, and ChatGPT setup details.

## Dashboard auth

The dashboard (`src/dashboard/server.ts`) is unauthenticated when bound to a
loopback host (`127.0.0.1`, `::1`, `localhost`), since that is same-machine
only. When bound to any **non-loopback** address it **requires a bearer token**:

- Set it explicitly via `server.dashboard.token`.
- Startup fails on a non-loopback dashboard bind when the token is absent; no credential is generated or printed.

Clients authenticate with `Authorization: Bearer <token>` or a `?token=<token>`
query parameter; the comparison is constant-time. Missing/invalid tokens get a
`401` with a `WWW-Authenticate: Bearer` header. Binding to a non-loopback host
with no token available is a startup error.

## Audit

Every call, denial, and approval is appended to
`<project>/.folderforge/audit/audit.jsonl` and kept in a 500-entry ring buffer
for `audit_recent` and the dashboard `/audit` endpoint. Tool argument summaries
are redacted before recording; raw approval arguments are not copied into audit
summaries.
