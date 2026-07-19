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

Run FolderForge for the current project:

```bash
npx -y @musashishao/folderforge --project . --stdio
```

The process waits for MCP JSON-RPC on stdin. In normal use your MCP client starts
this command for you.

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

Static credentials never act as OAuth credentials. OAuth mode never falls back
to `X-API-Key`. For ChatGPT/Auth0 and external authorization-server setup, use:

- [ChatGPT connection guide](docs/chatgpt-connect.md)
- [OAuth deployment reference](docs/oauth.md)
- [OAuth architecture decision](docs/adr-0004-oauth-resource-server.md)

## Tool surface

Clients with a tool-count limit can select a preset:

```bash
folderforge --project . --stdio --tools-preset vibe
folderforge --project . --stdio --tools-preset vibe-lite
folderforge --project . --stdio --tools-preset readonly
folderforge --project . --stdio --tools-preset full
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
