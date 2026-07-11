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
      "args": ["-y", "@musashishao/folderforge", "--stdio", "--project", "/absolute/path/to/your-project"]
    }
  }
}
```

Try it in a terminal first:

```bash
npx -y @musashishao/folderforge --project . --stdio
```

### Option 2 - global install from npm

Install once, then call `folderforge` from anywhere:

```bash
npm install -g @musashishao/folderforge
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
git clone https://github.com/roronoazoroshao369/FolderForge.git
cd FolderForge
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
npm install -g github:roronoazoroshao369/FolderForge
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
client never sees the tools you excluded. Most presets retain the `workspace`
group; `vibe-lite` is intentionally folder-scoped and is the exception.

Fastest path - the `vibe` preset (workspace, workflow, agent, file, search,
terminal, process, git, code, build):

```jsonc
{
  "mcpServers": {
    "folderforge": {
      "command": "npx",
      "args": ["-y", "@musashishao/folderforge", "--stdio", "--project", "/path/to/project", "--tools-preset", "vibe"]
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

Available presets: `vibe` (71-tool coding/workflow surface in the audited tree),
`vibe-lite` (folder-scoped coding plus all browser wrappers, hard-capped at 50),
`readonly` (42-tool exploration-oriented surface), and `full` (269 native tools
before dynamic child/plugin tools). Groups include `workspace`, `workflow`,
`agent`, `file`, `search`, `terminal`, `process`, `git`, `build`, `code`, `pkg`,
`format`, `coverage`, `memory`, `security`, `browser`, `db`, `plugin`, and `game`.

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

## Status (`2.0.0-rc.1` candidate)

The **`2.0.0-rc.1`** candidate is committed and pushed on `main`. It has not
been tagged, published to npm, or released. The audited native registry contains 269
tools; the `vibe`, `vibe-lite`, `readonly`, and `full` presets advertise 71, 50,
42, and 269 native tools respectively before dynamic child/plugin additions.

- **Core and governance** - multi-project activation, path/command/secret policy,
  exact once/session approvals, rate limits, append-only audit, and governed
  workflows.
- **MCP** - stdio and authenticated Streamable HTTP, structured error evidence,
  progress, cancellation, elicitation, image/resource/resource-link delivery,
  child facades, and dynamic plugin adapters.
- **AI/browser runtime** - bounded code context, transactional edits,
  verification/report tools, and stable responsive browser wrappers.
- **Release gates** - typecheck, lint, 365 unit/integration tests, build, both
  dependency audits, `npm pack`, temporary tarball install, CLI/stdio smoke, and
  live authenticated HTTP MCP initialize/list/call smoke.
- **Trust boundary** - local plugin packages receive a tamper-detection SHA-256
  tree digest and environment allowlisting, but permission declarations remain
  review/audit metadata rather than an OS sandbox. The digest is not publisher
  identity or signed provenance; untrusted distribution remains disabled.

See `docs/roadmap.md`, `docs/releasing.md`, `docs/compatibility.md`, and
`docs/migration-2.0.md` for the release record, gates, compatibility contract,
and migration notes.

### MCP protocol features (1.2)

Beyond `tools/list` / `tools/call`, FolderForge supports progress
notifications (P4), cancellation (P6), and elicitation (P8), wired through a
per-call control object that leaves the frozen tool schema untouched.

#### Interactive approval via elicitation (new in 1.3.3)

When a tool is gated by the approval queue (e.g. `git_commit`, `git_push`,
`file_delete`) and the MCP client advertises the `elicitation` capability,
FolderForge **asks Approve / Deny directly in the chat** instead of redirecting
to the dashboard:

```
scope options: "once" (this call only) | "session" (remember for the session)
```

If the client does not support elicitation, or if the elicitation call fails,
FolderForge falls back gracefully to the existing dashboard flow
(`http://localhost:7332 → Approvals`) and returns the `approvalId` so the user
can resolve it there.

#### Embedded resources

Tool results can now carry MCP content blocks beyond plain text. `git_diff`
attaches the diff as an embedded `text/x-diff` resource, and child MCP image
blocks are promoted so `browser_screenshot` can render directly in
vision-capable clients. Other tools may attach `resource_link` blocks pointing
to local file URIs or dashboard URLs. Promoted image base64 is not duplicated in
the compatibility text summary.

