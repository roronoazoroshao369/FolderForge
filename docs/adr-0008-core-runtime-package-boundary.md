# ADR-0008: Core, runtime, and vertical package boundary

- **Status:** Accepted
- **Date:** 2026-07-20
- **Related plan:** FF-P1-04 and FF-P3-08

## Decision

FolderForge separates stable governance contracts from composition and vertical
implementations:

- `src/core`: types, errors, logging, principals, process/shell helpers, version.
- `src/evidence` and `src/policy`: governance and storage contracts.
- `src/runtime`: configuration composition and the local service composition root.
- `src/tools` and `src/server`: MCP tool/runtime implementations that depend on
  narrow interfaces rather than the concrete container.
- `packages/*`: independently buildable vertical packages that cannot import
  private root source files.

`ToolRegistry` depends on `GovernanceRuntime`, `McpTaskManager` depends on
`TaskToolExecutor`, and workspace routing depends on `ToolRoutingRegistry`.
The concrete container no longer appears in those contracts. The architecture
checker rejects runtime cycles, `core` imports of vertical implementations,
registry/container back-imports, task-manager/registry coupling, and package
imports outside their own source tree.

## First extraction

`@folderforge/adapter-godot` contains `GodotCli`, `GodotRuntime`, and its public
configuration contract. It builds, packs, installs, and imports independently.
During the transition the root package consumes its built artifact through the
private `#adapter-godot` import map so the existing 308-tool schema remains
compatible without requiring publication of an unreviewed package.

Publishing the adapter or moving the full Godot tool catalog is a separate
release decision. Removing the 149 Godot tool definitions from the root package
would be a breaking tool-surface change and therefore requires a major-version
migration plan rather than an unannounced refactor.

## Verification

```bash
npm run architecture:check
npm run smoke:adapter-godot
npm run smoke:package
```

The architecture result is currently acyclic and has no boundary violations.
The adapter smoke builds an exact tarball, installs it into a clean temporary
project, imports the public exports, and verifies graceful missing-binary
behavior. The root package smoke proves the transition import map works after an
actual tarball install in a path containing spaces and Unicode.
