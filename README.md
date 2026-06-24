# FolderForge

FolderForge turns any local folder into a safe, full-tool MCP workspace for AI agents.

## What it does

- Activates a local workspace
- Exposes MCP tools over stdio and localhost HTTP
- Enforces path and command policy
- Records audit events
- Supports file, search, shell, git, process, project, and memory workflows

## Status (0.1)

The core is in place and working: workspace manager, policy engine (path,
command, secret + risk model), tool registry, append-only audit log, MCP server
with `tools/list` / `tools/call`, stdio and Streamable HTTP transports, and a
local dashboard. The native tool catalog covers files, search (including
structural `search_ast`), terminal, processes, git, build/quality, code
intelligence, memory, security, policy/audit, approvals, browser, and database -
plus `workspace_route` for task-preset tool routing.

Next up (0.2): wiring the Serena/Playwright child-MCP adapters end-to-end,
persisting approvals across restarts, dashboard auth for non-loopback binds, and
integration tests. See `docs/roadmap.md`.

## Run

```bash
npm install
npm run dev -- --stdio
```

or

```bash
npm run dev -- --port 7331 --host 127.0.0.1
```

## Design goals

- Safe by default
- Local-first
- Auditable
- MCP-native
- Production-minded code structure

## Repository structure

- `src/` - server, policy, workspace, tools, audit, dashboard
- `docs/` - architecture and policy docs
- `examples/` - sample client configs
- `tests/` - unit and integration tests

## License

MIT
