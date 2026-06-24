# Adapters (child MCP servers)

FolderForge can proxy other MCP servers so the agent sees one unified tool
surface. Adapters are configured under `adapters` in the config and managed by
`src/adapters/child-mcp/registry.ts` (spawning) and `client.ts` (the MCP client
that talks to each child over stdio).

## Configuration

```yaml
adapters:
  serena:
    enabled: false
    command: serena
    args: []
  playwright:
    enabled: true
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
  desktopCommander:
    enabled: false
    command: npx
    args: ["-y", "@wonderwhy-er/desktop-commander@latest"]
```

Each adapter (`AdapterDef`) has:

- `enabled` - whether to spawn it on startup;
- `command` / `args` - how to launch the child server;
- `env` - optional extra environment (subject to secret redaction).

## Lifecycle

1. On startup, `ChildMcpRegistry` reads enabled adapters from config.
2. For each, it spawns the child process and connects an MCP client over stdio.
3. The child's tools are namespaced and re-exported through the main registry.
4. Calls are still wrapped by the FolderForge policy + audit pipeline before
   being forwarded to the child.

## Provided integrations

| Adapter | Purpose | Tool prefix |
| --- | --- | --- |
| Serena | Semantic code intelligence (symbols, references) | `code_*` |
| Playwright | Browser automation and inspection | `browser_*` |
| Desktop Commander | Extended local desktop control (optional) | adapter-defined |

## Writing a new adapter

1. Add an `AdapterDef` entry to `AdaptersConfig` in `src/core/types.ts`.
2. Provide a default in `src/core/config.ts`.
3. Register it in `ChildMcpRegistry` so its tools are discovered and proxied.

Because every proxied call passes through `PolicyEngine.evaluate`, child tools
inherit the same risk classification, approval, and audit guarantees as native
tools - decide their risk in `TOOL_RISK` (`src/policy/risk.ts`).
