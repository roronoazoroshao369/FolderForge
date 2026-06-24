# Architecture

FolderForge (VibeMCP) is an MCP-native control plane that sits between an AI
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
        |  allow | deny | approval
        v
  Tool handler (file/git/shell/...)        src/tools/*-tools.ts
        |
        v
  Container services                        src/core/container.ts
   (workspace, processes, db, adapters, audit)
```

A second, independent HTTP server serves the local dashboard
(`src/dashboard/server.ts`), which reads the same `Container` to render status,
audit, processes, and approvals.

## Modules

| Area | Path | Responsibility |
| --- | --- | --- |
| Entrypoint | `src/main.ts` | Parse args, `loadConfig`, build `Container` + registry, start server + dashboard |
| Config | `src/core/config.ts` | Defaults + YAML merge + path normalization |
| Container | `src/core/container.ts` | Dependency container shared by all handlers |
| Registry | `src/tools/registry.ts` | Tool catalog, active subset, policy + audit pipeline |
| Server | `src/server/mcp-server.ts` | MCP `tools/list` and `tools/call` handlers |
| Transports | `src/server/transports/*` | stdio and Streamable HTTP binding |
| Policy | `src/policy/*` | Path, command, secret policies; risk; approvals |
| Audit | `src/audit/*` | Append-only JSONL log + ring buffer |
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
