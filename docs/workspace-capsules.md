# Workspace Capsules

Workspace Capsules are server-side authorization envelopes for a single
FolderForge workspace and execution identity. They do not rely on the MCP client
or model to self-restrict.

## Contract

A persisted capsule binds all of the following:

- canonical workspace root and hash-derived workspace/project identity;
- principal identity, with optional OAuth client and session binding;
- optional durable task identity;
- permission profile, granted scopes, expiry, and revocation state;
- isolation strategy, network policy, call/mutation/file/command budgets;
- evidence destination and client compatibility profile.

The store is written atomically with mode `0600` at
`.folderforge/capsules.json` and carries a SHA-256 integrity digest over the
canonical capsule array. Native file tools deny access to this control-plane
file. Corrupt or schema-invalid state fails closed at startup. A matching capsule is evaluated in `ToolRegistry` before ordinary policy
and approval handling, and its budget is reserved immediately before handler
execution.

## Enforcement modes

`capsule.enforcement` accepts:

| Value | Missing-capsule behavior |
| --- | --- |
| `optional` | Existing matching capsules are enforced; callers without one retain legacy behavior. This is the compatibility default. |
| `remote` | Static-token and OAuth callers require an active matching capsule. Local stdio remains compatible. |
| `all` | Every non-admin tool caller requires an active matching capsule. |

Dashboard operators are outside the agent capsule boundary, but their actions
remain separately authorized and audited.

## Permission profiles

| Profile | Intended behavior | Current enforcement |
| --- | --- | --- |
| Observe | Read/search/inspect only | Every mutating tool and command is denied. |
| Propose | Edit only inside an isolated task worktree | Mutation requires a worktree registered by `WorktreeManager`; network-capable and unsandboxed command tools are denied. |
| Develop | Bounded direct/checkpoint development | File mutations use existing policy/approval gates and capsule budgets; push/reset and selected publish operations remain outside the capsule boundary. |
| Autopilot | Bounded autonomous worktree execution | Requires a managed worktree; CRITICAL and publication operations are denied. Command execution remains disabled until the process sandbox is connected to capsule enforcement. |

The profile name is not trusted as evidence. For Propose and Autopilot,
FolderForge checks the current root against its persisted worktree registry.

## Exact boundaries

Capsule matching fails closed on:

- principal, project, session, or OAuth client mismatch;
- expiry or revocation;
- path arguments that resolve outside the capsule root, including nearest-existing
  ancestor symlink resolution;
- exhausted call or mutation budgets;
- file-count and command-length limits;
- optional tool/group/read/write scope allowlists;
- crossing from a source capsule into a different managed worktree;
- profile, network, worktree, or hard autonomous exclusions.

Approval retries are additionally bound to client, project, session, capsule,
and task fingerprints. Changing any dimension creates a new approval request.

## Control plane

Agent-visible read tool:

- `capsule_status`

Loopback dashboard API:

- `GET /capsules`
- `POST /capsules`
- `POST /capsules/:id/revoke`

Creation and revocation emit durable policy-change audit events. The dashboard
never returns raw bearer tokens or secrets as part of a capsule.

## Known limitations

- The compatibility default is `optional`; deployments that require remote
  capsules must explicitly select `remote` or `all`.
- All capsules currently deny generic command/process and command-backed
  verification tools because cwd alone cannot enforce a filesystem or network
  sandbox. This is a deliberate fail-closed limitation, not a claim that shell
  commands are isolated.
- Client labels (`chatgpt`, `claude`, `generic`) are compatibility metadata, not
  proof of live external-client acceptance.
