# Mission Control API contract (draft v1)

> Companion to [ADR-0012](./adr-0012-mission-control-control-plane.md).
> This contract is the only surface the SPA may consume. Internal container
> types, unredacted arguments, and secret values are never part of it.

## Conventions

- Base: dashboard HTTP server (default `127.0.0.1:7332`).
- Auth: loopback trusts same-machine access; non-loopback requires
  `Authorization: Bearer <dashboard-token>`. OAuth deployments follow
  [oauth.md](./oauth.md) scopes: reads need `folderforge:read`, mutations also
  need `folderforge:write`.
- Every response is bounded and recursively redacted with the same key-aware,
  regex, and entropy redaction used by audit records.
- Errors: `{ "error": { "code": string, "message": string } }` with HTTP status
  `400 | 401 | 403 | 404 | 409 | 429`.
- Mutating endpoints are idempotent by target id; repeating a stop on a stopped
  instance returns the current state, not an error.

## Existing endpoints (kept stable)

| Endpoint | Purpose |
| --- | --- |
| `GET /mission-control` | Redacted operator snapshot (read model for the SPA). |
| `POST /mission-control/write-freeze` | Enable/disable persistent write freeze. |
| `POST /mission-control/tasks/:id/pause` / `cancel` | Task containment. |
| `POST /mission-control/processes/:id/stop` / `kill` | Managed-process containment. |
| `POST /mission-control/capsules/:id/revoke` | Revoke a Workspace Capsule. |
| `POST /mission-control/isolations/:id/rollback` / `discard` | Isolation containment. |

## New: fleet provisioning (Phase 1)

| Endpoint | Purpose |
| --- | --- |
| `GET /fleet` | List provisioned instances (no secret values, `secretRef` only). |
| `POST /fleet` | Create an instance: `{ projectPath, toolsPreset?, policyMode?, port? }` -> `{ id, port, tokenPreview }`. `tokenPreview` is shown once at creation only. |
| `GET /fleet/:id` | Instance detail: state, uptime, port, tunnel binding, last health check. |
| `POST /fleet/:id/start` / `stop` | Lifecycle transitions (approval-gated). |
| `POST /fleet/:id/rotate-token` | Rotate the instance credential; old value invalidated immediately. |
| `GET /fleet/:id/logs?cursor=` | Bounded, redacted log tail with cursor pagination. |
| `DELETE /fleet/:id` | Destroy after stop; removes state file; audit-recorded (CRITICAL). |

Instance state machine: `stopped -> starting -> running -> stopping -> stopped`,
plus `failed` with `lastError`. Every transition is an audit event.

## New: tunnels (Phase 3)

| Endpoint | Purpose |
| --- | --- |
| `GET /tunnels` | Active tunnels: kind (cloudflared/openai), URL, uptime, bound instance id. |
| `POST /tunnels` | Start a tunnel for an instance: `{ instanceId, kind }` (requires `auth.mode != "none"` on the target; approval-gated). |
| `POST /tunnels/:id/stop` | Stop and detach; writes a tunnel receipt to the audit log. |

## New: council visibility (Phase 4)

| Endpoint | Purpose |
| --- | --- |
| `GET /council/runs` | Recent council workflow runs (from the durable workflow store). |
| `GET /council/runs/:id` | Run detail: role scopes, step states, redacted evidence, KPIs. |

Council mutations are intentionally absent: councils run through
`workflow_create` / `workflow_run` on the MCP plane, not through the admin API.

## Versioning

- Paths above are `v1`; breaking changes add `/v2/...` while `v1` keeps working
  for at least one minor release.
- The SPA build records the contract version it was built against and warns on
  mismatch instead of failing open.
