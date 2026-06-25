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
2. Adapters start **lazily** - the child process is spawned on first use (or first
   tool discovery), not eagerly, to avoid paying their cost when unused.
3. The child's tools are discovered via `tools/list`, **namespaced** with the
   adapter name and a `__` separator (e.g. `serena__find_symbol`), and
   re-exported through the main registry.
4. Calls are still wrapped by the FolderForge policy + audit pipeline before
   being forwarded to the child.
5. On shutdown, `stopAll()` terminates every spawned child.

## Tool namespacing

Every proxied tool is exposed as `<adapter>__<childToolName>`:

| Adapter | Example namespaced tools |
| --- | --- |
| `serena` | `serena__find_symbol`, `serena__find_referencing_symbols` |
| `playwright` | `playwright__browser_navigate`, `playwright__browser_snapshot` |
| `desktopCommander` | `desktopCommander__<tool>` |

The separator is the `NS_SEP` constant in `src/tools/adapter-tools.ts`. Proxied
tools default to `MEDIUM` risk and `mutates: true`, so policy mode and the
approval list still gate them.

## Provided integrations

| Adapter | Purpose | Tool prefix |
| --- | --- | --- |
| Serena | Semantic code intelligence (symbols, references) | `serena__*` |
| Playwright | Browser automation and inspection | `playwright__*` |
| Desktop Commander | Extended local desktop control (optional) | `desktopCommander__*` |

## Writing a new adapter

1. Add an `AdapterDef` entry to `AdaptersConfig` in `src/core/types.ts`.
2. Provide a default in `src/core/config.ts`.
3. Add its name to `ADAPTER_NAMES` in `src/tools/adapter-tools.ts` and to
   `AdapterName` in `src/adapters/child-mcp/registry.ts` so its tools are
   discovered, namespaced, and proxied.

Because every proxied call passes through `PolicyEngine.evaluate`, child tools
inherit the same risk classification, approval, and audit guarantees as native
tools - decide their risk in `TOOL_RISK` (`src/policy/risk.ts`).