`git_reset`, `git_push`, and `git_pull` confirm interactively before acting
when the client supports elicitation, and `git_push` / `git_fetch` / `git_pull`
/ `process_tail` emit progress notifications.

## Run

The default transport is **stdio** (for agents). You can also serve over
**HTTP** on a port.

### From source (dev)

```bash
npm install
npm run dev -- --stdio
```

or over HTTP:

```bash
npm run dev -- --http --port 7331 --host 127.0.0.1
```

### Via npx (no install)

stdio:

```bash
npx -y @musashishao/folderforge --project . --stdio
```

HTTP with an API key and a trimmed tool surface - this is a complete,
copy-pasteable example:

```bash
npx -y @musashishao/folderforge --project . --http --port 17331 \
  --api-key "key" --tools-preset vibe-lite
```

What that command does:

- serves MCP over HTTP on `http://127.0.0.1:17331/mcp` (default host is loopback);
- sets one API key (`key`), which **turns auth on** - every request must send it,
  even on localhost;
- limits the advertised tools to the `vibe-lite` preset (capped at 50).

Call it from a client:

```bash
curl -sS -X POST http://127.0.0.1:17331/mcp \
  -H "X-API-Key: key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### CLI commands

| Command | Description |
| --- | --- |
| `folderforge doctor [--json]` | Run read-only installation, configuration, dependency, port, plugin, and state diagnostics |
| `folderforge setup browser [--with-deps]` | Explicitly install package-compatible Playwright Chromium; may access the network |
| `folderforge setup browser --dry-run --json` | Resolve the exact package-local setup command without downloading anything |

### All CLI options

| Flag | Description |
| --- | --- |
| `-p, --project <dir>` | Project root to activate (default: cwd) |
| `-c, --config <file>` | Path to a YAML config file |
| `--http` | Serve MCP over Streamable HTTP |
| `--port <n>` | HTTP MCP port (default 7331) |
| `--host <addr>` | Bind address (default 127.0.0.1) |
| `--token <secret>` | Primary credential for the HTTP endpoint |
| `--api-key <csv>` | Extra API keys (repeatable / comma-separated) |
| `--require-auth` | Enforce auth even on a loopback bind |
| `--dashboard-port <n>` | Dashboard port (default 7332) |
| `--no-dashboard` | Disable the local dashboard |
| `--tools-preset <id>` | `vibe` \| `vibe-lite` \| `readonly` \| `full` |
| `--tools-groups <csv>` | Limit advertised tools to these groups |
| `--tools-enable <csv>` | Always-keep tool names |
| `--tools-disable <csv>` | Drop these tool names |
| `--policy <mode>` | Policy mode at startup: `readonly` \| `safe` \| `dev` \| `danger` (CLI wins over config) |
| `-v, --version` | Print version and exit |
| `-h, --help` | Show help |

## Zero-config first run (new in 1.4.0)

You no longer have to hand-write a config to get the full feature set. On the
first run in a project, if no config file exists yet, FolderForge writes a
complete `folderforge.yaml` next to your project and loads it immediately. So
this is enough:

```bash
npm install -g @musashishao/folderforge
folderforge --project . --http --port 3112 --tools-preset vibe-lite --no-dashboard
```

The generated `folderforge.yaml` is **batteries-included**:

- `policy.defaultMode: dev`
- `tools.preset: vibe-lite` (folder-scoped coding set + the full `browser` group)
- **`adapters.playwright.enabled: true`** - so the `browser_*` tools (navigate,
  viewport resize, click, type, snapshot, console, network, screenshot, eval)
  actually run for FE / UI-UX testing instead of returning *"Playwright adapter
  is disabled"*. Generated adapter args include `--isolated` so concurrent
  FolderForge instances do not lock the same browser profile.

Rules:

- It is only written when **no** config is found in any discovery location
  (`folderforge.yaml`, `.folderforge.yaml`, `.folderforge/config.yaml`, or
  `$FOLDERFORGE_CONFIG`). An existing file is **never** overwritten.
- Passing `--config <file>` skips auto-generation entirely.
- A failed write is non-fatal: FolderForge logs a warning and falls back to the
  built-in defaults.
- CLI flags still override the file (e.g. `--port 3112` wins over the file's port).

Playwright is installed as a package dependency, but FolderForge does **not**
download a browser during `npm install`, global install, or `npx` startup. Browser
installation is an explicit, network-capable setup step:

```bash
folderforge setup browser

