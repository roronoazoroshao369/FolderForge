# Mission Control

Mission Control is FolderForge's local operator view for governed agent activity.
It is served by the existing dashboard process and reads the same runtime
`Container`, policy engine, audit log, durable task store, Workspace Capsule
store, process manager, isolation manager, and tool registry used by MCP calls.
It does not create a second execution path.

## What it shows

`GET /mission-control` returns one bounded, redacted snapshot containing:

- active tool calls;
- active Workspace Capsules and their principal/client/session/task binding;
- durable tasks, current step, pause state, and attached Proof Pack count;
- recent durable verification summaries and issue counts;
- pending approvals;
- FolderForge-managed processes;
- managed Git worktree isolations;
- recent governed audit activity; and
- aggregate counts for the dashboard summary.

Active-call records contain only tool metadata and argument **keys**. FolderForge
does not retain raw argument values in the active-call inventory. The inventory
is process-local and disappears when a call completes or the server restarts.

## Write freeze

The dashboard can persist a write freeze through:

```http
POST /mission-control/write-freeze
Content-Type: application/json

{ "enabled": true }
```

A write freeze:

1. records the previous policy mode;
2. atomically writes an integrity-checked state file at
   `.folderforge/mission-control.json`;
3. changes the effective policy mode to `readonly`; and
4. restores `readonly` on restart while the persisted freeze remains active.

The state file is denied to native agent file tools. Invalid schema or a SHA-256
integrity mismatch fails startup instead of silently disabling the freeze.
Disabling the freeze restores the policy mode that was active before it was
enabled, including an explicitly selected `readonly` mode.

A write freeze does not pretend to terminate a tool call already executing. It
blocks subsequent mutations and exposes containment actions for ongoing work.

## Containment actions

During write freeze, normal agents remain fully subject to `readonly`. A
server-generated dashboard role may bypass only the baseline readonly check for
these exact actions:

- `workflow_pause`
- `workflow_cancel`
- `process_stop`
- `process_kill`
- `isolation_rollback`
- `isolation_discard`

The exception cannot be requested through tool arguments or an MCP principal.
It is attached inside the authenticated dashboard server. All other policy,
policy-as-code, approval, audit, capsule, rate-limit, and handler checks remain in
force. For example, `process_kill` and destructive isolation operations can still
require a separate approval before execution.

Workspace Capsule revocation is also available directly from the admin plane
because it only reduces authority.

## Operator endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /mission-control` | Read the redacted operator snapshot. |
| `POST /mission-control/write-freeze` | Enable or disable persistent write freeze. |
| `POST /mission-control/tasks/:id/pause` | Pause a non-terminal owned/admin-visible task. |
| `POST /mission-control/tasks/:id/cancel` | Cancel a non-terminal task. |
| `POST /mission-control/processes/:id/stop` | Stop a FolderForge-managed process. |
| `POST /mission-control/processes/:id/kill` | Force-kill a FolderForge-managed process after policy/approval. |
| `POST /mission-control/capsules/:id/revoke` | Revoke an active Workspace Capsule. |
| `POST /mission-control/isolations/:id/rollback` | Roll back an exactly matching applied isolation. |
| `POST /mission-control/isolations/:id/discard` | Remove an eligible recovery worktree and branch. |

Mission Control cannot stop arbitrary operating-system processes. Process actions
are limited to sessions created and tracked by `ProcessManager`. Isolation actions
retain all byte-level drift, patch-integrity, state, symlink, and worktree checks.

## Authentication boundary

The dashboard is an admin control plane:

- loopback binding is trusted as same-machine access;
- non-loopback binding requires a dashboard bearer token;
- the dashboard creates a distinct operator-action principal for governed tool
  calls; and
- agent MCP clients cannot assign the internal Mission Control operator role.

A remote multi-tenant operator console or relay is not implemented by this
feature. Mission Control is locally verified only.

## Reproducible verification

```bash
npx vitest run tests/unit/mission-control.test.ts
npx vitest run tests/unit/tool-control.test.ts
npx vitest run tests/integration/dashboard-admin.test.ts
npm run verify
```

The tests cover restart persistence, prior-mode restoration, state tampering,
exact containment allowlisting, agent denial, active-call value redaction,
write-freeze mutation blocking, and a live dashboard stop-process flow.
