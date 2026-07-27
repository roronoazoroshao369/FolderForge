# MCP HTTP session reliability and reconnect contract

FolderForge's Streamable HTTP transport keeps an initialized MCP session alive
across tool discovery, reads, writes, shell calls, progress notifications, and
tool-surface routing. Legacy clients that send standalone requests without an
`initialize` handshake remain supported through stateless request handling.

## Session lifecycle

- A successful `initialize` response returns `Mcp-Session-Id`.
- The session is bound to the authenticated principal that created it.
- `server.http.sessionTtlMs` controls idle expiry and defaults to 30 minutes.
- Active requests are never evicted by the idle sweeper.
- Client `DELETE`, idle expiry, initialize failure, and server shutdown close the
  retained MCP server and transport.
- A request carrying an expired, foreign, or pre-restart session ID receives a
  clear HTTP 404 JSON-RPC error. The client must initialize a new session.

Every HTTP response includes:

- `X-FolderForge-Instance-Id`
- `X-FolderForge-Started-At`

`GET /healthz` also reports the instance identity, start time, active-session
count, and configured session TTL. A changed instance ID proves that the local
MCP process restarted even when the public URL stayed the same.

## Mutating-operation evidence

Every governed mutating tool result includes an `operationId` and one execution
state:

- `executed`: the handler started and returned a terminal result;
- `replayed`: the same JSON-RPC request ID and canonical arguments were already
  handled in the current session, so FolderForge returned the recorded result
  without executing the handler again;
- `not_started`: policy, approval, quota, cancellation, or required pre-execution
  evidence prevented handler execution;
- `outcome_uncertain`: handler execution started, but required terminal audit
  evidence could not be persisted. Do not retry automatically.

Reusing one request ID for different mutating arguments fails with
`MCP_REQUEST_ID_CONFLICT`. Numeric and string JSON-RPC IDs are distinct.
Pending operations are not evicted from the replay ledger, preventing a retry
from bypassing deduplication during high concurrency.

The replay ledger is intentionally process- and session-scoped. After a process
restart, FolderForge rejects the old session instead of guessing whether an
unacknowledged write should run again. Reinitialize, inspect the previous
`operationId` in audit evidence or verify the target state, then decide whether a
new operation is required.

## Tool discovery and routing

Every task preset keeps these recovery tools visible:

- `workspace_route`
- `workspace_status`
- `workspace_health`
- `workspace_list`

A preset can therefore narrow the catalog without hiding the tools required to
inspect or restore it. Repeated `tools/list` calls remain valid in the same
session.

## Public endpoint stability

Transparent reconnect after a local MCP restart requires a stable public URL.
A Cloudflare quick tunnel uses a random `trycloudflare.com` hostname that cannot
be reclaimed after the tunnel process exits. If it restarts, an external client
or connector registry still points to the old hostname and will continue to see
502 or unreachable-endpoint errors until the connector is recreated or repaired
with the new URL.

Use secure mode with a stable public URL for long-running, team, or production
sessions. Quick tunnels are suitable only for temporary development. FolderForge
can identify local instance changes and reject stale session IDs, but it cannot
mutate an external client's connector registry on its behalf.

## Regression coverage

The primary regression suite is:

```bash
npx vitest run tests/integration/http-session-lifecycle.test.ts
```

It verifies durable sessions, stateless compatibility, idle expiry, active-call
protection, principal binding, duplicate-write replay, request-ID conflict,
number/string ID separation, restart behavior, and writes after reconnect.

Related coverage includes HTTP hardening, OAuth scope enforcement, file writes,
audit durability, policy decisions, approvals, schema locking, and MCP platform
integration.
