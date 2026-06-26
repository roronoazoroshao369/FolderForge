# FolderForge

FolderForge turns any local folder into a safe, full-tool MCP workspace for AI agents.

## Installation

FolderForge is a single CLI (`folderforge`) that an AI coding agent launches over
stdio. It needs **Node.js >= 22**. It runs against any project folder you point
it at with `--project`; a config file is optional (without one it allows just
that project directory and applies safe defaults).

### Option 1 - npx (no install, recommended)

The fastest path: let your agent run FolderForge on demand. Nothing to install
globally. Point any MCP client at it:

```jsonc
{
  "mcpServers": {
    "folderforge": {
      "command": "npx",
      "args": ["-y", "folderforge", "--stdio", "--project", "/absolute/path/to/your-project"]
    }
  }
}
```

Try it in a terminal first:

```bash
npx -y folderforge --project . --stdio
```

### Option 2 - global install from npm

Install once, then call `folderforge` from anywhere:

```bash
npm install -g folderforge
folderforge --version

# run against any folder
cd /path/to/your-project
folderforge --stdio --project .
```

Agent config when installed globally:

```jsonc
{
  "mcpServers": {
    "folderforge": {
      "command": "folderforge",
      "args": ["--stdio", "--project", "/absolute/path/to/your-project"]
    }
  }
}
```

### Option 3 - from source (Git, for contributors)

Clone and build when you want to hack on FolderForge or run an unreleased
version:

```bash
git clone https://github.com/your-org/folderforge.git
cd folderforge
npm install
npm run build        # emits dist/

# optional: expose the `folderforge` command system-wide
npm link

# or run directly without linking
node dist/main.js --stdio --project /path/to/your-project
```

During development you can skip the build step and run the TypeScript source
directly:

```bash
npm run dev -- --stdio --project /path/to/your-project
```

You can also install straight from a Git remote without a published npm release:

```bash
npm install -g github:your-org/folderforge
```

### Pointing at a different folder

The folder FolderForge serves is independent of where it is installed. Set the
working project with `--project` (and, if you use a config file, make sure its
`workspace.allowedDirectories` includes that folder). To work across several
projects at once, list them all in `allowedDirectories`.

### Limiting the tool surface (tool list caps)

Some MCP clients cap how many tools they will load (around 50). FolderForge
exposes a large native catalog, so you can trim the advertised list at startup
to a focused set. The filter is applied before the first `tools/list`, so the
client never sees the tools you excluded. The `workspace` group is always kept.

Fastest path - the `vibe` preset (file, search, terminal, process, git, code,
build):

```jsonc
{
  "mcpServers": {
    "folderforge": {
      "command": "npx",
      "args": ["-y", "folderforge", "--stdio", "--project", "/path/to/project", "--tools-preset", "vibe"]
    }
  }
}
```

Other ways to control it (CLI flags override the config file):

```bash
# Pick whole groups
folderforge --stdio --project . --tools-groups file,search,terminal,git,code,build

# Start from a preset, then fine-tune
folderforge --stdio --project . --tools-preset vibe --tools-disable search_ast --tools-enable run_test
```

Available presets: `vibe` (coding-focused), `readonly` (explore only), `full`
(everything). Groups: `file`, `search`, `terminal`, `process`, `git`, `build`,
`code`, `pkg`, `format`, `coverage`, `memory`, `security`, `browser`, `db`.

Or set it in `folderforge.yaml` so you don't repeat flags:

```yaml
tools:
  preset: vibe
  # enabledGroups: [file, search, git, code, terminal]
  # enabled: [run_test]
  # disabled: [search_ast]
```

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
`git_reset`, `git_push`, and `git_pull` confirm interactively before acting when
the client supports elicitation, and `git_push` / `git_fetch` / `git_pull` /
`process_tail` emit progress.

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
