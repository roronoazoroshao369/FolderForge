# Pinned third-party child MCP compatibility

FolderForge maintains a network-backed compatibility matrix in addition to its
deterministic protocol fixtures. The matrix runs real published MCP servers through
FolderForge's production `StdioChildClient`; it is not a mock-server substitution.

## Pinned matrix

The source of truth is
[`compatibility/child-mcp-third-party.json`](../compatibility/child-mcp-third-party.json).
Every entry pins an exact npm version, registry `sha512` integrity value, executable
name, minimum catalog size, and required tools.

| Profile | Exact package | Probe |
| --- | --- | --- |
| MCP Everything | `@modelcontextprotocol/server-everything@2026.7.4` | `echo` |
| MCP Filesystem | `@modelcontextprotocol/server-filesystem@2026.7.4` | `list_allowed_directories` in a temporary root |
| MCP Memory | `@modelcontextprotocol/server-memory@2026.7.4` | `read_graph` against temporary storage |
| MCP Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking@2026.7.4` | One completed, non-persistent thought |
| Microsoft Playwright MCP | `@playwright/mcp@0.0.78` | Initialize and catalog only; no browser action |

The first four products are published from the Model Context Protocol reference
server repository. Playwright MCP is published by Microsoft from its independent
repository. Product and package diversity is recorded explicitly; four profiles
sharing one upstream repository are not represented as four independent
implementations.

## Execution contract

Run the complete matrix with:

```bash
npm run compatibility:child-mcp:third-party
```

To validate the immutable manifest without network access or executing a child:

```bash
node scripts/child-mcp-third-party.mjs --validate-only
```

For a machine-readable report:

```bash
npm run build
node scripts/child-mcp-third-party.mjs \
  --output .folderforge-ci/child-mcp-third-party.json
```

The runner:

1. installs all selected packages into a temporary path containing spaces and
   Unicode;
2. disables package lifecycle scripts with `npm install --ignore-scripts`;
3. verifies the resolved package version and `package-lock.json` integrity against
   the committed manifest;
4. audits the temporary production dependency graph and fails when any known
   vulnerability is reported;
5. invokes each package's pinned JavaScript bin directly through `process.execPath`;
6. gives each child an allowlisted environment and temporary home rather than
   inheriting operator secrets;
7. performs bounded initialize, complete paginated `tools/list`, required-tool
   assertions, selected read-only/idempotent probes, and bounded shutdown; and
8. records source-input hashes, package-lock hash, catalog hashes, protocol
   versions, transport counters, failures, and limitations.

A package download, integrity mismatch, audit finding, missing required tool,
protocol failure, probe failure, or shutdown failure makes the command exit
non-zero. The runner does not convert an unavailable registry or unsupported
server into a skipped pass.

## CI evidence

Node 22 jobs on Ubuntu, macOS, and Windows run the matrix and retain one JSON
artifact per operating system. Compatibility evidence belongs only to the exact
commit and workflow attempt recorded by those artifacts. A configured CI step is
not itself evidence; the artifacts must exist and pass before making a
cross-platform claim.

A local Linux/Node 22 development run on July 21, 2026 passed all five profiles,
advertised 61 tools in total, completed four reviewed probes, shut down cleanly,
and reported zero known vulnerabilities across the temporary production dependency
graph. Because that run occurred on a dirty development tree, the report is local
implementation evidence rather than an exact-commit certification.

## Claim boundary

This matrix proves compatibility only for the exact package bytes and environment
recorded in a report. It covers stdio initialization, tool discovery, selected
safe calls, and process cleanup. It does not certify every tool, remote API,
browser binary, mutation path, transport other than stdio, or future package
version. Independent clean-machine reproduction remains required before describing
the matrix as independently verified.
