# ADR-0009: Dynamic MCP tool-surface propagation

- **Status:** Accepted
- **Date:** 2026-07-21
- **Related pillars:** tool-surface intelligence and child MCP compatibility

## Context

FolderForge can change its agent-visible tool catalog at runtime through routing,
plugin lifecycle operations, and child MCP `notifications/tools/list_changed`.
Previously the child client invalidated its catalog cache, but the parent MCP
server advertised `tools: {}` and did not notify connected clients. Direct
(non-facade) child wrappers could therefore remain stale after a child changed
its tool list.

## Decision

1. `ToolRegistry` owns the observable agent-visible catalog and emits a change
   event only when the effective MCP metadata changes.
2. Registry group replacement is atomic. Replacement wrappers inherit routing
   visibility and produce at most one catalog-change event.
3. The parent MCP server advertises `tools.listChanged: true`, subscribes to the
   registry, sends `notifications/tools/list_changed`, and removes the listener
   when the connection closes.
4. `ChildMcpRegistry` exposes child catalog invalidations. Direct adapters are
   rediscovered serially and their wrappers are replaced only after discovery
   succeeds. A failed refresh retains the previous wrappers.
5. Facade adapters do not replace their fixed two-tool parent surface. Their
   discovery tool reads the invalidated catalog on the next call, so no parent
   list-change notification is emitted when only facade sub-tools change.

## Safety and reliability properties

- Admin-only tools never participate in the agent-visible snapshot.
- Identical registration or routing state does not create notification noise.
- Listener failures are isolated and logged.
- Concurrent refresh notifications for one adapter are serialized.
- Discovery failure does not create a transient empty parent catalog.
- Tool execution still enters the existing policy and audit pipeline; this ADR
  changes discovery metadata, not governance classification.

## Trade-offs

The registry computes a deterministic metadata snapshot on catalog mutations.
This adds work to rare registration/routing operations but avoids hashing or
comparison cost on every `tools/list` request. The snapshot deliberately covers
MCP-visible metadata rather than handler identity or internal risk fields.

A facade child's sub-tool catalog can change without a parent tool-list
notification because the parent still exposes the same `list_tools` and
`call_tool` pair. Clients must call the facade discovery tool to observe those
sub-tool changes.

## Verification

```bash
npx vitest run \
  tests/integration/adapters.test.ts \
  tests/integration/mcp-platform.test.ts \
  tests/unit/registry-metadata.test.ts \
  tests/unit/child-mcp-client.test.ts
npm run typecheck
npm run lint
npm run architecture:check
```

The integration evidence starts a real diagnostic child process, observes
`echo-v1` changing to `echo-v2`, verifies atomic direct-wrapper replacement,
receives the parent notification through an SDK client, and confirms the next
`tools/list` contains only the new wrapper.
