# Policy as code and execution identity

FolderForge loads restrictive project policy from `.folderforge/policies/*.yaml`
and optional project-relative entries in `policy.files`. Policy files supplement the
built-in mode, risk, command, path, approval, OAuth, rate-limit, and secret controls;
they never replace or weaken them.

## Schema

```yaml
version: 1
name: production-boundary
rules:
  - id: deny-production-writes
    effect: deny
    tools: ["file_*", "db_*"]
    mutates: true
    modes: [safe, dev, danger]
    principals:
      roles: [developer]
      organizationIds: ["org:acme"]
      teamIds: ["team:platform"]
      projectIds: ["project:*"]
    reason: Production writes are blocked for developers

  - id: security-review-shell
    effect: approval
    tools: [shell_exec]
    risks: [MEDIUM, HIGH]
    principals:
      organizationIds: ["org:acme"]
    reason: Security review is required for shell execution
```

A document must use `version: 1` and contain at least one rule. Rule IDs must be
unique across all loaded files. Unknown keys, invalid enums, duplicate IDs,
malformed YAML, missing configured files, and paths outside the project fail
startup instead of silently weakening policy.

Only two effects exist:

- `deny` — the call is rejected before quota or handler execution;
- `approval` — the call enters the existing principal-bound approval workflow.

There is deliberately no `allow` effect. A policy file cannot bypass readonly mode,
CRITICAL restrictions, OAuth scope requirements, command/path policy, or a baseline
approval requirement. `deny` wins when multiple rules match. An explicit policy
`approval` rule remains active in danger mode.

## Selectors

Rules may combine:

- `tools`: required glob patterns over the effective governed tool identity;
- `risks`: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`;
- `mutates`: exact mutation flag;
- `modes`: `readonly`, `safe`, `dev`, or `danger`;
- `principals.ids`;
- `principals.roles`;
- `principals.organizationIds`;
- `principals.teamIds`;
- `principals.projectIds`;
- `principals.sessionIds`.

All provided selector dimensions must match. A selector for organization, team,
project, or session does not match a principal that lacks that claim, including wildcard
patterns. Tool matching uses the effective identity after dynamic classification,
so facade and plugin sub-tools are governed by their real operation names.

## Execution identity

Every tool pipeline receives a `ToolPrincipal` with:

- authenticated principal ID and coarse role;
- optional RBAC roles;
- optional trusted organization claim and verified team/group memberships;
- stable project identity derived from the canonical project root;
- connection/session identity derived from the authenticated principal and MCP
  session hint;
- authentication mode, OAuth client, and scopes where applicable.

Verified OAuth claims may supply `org_id`/`organization_id`, a string-array
`roles` claim, and team memberships through `team_ids`, `teams`, or `groups`.
Local stdio/token sessions receive local organization, team, project, and
session context. A client-provided MCP session header is hashed together with the
authenticated principal and is never an authentication factor by itself.

Policy decisions, approval requests, rate limits, tool results, and tool errors
carry the identity dimensions in the append-only audit trail. Approval consumption
continues to bind to the authenticated principal and exact canonical arguments;
execution session context adds correlation and policy selectors but does not weaken
that binding.

## Configuration

The default directory requires no config:

```text
.folderforge/policies/*.yaml
```

Additional files or directories may be declared:

```yaml
policy:
  files:
    - policies/team.yaml
    - policies/environments
```

Every path is resolved relative to the project and must remain inside it. Files
must end in `.yaml` or `.yml`. Configuration is loaded once at startup; changing a
policy file requires a controlled server restart so the effective policy and audit
boundary remain deterministic for the process lifetime.
