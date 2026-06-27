# Security

FolderForge assumes the agent is capable but not fully trusted. Security is
enforced server-side; the agent can request anything, but the policy engine
decides.

## Policy modes

Set via `policy.defaultMode` or the `policy_set_mode` tool.

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

HIGH/CRITICAL (and any tool in `policy.requireApproval`) create a pending
`ApprovalRequest` (`src/policy/approvals.ts`). Resolve them in the dashboard
(`POST /approvals/:id/approve|deny`) or via approval tools. `session`-scoped
approvals remember the tool for the rest of the session.

Approvals are **persisted across restarts**: every create/approve/deny is
appended to `<project>/.vibemcp/approvals.jsonl` (append-only, compacted on
load). Pending and resolved requests survive a restart so the dashboard history
stays intact. Session-scoped allowances are **not** re-armed automatically - a
fresh process starts a fresh session, so a session approval from a previous run
must be granted again.

## MCP HTTP auth

The MCP HTTP transport (`src/server/transports/http.ts`) is credential-gated
the same way the dashboard is. **When a credential is configured, every request
to the MCP endpoint must present a matching one, or it gets a `401`.**

Auth is enforced when **any** of these holds:

- `server.http.token` or `server.http.apiKeys` is set;
- the bind host is non-loopback (a credential becomes mandatory; if none is set
  one is generated and logged once);
- `server.http.requireAuth: true` (or the `--require-auth` flag) - forces auth
  even on loopback.

If auth is required but no credential resolves, **startup throws** rather than
running open.

Accepted credentials and how clients send them:

- The primary `server.http.token` plus every entry in `server.http.apiKeys`.
- A client may present any of them via **`Authorization: Bearer <cred>`** or
  **`X-API-Key: <cred>`**.
- Comparison is constant-time (`matchesAnyCredential` walks the whole list so
  timing never reveals which credential matched).
- Missing/invalid -> `401` with `WWW-Authenticate: Bearer realm="folderforge-mcp"`.

Config and CLI:

```yaml
server:
  http:
    token: "primary-admin-token"
    apiKeys: ["client-a-key", "client-b-key"]
    requireAuth: true
```

```bash
folderforge --http --host 0.0.0.0 --token <secret> --api-key k1,k2 --require-auth
```

See the README "Authentication" section for end-to-end run + `curl` examples.

## Dashboard auth

The dashboard (`src/dashboard/server.ts`) is unauthenticated when bound to a
loopback host (`127.0.0.1`, `::1`, `localhost`), since that is same-machine
only. When bound to any **non-loopback** address it **requires a bearer token**:

- Set it explicitly via `server.dashboard.token`, or
- leave it unset and FolderForge generates one at startup and logs it once.

Clients authenticate with `Authorization: Bearer <token>` or a `?token=<token>`
query parameter; the comparison is constant-time. Missing/invalid tokens get a
`401` with a `WWW-Authenticate: Bearer` header. Binding to a non-loopback host
with no token available is a startup error.

## Audit

Every call, denial, and approval is appended to
`<project>/.folderforge/audit/audit.jsonl` and kept in a 500-entry ring buffer
for `audit_recent` and the dashboard `/audit` endpoint.
