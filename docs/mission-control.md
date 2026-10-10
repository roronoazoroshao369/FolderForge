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

## Worktree health and safe discard in Overview

Both `GET /mission-control` and `GET /isolations` include additive observed health, separate from historical lifecycle state. The UI reports **Available**, **Worktree missing**, **Identity mismatch**, **Unable to verify**, or **Health unavailable** for older/omitted fields. Unknown or unhealthy worktrees never expose a Discard confirmation button.

The server repeats policy, approval, audit and Git identity checks even after an operator has opened a confirmation. Both already-existing `POST /isolations/:id/discard` and `POST /mission-control/isolations/:id/discard` return HTTP 409 with structured health errors on missing worktree. No second execution engine or additional mutation endpoint was introduced. A stale open dialog cannot bypass server-side rejection. See [task isolation safety](task-isolation.md).

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

## Control Panel runtime settings

The Settings screen manages an existing FolderForge instance while its dashboard
is running. The selected policy mode is stored in the integrity-checked
`.folderforge/mission-control.json` and restored at the next startup unless a
write freeze is active (which still restores `readonly`).

`GET /runtime/settings` returns the effective terminal timeout, output budget,
environment redaction policy, and sandbox/containment requirement, without
revealing secrets. `POST /runtime/settings` accepts **only**:

```json
{ "defaultTimeoutMs": 30000, "maxOutputBytes": 65536 }
```

Timeout is limited to 1,000–1,800,000 milliseconds and output to
1,024–2,000,000 bytes. Changes apply to new terminal commands and survive
restarts in `.folderforge/runtime-settings.json`, atomically written with 0600
permissions and validated on load. Malformed data fails closed; dashboard
write freeze blocks updates.

The sandbox engine and danger containment requirement are **read-only** in this
web endpoint. Configuring a Docker/Podman image or opting into unsandboxed host
execution remains an explicit local server configuration action followed by a
restart. Dashboard tokens are required on non-loopback deployments; existing
blocked-command, workspace, audit, and rate-limit controls are unchanged.

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

## Fleet terminal execution profiles

Fleet > Provision and Fleet > Configure now expose two terminal execution profiles:

- `sandbox-required` — danger-mode shell execution fails closed unless a
  container sandbox is configured for that instance.
- `trusted-host` — the MCP server executes shell commands with its host OS
  user's permissions in danger mode, without a Docker/Podman boundary.

**Host-operator authorization is mandatory.** Two paths are distinct:

- **macOS per-instance zero-YAML consent (requires qualification):** in Fleet > Configure select `full`, `danger` and `trusted-host`, then choose **Save changes**. An authenticated Dashboard creates an immutable pending intent, but cannot grant host execution. On the Mac running the FolderForge parent, the OS-account owner runs the exact displayed command, e.g. `folderforge operator trusted-host approve req_<request-id>`, then types `APPROVE flt_<instance-id>` into an interactive terminal. The Dashboard polls for the matching grant and applies the exact three-setting tuple through a journaled transaction. Do **not** hand-edit Fleet YAML. A Dashboard Bearer token is required even on localhost; a `?token=` query parameter alone is insufficient. Saved settings on a running child are **not yet the active process profile**; stop/start only when safe.
- **Legacy explicit startup opt-in:** the host owner can still use parent `terminal.sandbox.mode: process` and `terminal.sandbox.requireInDanger: false`; this backward-compatible global setting is not silently changed by the new UI.

The Fleet instance must have authenticated MCP access (`authMode` cannot be `none`). Revoking a scoped grant through `folderforge operator trusted-host revoke req_<request-id>` prevents **future** elevated starts; an already-running child needs supervised/manual termination verification. The capability's scope hash is never exposed in a Dashboard URL or printed as a bearer secret. Same-UID malicious processes and physical-presence assurance are **outside** this feature's security guarantee; hosted macOS CI primitive tests do not replace real macOS acceptance or APFS crash-durability qualification. Generated 0600 credentials, audit, hard-denies and OS file permissions remain enforced.

This option does **not** remove the command deny list, OS file permissions,
workspace authorization for native tools, audit, or rate limits. It also does
not configure separately launched third-party MCP/plugin runtimes or the
OpenAI Tunnel supervisor. Secure those runtimes independently. Avoid exposing a
trusted-host instance without strong authentication.