# Linux hosts that also need Playwright's operating-system packages
folderforge setup browser --with-deps
```

The setup command resolves the Playwright CLI shipped with the installed
FolderForge dependency graph; it does not invoke a mutable `npx` package. Run
`folderforge doctor` to check whether Chromium is available. Non-browser tools
continue to work when Chromium is intentionally absent.


## Authentication

FolderForge speaks MCP over two transports, and they authenticate differently:

- **stdio** (the default for agents): the agent spawns FolderForge as a child
  process and talks over stdin/stdout. There is no network surface, so there is
  **no auth** - the OS process boundary is the trust boundary.
- **HTTP** (Streamable HTTP on a port): this is a network surface, so it
  supports credential-based auth. **When a credential is configured, every
  request to the MCP endpoint must present a matching credential or it is
  rejected with `401`.**

### When is auth enforced?

Auth on the HTTP transport turns on automatically in any of these cases:

| Situation | Auth required? |
| --- | --- |
| `server.http.token` or `server.http.apiKeys` is set | **Yes** - clients must match |
| Bound to a non-loopback host (e.g. `0.0.0.0`, a LAN IP) | **Yes** - a credential is mandatory; one is auto-generated and logged once if you didn't set it |
| `server.http.requireAuth: true` (or `--require-auth`) | **Yes** - even on `localhost` |
| Bound to loopback (`127.0.0.1`/`localhost`) with no credential | No - same-machine only |

If auth is required but no credential can be resolved, startup fails with a
clear error instead of silently running open.

### Accepted credential formats

A client may authenticate with **either** header:

```http
Authorization: Bearer <token-or-api-key>
```

or

```http
X-API-Key: <token-or-api-key>
```

Both the primary `token` and every entry in `apiKeys` are accepted on either
header. All comparisons are **constant-time**. A missing or wrong credential
returns `401` with a `WWW-Authenticate: Bearer` header.

### Configure auth

Via CLI flags (no config file needed):

```bash
# Single shared token, localhost only but auth forced on
folderforge --http --host 127.0.0.1 --port 7331 \
  --token "$(openssl rand -base64 32)" --require-auth

# Expose on the network with several per-client API keys
folderforge --http --host 0.0.0.0 --port 7331 \
  --token "primary-admin-token" \
  --api-key "client-a-key,client-b-key"
```

Or in `folderforge.yaml`:

```yaml
server:
  transport: http
  http:
    host: 0.0.0.0
    port: 7331
    token: "primary-admin-token"     # accepted via Bearer or X-API-Key
    apiKeys:                          # additional per-client credentials
      - "client-a-key"
      - "client-b-key"
    requireAuth: true                # enforce even on loopback
    corsOrigins:
      - https://your-tool.example.com
```

CLI flags override the config file.

### Call the authenticated endpoint

```bash
# Bearer header
curl -sS -X POST http://127.0.0.1:7331/mcp \
  -H "Authorization: Bearer primary-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# X-API-Key header
curl -sS -X POST http://127.0.0.1:7331/mcp \
  -H "X-API-Key: client-a-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# No / wrong credential -> 401 unauthorized
curl -i -X POST http://127.0.0.1:7331/mcp -d '{}'
```

MCP client config pointing at the HTTP endpoint with a credential:

```jsonc
{
  "mcpServers": {
    "folderforge": {
      "url": "http://127.0.0.1:7331/mcp",
      "headers": { "Authorization": "Bearer primary-admin-token" }
    }
  }
}
```

The **dashboard** authenticates the same way (Bearer token), and additionally
accepts a `?token=<token>` query parameter. See `docs/security.md` for the full
security model.

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
