# Roadmap

Status of FolderForge (VibeMCP) toward a stable 1.0.

## Done (0.1)

- Core config loader with YAML merge and path normalization.
- Dependency container and workspace activation.
- Policy engine: path, command, and secret policies + risk model.
- Approval queue (once/session scopes).
- Append-only JSONL audit log + ring buffer.
- Full native tool catalog (files, search, terminal, processes, git, build,
  code, memory, security, db).
- Native structural code search (`search_ast`) - regex-backed declaration finder,
  no language server required.
- Task-preset routing exposed as a tool (`workspace_route`): switch the visible
  tool set to `explore` / `run_ui` / `fix_tests`, or reset to all.
- MCP server with `tools/list` / `tools/call` handlers.
- stdio and Streamable HTTP transports.
- Local dashboard (`/status`, `/audit`, `/processes`, `/approvals`).
- New `main.ts` entrypoint with arg parsing.

## Next (0.2)

- Child-MCP adapters wired end-to-end (Serena, Playwright) with tool namespacing.
- Persisted approvals across restarts.
- Dashboard auth token for non-loopback binds.
- Integration tests against the sample fixtures.

## Later (0.3+)

- Streaming tool results for long-running commands.
- Per-tool rate limits and quotas.
- Policy "explain" tool: dry-run a call and return the decision + reasoning.
- Multi-project sessions (activate more than one workspace).
- Pluggable secret scanners (entropy-based detection).

## 1.0 criteria

- Stable tool schema (no breaking renames).
- Documented config surface with validation errors.
- Full unit + integration coverage for the policy pipeline.
- Hardened HTTP transport (auth, CORS, session expiry).
