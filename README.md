# FolderForge

> Turn a local project folder into a governed MCP workspace for AI coding agents.

[![CI](https://github.com/roronoazoroshao369/FolderForge/actions/workflows/ci.yml/badge.svg)](https://github.com/roronoazoroshao369/FolderForge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@musashishao/folderforge)](https://www.npmjs.com/package/@musashishao/folderforge)
[![Node](https://img.shields.io/node/v/@musashishao/folderforge)](package.json)
[![License](https://img.shields.io/npm/l/@musashishao/folderforge)](LICENSE)

FolderForge is a local-first MCP server and CLI. Point it at a project and an MCP
client can inspect files, search code, run governed commands, use Git and build
tools, and optionally connect browser, database, plugin, workflow, and Godot
capabilities. Path restrictions, risk policy, approvals, secret redaction, rate
limits, and audit logging remain enforced on the server side.

## Quick start

**Requirements:** Node.js 22 or 24 and an MCP client that supports stdio.

Check the published CLI:

```bash
npx -y @musashishao/folderforge --version
npx -y @musashishao/folderforge --help
```

Initialize an explicit safe profile, inspect it, and generate client config:

```bash
npx -y @musashishao/folderforge init --project . --profile develop
npx -y @musashishao/folderforge doctor --project .
npx -y @musashishao/folderforge connect cursor --project . --write
```

Profiles are explicit: `observe` is read-only, `develop` uses bounded mutations
and exact approvals, and `trusted-automation` requires the operator to accept a
broader local automation boundary. Ordinary server startup never creates or
overwrites configuration.

Your MCP client then starts FolderForge over stdio. To run the server manually:

```bash
npx -y @musashishao/folderforge --project . --stdio
```

## Share a temporary trial (one command)

`folderforge share` stands up a temporary single-project environment for the
current folder and prints ready-to-paste connection values — without touching
long-lived configuration:

```bash
cd /path/to/your/repo
folderforge share                          # auto tunnel (cloudflare when available)
folderforge share --tunnel none            # loopback only
folderforge share --tunnel openai          # OpenAI Secure MCP Tunnel (ChatGPT)
folderforge share --auth token             # default; oauth reuses project OAuth config
folderforge share --ttl 30                 # auto-teardown after 30 minutes (default 120; 0 disables)
folderforge share --json                   # machine-readable share.ready/ended/error lines
```

The command prints the MCP URL, a temporary bearer credential (in-memory only —
never written to disk, argv, or logs), and the tunnel id when `--tunnel openai`
is used (it delegates to the proven OpenAI supervisor, reusing the tunnel id and
key from `.folderforge/openai-tunnel-config.json` (0600) or
`CONTROL_PLANE_API_KEY`, with clear guidance when neither exists). Ctrl+C tears
everything down: the tunnel closes, the server stops, and the temporary
credential dies with the process.

## Mission Control (web UI)

FolderForge ships a built-in web control plane so the whole machine can be run
from one dashboard instead of a terminal:

```bash
folderforge control start            # serves http://127.0.0.1:7332/app
folderforge control start --allow /home/you --allow /tmp
folderforge control status           # health + URL
folderforge control open             # start (if needed) and open the browser
folderforge control stop

# Optional dashboard auth (loopback no-auth stays the default). token/api-key
# mint a credential stored 0600 in .folderforge/control-auth.json (never in
# argv or control.json) and print a signed dynamic link (…/app?token=…):
folderforge control start --auth token        # or: api-key
folderforge control auth                      # show current mode (masked)
folderforge control auth api-key              # change later; restarts the plane
folderforge control auth none                 # back to open loopback

# ChatGPT without Cloudflare: supervise the OpenAI Secure MCP Tunnel alongside
# the plane — only the tunnel id and the API-key env-var NAME are persisted:
export CONTROL_PLANE_API_KEY='sk-...'
folderforge control start --openai-tunnel --tunnel-id tunnel_<32 hex>
```

The same ChatGPT tunnel can be configured from the app itself: **Tunnels →
ChatGPT tunnel (OpenAI)** saves the tunnel id + API-key env-var name (0600).
You can also paste the key itself (stored 0600 like the Cloudflare token,
shown only as a last-4 preview) instead of exporting the env var, and the
**Verify key** button probes the OpenAI API before anything is saved — an
in-app alternative to linking Cloudflare.

Opening `http://127.0.0.1:7332/` redirects to the Mission Control SPA at
`/app/`. The plane is loopback-only; for remote access set a token in
**Settings** or start a one-off public tunnel from the **Tunnels** screen.

**Fleet — one governed MCP per folder, as many as you need:**

1. **Fleet → Browse** to pick any folder inside the allowed roots (or create a
   new one with **New folder**).
2. Choose a **tool preset** (`vibe`, `vibe-lite`, `readonly`, `full`, `godot`),
   a **policy mode** (`readonly`, `safe`, `dev`, `danger`), and an
   **authentication mode**: bearer token, API key, OAuth, or loopback-only no
   auth. Generated static credentials are shown exactly once.
3. **Start local** to serve `http://127.0.0.1:<port>/mcp`. Token/API-key modes
   require the issued credential, OAuth uses protected-resource discovery, and
   no-auth stays loopback-only.
4. Per instance you can **Configure** preset/policy, change **Auth**, rotate
   static credentials, toggle **auto-restart**, expose an authenticated instance
   with Cloudflare, or start the existing **OpenAI Secure MCP Tunnel** supervisor.
   The OpenAI control-plane API key is referenced by environment-variable name
   or pasted directly in the tunnel dialog (stored in the 0600 fleet state,
   injected into the supervisor's environment, never returned by the API), and
   a **Verify key** button probes the OpenAI API before starting.

The folder picker is restricted to the workspace plus every `--allow <dir>`
passed at `control start` (repeatable, persisted in `.folderforge/control.json`
and forwarded to the serving process). The same capabilities exist as MCP tools
(`provision_folder`, `provision_update`, `provision_rotate_token`, …) and as
governed dashboard routes (`POST /fleet/:id/policy`, `POST /fleet/:id/rotate-token`,
`POST /fleet/:id/tunnel`, `POST /fs/browse`, `POST /fs/mkdir`), all
policy-enforced and audit-logged.

**Reconnect recovery (lease fencing + orphan reaping):** every fleet/tunnel
start mints a fresh lease id, plane shutdown (SIGTERM/SIGINT or `control stop`)
stops the whole managed process tree (fleet instances, OpenAI tunnel
supervisors, tunnels, and spawned sessions), and a restarted plane reconciles
persisted pids against reality: verified orphans from a previous run are
reaped automatically on the next start, while a port held by a foreign
process yields an actionable error instead of a bare EADDRINUSE.

See [docs/adr-0012-mission-control-control-plane.md](docs/adr-0012-mission-control-control-plane.md)
for the design and [docs/agent-council.md](docs/agent-council.md) for the review
process.

### ChatGPT through OpenAI Secure MCP Tunnel

For a private workstation or local project, provision an OpenAI tunnel and runtime API key once, then run:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel \
  --oauth \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --project /absolute/path/to/project
```

With `--oauth`, FolderForge reuses its Auth0/DCR lifecycle, starts a loopback-only OAuth resource server behind a separate per-run tunnel guard, verifies local discovery and the OAuth challenge, and supervises both processes until `Ctrl+C`. Omit `--oauth` to retain legacy static-token mode. After the first successful OAuth run, the same project normally needs only:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel
```

The API-key value is never persisted or placed in process argv. See [OpenAI Secure MCP Tunnel](docs/openai-secure-mcp-tunnel.md).

### Claude Desktop or a generic MCP client

Replace the project path with an absolute path:

```json
{
  "mcpServers": {
    "folderforge": {
      "command": "npx",
      "args": [
        "-y",
        "@musashishao/folderforge",
        "--project",
        "/absolute/path/to/project",
        "--stdio"
      ]
    }
  }
}
```

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.folderforge]
command = "npx"
args = [
  "-y",
  "@musashishao/folderforge",
  "--project",
  "/absolute/path/to/project",
  "--stdio",
]
```

### Cursor

Create an MCP server using command `npx` and these arguments:

```text
-y
@musashishao/folderforge
--project
/absolute/path/to/project
--stdio
```

Use an absolute project path because desktop clients may start servers from an
unexpected working directory.

## Install globally

```bash
npm install -g @musashishao/folderforge
folderforge --version
folderforge doctor
folderforge --project /absolute/path/to/project --stdio
```

A global install is convenient when several MCP clients share the same Node
installation. `npx` is the simpler default because it does not require a global
binary.

## Browser tools

Browser downloads are deliberately excluded from package installation. Set up
the package-compatible Chromium runtime explicitly:

```bash
folderforge setup browser --dry-run --json
folderforge setup browser
folderforge doctor
```

On supported Linux hosts that also need operating-system dependencies:

```bash
folderforge setup browser --with-deps
```

FolderForge resolves the Playwright runtime from its installed dependency tree;
the built-in adapter does not launch a mutable `npx` package. If Playwright or
Chromium is unavailable, FolderForge keeps non-browser tools usable and does not
advertise unusable `browser_*` wrappers. See
[Playwright setup and diagnostics](docs/playwright-macos.md).

## Core capabilities

- **Workspace:** activate one or more project roots and inspect health.
- **Files and code:** governed reads, writes, searches, diffs, code context, and
  transactional patches.
- **Commands and builds:** shell, managed processes, tests, builds, formatting,
  coverage, and package-manager operations.
- **Git:** status, diff, history, branches, commits, fetch/pull/push under policy.
- **MCP composition:** namespace or facade child MCP servers and local plugins,
  with optional digest-pinned Docker/Podman isolation.
- **Workflows:** persistent role-scoped plans with checkpoints and bounded
  evidence.
- **Mission Control:** local active-call/session/task/process/isolation view with
  persistent write freeze and governed containment actions.
- **Durable verification:** owner-bound typecheck/lint/test/build reports with
  explicit passed, failed, skipped, and unavailable evidence across restart.
- **Artifacts and UI quality:** content-addressed evidence, screenshot baselines,
  pixel comparison, bounded accessibility/contrast audit, device/network
  emulation, and governed composed UI flows.
- **Distributed workers:** TLS-gated remote worker API/CLI with short-lived
  identity, encrypted jobs, leases/fencing, artifact transfer, no-replay blocking,
  and signed completion evidence.
- **Verified marketplace:** Ed25519 publishers, immutable signed entries,
  SBOM/provenance binding, quarantine scans, moderation, and disabled installation.
- **Optional integrations:** Playwright browser tools, databases, OAuth/ChatGPT,
  and a shipped Godot 4 addon.

The exact CLI and tool reference lives in [the documentation index](docs/README.md)
rather than this landing page. Operational guides:

- [Browser emulation and flows](docs/browser-emulation-flows.md)
- [Distributed workers](docs/distributed-workers.md)
- [Verified marketplace](docs/marketplace.md)
- [Benchmark operations](docs/benchmark-operations.md)
- [Beta evidence and graduation](docs/beta-program.md)

## Safety model

FolderForge treats the agent as capable but not fully trusted.

- Paths must remain inside configured workspace roots and pass denied-glob,
  symlink/junction, and protected-directory checks.
- Commands and tools are classified by risk and evaluated under `readonly`,
  `safe`, `dev`, or `danger` policy.
- High-risk and critical actions may require a separate administrator approval.
  Agent MCP clients cannot approve their own requests or elevate policy.
- Arguments, output, approvals, diagnostics, and audit records use bounded secret
  redaction.
- HTTP defaults to loopback. Non-loopback use requires explicit authentication.

`--policy danger` does not by itself bypass critical approvals. The
`--dangerously-allow-critical` escape hatch is for isolated development only.
Read [Security](SECURITY.md) and the [technical security model](docs/security.md)
before exposing FolderForge beyond a trusted local machine.

## Authenticated HTTP

Stdio is the recommended local MCP transport. HTTP is useful for a fixed trusted
client or an OAuth deployment.

Generate a strong token and start a loopback endpoint:

```bash
TOKEN="$(openssl rand -hex 32)"
folderforge --project . --http --auth token --require-auth \
  --host 127.0.0.1 --port 7331 --token "$TOKEN"
```

Call it with a bearer token:

```bash
curl -sS -X POST http://127.0.0.1:7331/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"example","version":"1.0.0"}}}'
```

If a tunnel client such as `cloudflared` or `ngrok` is running on the same
machine, FolderForge refuses to start an *unauthenticated* HTTP server, because
the loopback port may already be published to the internet. Authenticate the
server, or pass `--allow-unauthenticated-tunnel` when the tunnel is known to be
unrelated. See the [tunnel exposure guard](docs/security.md#tunnel-exposure-guard).

Static credentials never act as OAuth credentials. OAuth mode never falls back
to `X-API-Key`. For ChatGPT/Auth0 and external authorization-server setup, use:

- [ChatGPT connection guide](docs/chatgpt-connect.md)
- [OAuth deployment reference](docs/oauth.md)
- [OAuth architecture decision](docs/adr-0004-oauth-resource-server.md)


## CLI flags reference

| Flag | Alias | Description | Default |
|---|---|---|---|
| `--tools-preset <id>` | | Filter advertised tools: `vibe` (84 tools), `vibe-lite`, `readonly`, `full` (337), `godot`, `adaptive` (small core + governed `call_runtime_tool` gateway) | `vibe` |
| `--http` | | Enable HTTP transport (in addition to stdio) | off |
| `--stdio` | | Enable stdio transport | on |
| `--port <n>` | | HTTP listen port | `7331` |
| `--host <h>` | | HTTP bind host | `127.0.0.1` |
| `--auth <mode>` | | Auth mode: `none`, `token`, `oauth` | `none` |
| `--token <value>` | | Static bearer token (used with `--auth token`) | — |
| `--api-key <csv>` | | One or more API keys accepted in `X-API-Key` header | — |
| `--require-auth` | | Refuse requests that have no valid credential | off |
| `--allow-unauthenticated-tunnel` | | Bypass the tunnel-exposure guard (see [Security](docs/security.md)) | off |
| `--policy <mode>` | | Risk policy: `readonly`, `safe`, `dev`, `danger` | `dev` |
| `--dangerously-allow-critical` | | Allow critical-risk tools in `danger` mode | off |
| `--project <path>` | `-p` | Workspace root | `cwd` |
| `--config <path>` | `-c` | Config file path | auto-detect |
| `--no-dashboard` | | Disable the local dashboard server | off |
| `--dashboard-port <n>` | | Dashboard listen port | `7332` |
| `--version` | `-v` | Print version and exit | — |
| `--help` | `-h` | Print help and exit | — |

## Tool surface

Clients with a tool-count limit can select a preset:

```bash
folderforge --project . --stdio --tools-preset vibe
folderforge --project . --stdio --tools-preset vibe-lite
folderforge --project . --stdio --tools-preset readonly
folderforge --project . --stdio --tools-preset full
folderforge --project . --stdio --tools-preset adaptive   # ~25-tool core + call_runtime_tool gateway
```

You can also enable groups or individual tools. Run `folderforge --help` and see
[Tools reference](docs/tools.md). Tool counts are intentionally not hard-coded
here because integrations and generated surfaces can change.

## Godot addon

The npm package includes `addons/folderforge_bridge`, the Godot 4 runtime bridge
used by FolderForge's live-game tools. Copy that directory into a Godot project,
enable the plugin, and follow [the Godot guide](docs/godot-mcp.md). The bridge
binds to loopback by default and does not replace FolderForge policy or approval
checks.

## From source

```bash
git clone https://github.com/roronoazoroshao369/FolderForge.git
cd FolderForge
npm ci --ignore-scripts
npm run build
npm test
node dist/main.js --version
```

During development:

```bash
npm run dev -- --project . --stdio
```

Run the complete local release gate:

```bash
npm run release:check
```

A local pass is not proof that another operating system passed. Platform claims
must come from CI or direct evidence for the exact revision.

## Documentation

Start at [docs/README.md](docs/README.md).

- [Getting started and compatibility](docs/README.md#getting-started)
- [Tools and adapters](docs/README.md#reference)
- [Security](docs/README.md#security)
- [Architecture](docs/README.md#architecture)
- [Migration](docs/README.md#migration)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)

## Compatibility

FolderForge supports Node.js 22 and 24. The required CI matrix covers Ubuntu,
macOS, and Windows. See [Compatibility](docs/compatibility.md) for the current
contract and evidence rules.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SUPPORT.md](SUPPORT.md) first.
Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public
issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
