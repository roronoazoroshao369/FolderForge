# MCP Plugin Architecture

FolderForge is a local-first MCP control plane. It gives an AI agent one governed
tool surface while allowing capabilities to come from native tools or child MCP
servers.

## Goals

- Let an AI agent explore, edit, run, test, and review a project through MCP.
- Keep policy, approval, rate limiting, and audit enforcement in one parent
  runtime.
- Support small direct integrations and very large child servers without
  exhausting client tool limits.
- Preserve MCP-native content such as images and embedded resources instead of
  flattening every result into JSON text.
- Make plugin failures observable and attributable to the real child operation.

## Runtime model

```text
AI client
   |
   | MCP tools/list + tools/call
   v
FolderForge transport
   v
ToolRegistry -> policy -> approval -> rate limit -> audit
   |
   +-- native tool handler
   |
   +-- native browser wrapper -> Playwright child MCP
   |
   +-- flat child adapter: <adapter>__<tool>
   |
   +-- facade child adapter:
       <adapter>__list_tools
       <adapter>__call_tool
```

All paths return a `ToolResult`. `src/server/mcp-server.ts` converts that internal
result into MCP content blocks.

## Plugin modes

### Native wrapper

Use a native wrapper when FolderForge should provide a stable, curated contract
around a child server. The `browser_*` tools are the reference implementation:
FolderForge owns their names, schemas, risk levels, and compatibility while
routing calls to Playwright.

### Flat child adapter

A child tool is exposed as `<adapter>__<childTool>`. This is suitable for small
servers whose full catalog fits the client. Calls still pass through the parent
policy and audit pipeline.

### Facade child adapter

Large servers can set `facade: true`. FolderForge advertises two tools instead of
hundreds: a searchable catalog and a governed dispatcher. Risk and audit identity
are resolved per sub-tool, not at the generic dispatcher level.

The dispatcher is classified before OAuth, policy, approval, rate limiting, and
audit. The selected sub-tool therefore crosses exactly one governance pipeline.
A LOW read-only sub-tool remains usable in `readonly`; a mutating or HIGH/CRITICAL
sub-tool keeps its own restrictions, approval fingerprint, quota key, and audit
identity.

## Hybrid exposure policy

FolderForge deliberately does not force every integration into one shape:

- Keep core, frequently used capabilities as direct native tools.
- Add stable native wrappers for common integration workflows whose public
  contract FolderForge is prepared to maintain, such as `browser_*`.
- Use flat namespaced tools for small, stable child catalogs that fit comfortably
  in the client's tool budget.
- Use the two-tool facade for large, dynamic, plugin-owned, or long-tail catalogs.

As a maintainer guideline rather than a protocol guarantee, catalogs around
1-20 operations normally stay flat, 21-40 require a deliberate usability/tool-
budget review, and catalogs above roughly 40 or with dynamic membership normally
use a facade. The default client-facing presets remain curated and capped; the
`full` preset is explicit opt-in.

## Result contract

Child MCP results are normalized by `src/adapters/child-mcp/result.ts`.
FolderForge currently promotes these standard content blocks:

- `text`
- `image` (`data` is base64, plus `mimeType`)
- embedded text `resource`
- `resource_link`

The original child result remains available as structured `data`. When content is
promoted, the text compatibility summary omits the nested `data.content` array so
large image base64 is not duplicated on the wire.

A child result with `isError: true` becomes `ToolResult.ok: false`. This ensures
the client receives MCP `isError: true` and the audit trail records `tool_error`
instead of a false success.

## Capability metadata

The current stable contract is carried by each `ToolDefinition`:

- name and description
- JSON input schema
- group
- risk level
- mutation flag
- MCP annotations

The implemented local plugin manifest adds package metadata, declared
permissions, compatibility ranges, lifecycle state, and per-operation risk. It
compiles into the same `ToolDefinition` and child-adapter contracts rather than
creating a second execution or governance path.

## Tool-cap guarantees

`vibe-lite` is capped at 50 advertised tools. Its browser group is pinned during
cap resolution so additions in earlier groups cannot silently evict UI-testing
capabilities. The current preset also removes low-value tools until it naturally
lands at 50.

## Security boundaries

- Child tools never bypass `ToolRegistry` governance.
- Child `isError` status is preserved.
- Browser arbitrary JavaScript remains HIGH risk (`browser_eval`).
- External navigation continues to depend on policy mode and configured child
  restrictions.
- Default generated Playwright configuration uses `--isolated`, preventing
  profile-lock collisions and cross-session browser state leakage. Users who
  intentionally need persistence can override the adapter arguments with a
  dedicated `--user-data-dir`.

## Plugin acceptance checklist

A new plugin integration is complete only when it has:

1. deterministic startup and shutdown;
2. exact JSON schemas for every advertised operation;
3. per-operation risk and mutation classification;
4. rich-content preservation;
5. child error propagation;
6. unit tests and a live MCP smoke test;
7. documented configuration and failure modes;
8. no regression to capped presets.

## Implemented local lifecycle

Milestone 1.9 adds a local package registry and hot lifecycle. Validated prepared packages compile into the existing child-adapter/facade path; they do not create a plugin-specific governance bypass. The runtime supports compatibility checks, bounded/symlink-free copying, env allowlisting, dynamic adapter/risk registration, health checks, and enabled-state restoration. See [`plugin-system.md`](./plugin-system.md).

## Architecture progress and next slices

1. **Done:** content-addressed local artifact storage with integrity, quotas, PNG comparison, and browser evidence.
2. **Done:** optional digest-pinned Docker/Podman isolation with bounded mounts, network, capabilities, processes, CPU, memory, and tmpfs.
3. **Done:** coverage, property/fuzz, heartbeat stress, MCP Inspector, and immutable benchmark-result gates.
4. Add MCP capability-change notifications where supported by clients.
5. Add signed/verified plugin distribution, publisher identity, revocation, and plugin provenance.
6. Open a reviewed beta before any remote marketplace or distributed execution work; see ADR-0005.
