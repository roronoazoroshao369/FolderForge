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

## Audit

Every call, denial, and approval is appended to
`<project>/.folderforge/audit/audit.jsonl` and kept in a 500-entry ring buffer
for `audit_recent` and the dashboard `/audit` endpoint.
