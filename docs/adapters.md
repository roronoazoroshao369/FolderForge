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
    command: package:@playwright/mcp
    args: ["--isolated"]
  desktopCommander:
    enabled: false
    command: npx
    args: ["-y", "@wonderwhy-er/desktop-commander@latest"]
```

Each adapter (`AdapterDef`) has:

- `enabled` - whether the adapter is eligible for lazy discovery and startup;
- `command` / `args` - how to launch the child server. The generated Playwright
  value `package:@playwright/mcp` is an internal package-local marker, not a shell
  executable;
- `env` - optional extra environment (subject to secret redaction);
- `facade` - optional (default `false`). When `true`, the adapter is exposed
  through a **two-tool facade** (`<adapter>__list_tools` +
  `<adapter>__call_tool`) instead of re-exporting every child tool flatly.
  Intended for large child servers (100+ tools) that would otherwise exceed a
  client's tool cap. Sub-ops stay governed per call, keyed as
  `<adapter>__call_tool:<subtool>`. See [`mcp-facade.md`](./mcp-facade.md).

## Lifecycle

1. On startup, `ChildMcpRegistry` reads adapter definitions without eagerly
   spawning their processes.
2. Adapters start **lazily** on first discovery or call. Concurrent callers share
   one single-flight start promise, so one adapter definition cannot create a
   duplicate-process startup storm.
3. FolderForge initializes with the latest protocol version supported by its
   installed official MCP SDK, accepts only SDK-supported fallback versions, then
   follows every cursor page returned by `tools/list`. Discovery fails closed on
   malformed cursors, cursor cycles, more than 1,000 pages, or more than 10,000
   tools. Discovered tools are **namespaced** with the adapter name and a `__`
   separator (e.g. `serena__find_symbol`) and re-exported through the main registry.
4. Every call remains inside the FolderForge policy + audit pipeline. FolderForge
   never automatically replays a failed `tools/call`, because the child may have
   completed a side effect before its connection failed.
5. Transient startup/runtime failures use bounded exponential backoff and a
   circuit breaker. After the cooldown, one half-open caller probes recovery.
   Configuration, protocol-compatibility, and resource-bound failures become
   `blocked` until the adapter definition is replaced or reloaded; they are not
   respawned in a tight loop.
6. Shutdown uses `stopAllAndWait()`: request cleanup, `SIGTERM`/platform process-
   tree termination, a bounded wait, then a force-kill fallback for a child that
   does not exit.

The built-in Playwright launch resolves the declared package bin from
FolderForge's own dependency tree and starts it with `process.execPath`. The exact
legacy generated `npx -y @playwright/mcp@0.0.41 --isolated` definition is migrated
package-locally at runtime; genuinely custom commands and versions are preserved.

Startup is degraded rather than fatal when an optional child fails, but the
failure is retained as structured status. FolderForge records `resolve`, `spawn`,
`initialize`, `tools/list`, `runtime`, or `shutdown`, keeps bounded redacted
stderr, and reports remediation. Status and health include lifecycle state, PID,
start/restart/failure counters, next retry time, failure disposition, current and
total uptime, observed availability, mean recovery time, failure histograms, and
JSON-RPC transport counters. When Playwright is disabled or unavailable,
FolderForge removes native `browser_*` wrappers from the advertised registry so
clients are not shown an unusable capability.

## Protocol and process bounds

The stdio client applies portable bounds before child output can grow without
limit:

- each inbound or outbound JSON-RPC message is limited to 1 MiB;
- unterminated stdout buffering is limited to 2 MiB;
- at most 256 JSON-RPC requests may be pending per child;
- an idle ready child is pinged every 60 seconds, with a 10-second heartbeat
  timeout; and
- stderr is retained only as a bounded, redacted tail.

An oversized outbound call is rejected without killing an otherwise healthy
connection. Invalid child protocol output, stdout flooding, or heartbeat failure
closes the connection and enters the registry recovery policy. FolderForge also
terminates the child process tree during shutdown. These controls are transport
and lifecycle safeguards, not an operating-system CPU/RSS sandbox: deployments
that require hard memory or CPU quotas must provide them through containers,
cgroups, job objects, or another host-level isolation mechanism.

`folderforge doctor` performs a bounded `initialize` plus complete `tools/list`
probe for every enabled child adapter. Successful evidence includes negotiated
protocol, elapsed time, tool count, package source, and transport counters;
failures include the classified disposition and remediation.

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
`list_tools`; when a child advertises `capabilities.tools.listChanged`, its
`notifications/tools/list_changed` invalidates that cache and the next access
re-discovers every bounded cursor page. FolderForge does not trust unadvertised
list-change notifications. See [`mcp-facade.md`](./mcp-facade.md) for the facade
design and the separate future option of notifying parent MCP clients when the
FolderForge-visible surface itself changes.

## Rich results and child errors

FolderForge normalizes standard child MCP content blocks (`text`, `image`, text
`resource`, and `resource_link`) and promotes them into the parent response. The
original child payload remains available as structured data, but promoted
`data.content` is not duplicated in the compatibility text summary. Child
`isError:true` becomes a parent error and a `tool_error` audit event.

The generated Playwright configuration uses `--isolated` so concurrent
FolderForge instances do not contend for one persistent browser profile. Override
its `args` with a dedicated `--user-data-dir` only when persistent state is
intentional. `folderforge doctor` performs a real bounded `initialize` and
`tools/list` probe; see [`playwright-macos.md`](./playwright-macos.md).

## Provided integrations

| Adapter | Purpose | Tool prefix |
| --- | --- | --- |
| Serena | Semantic code intelligence (symbols, references) | `serena__*` |
| Playwright | Browser automation and inspection | `playwright__*` |
| Desktop Commander | Extended local desktop control (optional) | `desktopCommander__*` |

## Writing a new adapter

1. Add an `AdapterDef` entry to `AdaptersConfig` in `src/core/types.ts` when the
   adapter is built in, and provide a default in `src/core/config.ts`. Installed
   plugins can register dynamic string names without modifying a central enum.
2. Define per-sub-tool risk overrides in
   `src/adapters/child-mcp/risk-map.ts` when the conservative default
   `MEDIUM`/`mutates:true` is not accurate.
3. Add protocol, lifecycle, failure, and governance tests. Include at least one
   failed child startup and prove that mutating calls are not automatically
   replayed after recovery.

Every proxied call passes through the same policy, approval, rate-limit, and audit
pipeline as native tools. The child process is still local executable code, so
review its provenance and permissions independently of MCP-level governance.
