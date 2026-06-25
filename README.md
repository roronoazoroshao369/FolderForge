# FolderForge

FolderForge turns any local folder into a safe, full-tool MCP workspace for AI agents.

## What it does

- Activates a local workspace (single or multiple projects at once)
- Exposes MCP tools over stdio and localhost HTTP
- Enforces path, command, and secret policy with a four-level risk model
- Gates sensitive actions behind an approval queue (persisted across restarts)
- Records every call to an append-only audit log
- Supports file, search, shell, process, git, build, code-intelligence,
  memory, browser, and database workflows

## Status (1.0)

FolderForge is at **1.0**. The full stack is in place and frozen for release:

- **Core** - config loader (with aggregated validation errors), dependency
  container, multi-project workspace activation.
- **Policy** - path, command, and secret policies + risk model; approval queue
  (once/session scopes) persisted under `.folderforge/approvals.jsonl`;
  per-tool rate limits and daily quotas; pluggable secret scanning with
  Shannon-entropy detection.
- **Tools** - full native catalog (files, search incl. structural `search_ast`,
  terminal, processes, git, build/quality, code intelligence, memory, security,
  policy/audit, approvals, browser, database) plus `workspace_route` for
  task-preset tool routing. The public tool surface is **frozen** in
  `src/tools/schema-lock.ts` and guarded by tests.
- **Adapters** - Serena, Playwright, and Desktop Commander child-MCP servers,
  proxied with namespacing (`serena__<tool>`).
- **Server** - MCP `tools/list` / `tools/call` over stdio and a hardened
  Streamable HTTP transport (constant-time bearer auth, CORS allowlist,
  idle-session expiry).
- **Observability** - append-only JSONL audit log + ring buffer, `policy_explain`
  dry-run tooling, and a local dashboard (`/status`, `/audit`, `/processes`,
  `/approvals`).

See `docs/roadmap.md` for the detailed milestone history and post-1.0 ideas.

### MCP protocol features (1.2)

Beyond `tools/list` / `tools/call`, FolderForge supports progress
notifications (P4), cancellation (P6), and elicitation (P8), wired through a
per-call control object that leaves the frozen tool schema untouched.
`git_reset` and `git_push` confirm interactively before acting when the client
supports elicitation, and `git_push` / `process_tail` emit progress.

## Run

```bash
npm install
npm run dev -- --stdio
```

or

```bash
npm run dev -- --port 7331 --host 127.0.0.1
```

## Develop

```bash
npm test          # unit + integration (vitest)
npm run typecheck # tsc --noEmit
npm run build     # emit to dist/
```

## Design goals

- Safe by default
- Local-first
- Auditable
- MCP-native
- Production-minded code structure

## Repository structure

- `src/` - server, policy, workspace, tools, audit, dashboard
- `docs/` - architecture, tools, adapters, security, and roadmap docs
- `examples/` - sample client configs
- `tests/` - unit and integration tests (incl. the schema-lock guard)

## License

Apache-2.0
