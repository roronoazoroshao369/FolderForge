# Architecture

FolderForge is an MCP-native control plane that sits between an AI
coding agent and a local development workspace. It exposes a single, curated set
of tools over the Model Context Protocol and wraps every call in a policy +
audit pipeline.

## High-level flow

```
agent (Claude Desktop / Codex / ...)
        |  JSON-RPC (MCP)
        v
 transport (stdio | streamable http)      src/server/transports/*
        |
        v
   MCP Server                              src/server/mcp-server.ts
        |  tools/list  -> registry.listActive()
        |  tools/call  -> registry.call()
        v
  ToolRegistry  --------------------------- src/tools/registry.ts
        |  classify risk -> PolicyEngine.evaluate()
        |  audit.record()
        v
  PolicyEngine  --------------------------- src/policy/policy-engine.ts
   (path / command / secret / approvals)
        |  allow | deny | approval-required
        v
  [approval-required path] ─────────────────────────────────────────
        |                                                            |
        | client.capabilities.elicitation == true                   | false / error
        v                                                            v
  elicitInput (Approve/Deny in chat)           dashboard fallback (appr_xxx)
   scope: once | session                       http://localhost:7332/
        |
        | approved → resolve inline
        | denied  → error returned
        v
  Tool handler / child adapter             src/tools/* + src/adapters/*
        |  may return ToolContentBlock[]
        |  (text | image | resource | resource_link)
        |  child isError -> ToolResult.ok=false
        v
  toCallToolResult → MCP content blocks    src/server/mcp-server.ts
   text block always first (back-compat)
   image blocks render directly in vision-capable clients
   embedded resource (e.g. text/x-diff for git_diff)
        v
  Runtime composition                       src/runtime/container.ts
   (workspace, processes, db, adapters, audit)
```

A second, independent HTTP server serves the local dashboard
(`src/dashboard/server.ts`), which reads the same `Container` to render status,
audit, processes, and approvals. The dashboard is the **fallback** approval UI
when the MCP client does not advertise the `elicitation` capability.

## Modules

| Area | Path | Responsibility |
| --- | --- | --- |
| Entrypoint | `src/main.ts` | Parse args, `loadConfig`, build `Container` + registry, start server + dashboard |
| Config | `src/runtime/config.ts` | Defaults + YAML merge + path normalization |
| Runtime composition | `src/runtime/container.ts` | Concrete local services behind narrow contracts |
| Registry | `src/tools/registry.ts` | Tool catalog, active subset, policy + audit pipeline |
| Server | `src/server/mcp-server.ts` | MCP `tools/list` and `tools/call` handlers |
| Transports | `src/server/transports/*` | stdio and Streamable HTTP binding |
| Policy | `src/policy/*` | Path, command, secret policies; risk; approvals |
| Audit/evidence | `src/audit/*`, `src/evidence/*` | Governed event facade, durable hash chain, storage ports, verification |
| Managers | `src/managers/*` | Long-running processes, DB connections |
| Workspace | `src/workspace/*` | Project detection, activation, memory store |
| Adapters | `src/adapters/child-mcp/*` | Proxy child MCP servers (Serena, Playwright) |
| Dashboard | `src/dashboard/*` | Local read/approve control plane UI |

## Design principles

- **stdout is sacred.** On the stdio transport, stdout carries the JSON-RPC
  channel only. All logs go to stderr (`src/core/logger.ts`).
- **One decision point.** Every mutation flows through `PolicyEngine.evaluate`.
  Tools never bypass it.
- **Curated surface.** The registry can expose a routed subset
  (`TASK_PRESETS`) so agents see a focused tool list instead of everything.
- **Fail safe.** Unknown tools, denied paths, and CRITICAL commands return a
  structured error rather than throwing across the protocol boundary.

## Workflow control plane

Persisted workflows are deterministic orchestration over `ToolRegistry.call`; they never invoke handlers directly. This preserves per-step policy, approval, rate limits, audit, adapter risk, and rich results. Checkpoints store bounded/redacted evidence and resume only unfinished steps. See [`workflows.md`](./workflows.md).
