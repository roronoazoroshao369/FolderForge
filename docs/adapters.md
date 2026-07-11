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
    args: ["-y", "@playwright/mcp@0.0.41", "--isolated"]
  desktopCommander:
    enabled: false
    command: npx
    args: ["-y", "@wonderwhy-er/desktop-commander@latest"]
```

Each adapter (`AdapterDef`) has:

- `enabled` - whether to spawn it on startup;
- `command` / `args` - how to launch the child server;
- `env` - optional extra environment (subject to secret redaction);
- `facade` - optional (default `false`). When `true`, the adapter is exposed
  through a **two-tool facade** (`<adapter>__list_tools` +
  `<adapter>__call_tool`) instead of re-exporting every child tool flatly.
  Intended for large child servers (100+ tools) that would otherwise exceed a
  client's tool cap. Sub-ops stay governed per call, keyed as
  `<adapter>__call_tool:<subtool>`. See [`mcp-facade.md`](./mcp-facade.md).

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

## Facade mode (large child servers)

When a child MCP server exposes so many tools that flat namespacing would blow a
client's tool cap (~50), set `facade: true`. The adapter then advertises exactly
**two** tools instead of N:

- `<adapter>__list_tools({ query?, name_contains?, cursor?, limit? })` - a `LOW`,
  read-only, paginated catalog. Each entry carries the sub-tool `name`,
  `description`, `inputSchema`, resolved `risk`, and `mutates` flag so the agent
  can pick one and read its exact arguments before calling. Pass a free-text
  `query` to rank sub-tools by relevance (BM25 over name + description, name
  weighted higher); ranked responses set `ranked: true` and add a `score` per
  entry, and only matching sub-tools are returned. `name_contains` still does a
  plain substring pre-filter and can be combined with `query`.
- `<adapter>__call_tool({ tool, args })` - dispatches one sub-op. It resolves the
  sub-op's own risk/mutation from the per-adapter risk map
  (`src/adapters/child-mcp/risk-map.ts`, default `MEDIUM`/`mutates:true`) and
  **re-enters the governance pipeline** via `ToolRegistry.callDynamic`, keyed on
  the synthetic identity `<adapter>__call_tool:<subtool>`.

Governance is per sub-op, not per dispatcher: a `CRITICAL` sub-op stays denied in
safe mode and approval-gated elsewhere even when reached through the facade, and
the audit trail records the real sub-tool name. The catalog is cached on first
`list_tools` and refreshable. See [`mcp-facade.md`](./mcp-facade.md) for the full
design, options considered, and future work (`list_changed`).

## Rich results and child errors

FolderForge normalizes standard child MCP content blocks (`text`, `image`, text
`resource`, and `resource_link`) and promotes them into the parent response. The
original child payload remains available as structured data, but promoted
`data.content` is not duplicated in the compatibility text summary. Child
`isError:true` becomes a parent error and a `tool_error` audit event.

The generated Playwright configuration uses `--isolated` so concurrent
FolderForge instances do not contend for one persistent browser profile. Override
its `args` with a dedicated `--user-data-dir` only when persistent state is
intentional.

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
