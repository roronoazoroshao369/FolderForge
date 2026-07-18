# Playwright child adapter on macOS

FolderForge's built-in Playwright integration is a child MCP server. FolderForge
starts it over stdio, performs MCP `initialize`, sends
`notifications/initialized`, then performs `tools/list` before advertising
browser capabilities.

This document covers installation, offline behavior, diagnostics, degraded
startup, and macOS-specific troubleshooting.

## Built-in execution model

The generated Playwright adapter no longer starts through `npx`. FolderForge:

1. Resolves `@playwright/mcp/package.json` from FolderForge's installed dependency
   tree using `createRequire(import.meta.url)`.
2. Reads the package's declared `mcp-server-playwright` bin.
3. Starts that CLI with the current `process.execPath`.
4. Passes `--isolated` by default.

Consequences:

- normal startup does not require network access;
- the child uses the same Node installation as FolderForge, including nvm-managed
  Node installations;
- startup does not depend on a global npm cache or whichever `npx` happens to be
  first on `PATH`;
- local, packed, and global npm installs work when their path contains spaces or
  Unicode;
- custom adapter commands in YAML remain supported.

FolderForge also recognizes the exact historical generated definition:

```yaml
command: npx
args: ["-y", "@playwright/mcp@0.0.41", "--isolated"]
```

That legacy generated definition is resolved package-locally at runtime. A
custom package version or custom command is not rewritten.

The generated form is:

```yaml
adapters:
  playwright:
    enabled: true
    command: package:@playwright/mcp
    args: ["--isolated"]
```

`package:@playwright/mcp` is a FolderForge launch marker, not a shell command.

## Browser setup

FolderForge does not download Chromium during `npm install`, global install, or
adapter startup. Install the browser explicitly:

```bash
folderforge setup browser --dry-run
folderforge setup browser
folderforge doctor
```

On macOS and Windows, do not add `--with-deps`. It is an opt-in Playwright option
for supported Linux hosts that also need operating-system packages:

```bash
folderforge setup browser --with-deps
```

The setup command resolves the Playwright runtime owned by `@playwright/mcp`, not
an unrelated top-level Playwright version. After installation it resolves the
expected Chromium executable again and fails if that executable is still absent.
The human and JSON reports include the compatible runtime version and executable
path when available.

Setup never invokes `sudo` itself. It may access the network because browser
installation is explicit. `folderforge doctor` never installs a package or a
browser and never performs a network install.

## Doctor readiness probe

When the Playwright adapter is enabled, `folderforge doctor` checks these layers:

1. FolderForge package dependency resolution.
2. `@playwright/mcp` package-local CLI resolution.
3. Compatible Chromium executable availability.
4. Child process spawn.
5. MCP `initialize` response.
6. MCP `tools/list` response.
7. Bounded shutdown and child cleanup.

The readiness probe uses timeouts and forces npm offline mode for the child. A
built-in adapter that is already installed must not fetch from the network.

A successful report contains evidence similar to:

```text
phase=tools/list
source=package-local
protocol=2025-11-25
elapsedMs=84
tools=21
transport={"requestsSent":2,"responsesReceived":2,"pendingRequests":0}
package=@playwright/mcp@0.0.41
```

Doctor runs the same bounded readiness probe for every enabled child MCP adapter,
not only Playwright. A failed report includes the adapter name, resolved command,
redacted arguments, working directory, failure phase, classified failure kind and
disposition, exit code or spawn error, timeout state, bounded redacted stderr,
and remediation.

## Failure phases and classifications

Phases are stable:

```text
resolve
spawn
initialize
tools/list
runtime
shutdown
```

FolderForge distinguishes at least:

```text
executable_not_found
spawn_error
npm_package_resolution_failure
network_or_cache_failure
child_exited_before_initialize
initialize_timeout
tools_list_failure
tools_list_timeout
unsupported_protocol_version
tools_list_limit_exceeded
tools_list_pagination_cycle
request_timeout
json_rpc_error
malformed_json_rpc
json_rpc_message_too_large
stdout_buffer_limit_exceeded
pending_request_limit_exceeded
heartbeat_timeout
missing_chromium
browser_launch_failure
permission_or_quarantine
architecture_mismatch
unsupported_node_version
invalid_adapter_arguments
runtime_crash
shutdown_failure
```

Child stderr is kept as a bounded tail, redacted before warning/error output, and
written only through FolderForge's stderr logger. It is never copied into the
stdout stdio MCP transport. FolderForge does not log the complete child
environment.

## Degraded startup policy

The default policy remains backward compatible: FolderForge continues starting
when an enabled child adapter fails. The failure is not silently discarded.

- Adapter status retains `ready: false`, lifecycle state, failure disposition,
  retry timing, metrics, transport counters, and the last structured diagnostic.
- Transient failures enter exponential backoff and, after repeated failures, an
  open circuit. One half-open request probes recovery after the cooldown.
- Configuration, compatibility, and resource-bound failures become `blocked`
  until the adapter definition is replaced or reloaded; they are not respawned
  continuously.
- `workspace_status`, `workspace_health`, doctor, dashboard health, and startup
  warning logs can expose the failure.
- Native `browser_*` wrappers are removed from the advertised registry when the
  configured Playwright adapter is disabled or fails discovery.
- Non-browser tools remain usable, and FolderForge never automatically replays a
  failed browser/tool call after reconnecting.

This avoids both extremes: a headless project is not blocked by an optional
browser integration, and an AI agent is not told that browser tools are ready
when the child cannot serve them.

## macOS troubleshooting

Run:

```bash
folderforge doctor --json
```

Use the reported `phase` and `kind` instead of treating every failure as an npm
problem.

### `resolve` / `npm_package_resolution_failure`

The installed FolderForge dependency tree is incomplete or damaged. Reinstall
FolderForge under the Node installation you intend to use. Built-in startup does
not use `npx`, so clearing a global npm cache is not the primary fix.

### `spawn` / `executable_not_found`

This normally indicates a custom adapter command. Check the command path and the
active Node installation. For an nvm installation, compare:

```bash
command -v node
command -v npm
command -v folderforge
node --version
```

The built-in adapter itself is started by `process.execPath`.

### `permission_or_quarantine`

Inspect permissions and macOS Gatekeeper/quarantine state for Node and the
installed package files. Do not recursively remove quarantine or weaken system
security without reviewing the exact affected file. Reinstalling the npm package
from a trusted source is preferable to broad permission changes.

### `architecture_mismatch`

Check that Node and installed native/runtime artifacts match the machine
architecture, especially when moving between Intel and Apple Silicon or running
under Rosetta:

```bash
node -p "process.arch"
uname -m
```

Install FolderForge again under the intended Node architecture.

### `unsupported_node_version`

FolderForge requires Node 22 or newer. Select the correct nvm/asdf/Volta Node
version, then reinstall the global package so its bin shim and dependency tree
belong to that installation.

### `missing_chromium`

Run:

```bash
folderforge setup browser
folderforge doctor
```

The setup report identifies the compatible Playwright version and Chromium
location.

### `initialize_timeout` or `tools_list_timeout`

Inspect the bounded stderr tail. Security software, a damaged install, invalid
arguments, or a child process waiting on an unexpected condition can cause these
phases. Doctor kills the probe after its bounded timeout.

### `browser_launch_failure`

The MCP handshake may succeed even when the first browser launch fails. Confirm
Chromium exists, rerun setup, and inspect permission/quarantine diagnostics. A
successful setup alone is not proof that navigation works; include an actual
browser smoke in release validation.

## Offline behavior

After FolderForge and its dependencies are installed, the built-in adapter can
resolve, initialize, and list tools with npm offline mode enabled. Chromium must
already be installed for browser operations. Offline startup does not imply that
`folderforge setup browser` can download a missing browser.

Custom YAML commands may still intentionally use `npx`, another package manager,
or a network-dependent launcher. Those commands retain their configured
behavior and are reported as `source=custom`.

## Security notes for autonomous HTTP mode

`--policy danger` does not automatically approve CRITICAL actions. With
`--no-dashboard`, approval-gated actions have no dashboard approval channel. A
fully autonomous development invocation therefore requires both:

```bash
--policy danger --dangerously-allow-critical
```

Use that combination only on an isolated or tightly controlled development
machine. It materially weakens safeguards.

`authMode=none` on a loopback address prevents remote network binding, but it does
not prove every local process is trusted. For autonomous danger mode, use token
authentication even on loopback:

```bash
folderforge --http --auth token --require-auth --token "<strong-random-token>" \
  --policy danger --dangerously-allow-critical --no-dashboard
```

Keep `vibe-lite` when a capped coding/browser surface is desired. Use `full` only
when the client can safely handle and govern the larger tool surface.

## Verification matrix

The deterministic suite covers source execution, packed local installation,
global installation under a temporary prefix, normal paths, paths with spaces,
Unicode paths, missing/available browser states, network-available explicit
setup, offline post-install adapter startup, nvm-style Node paths, handshake
timeouts, malformed protocol data, stderr redaction/bounds, and child cleanup.

The repository CI matrix runs Ubuntu, macOS, and Windows on Node 22 and Node 24.
A local Linux pass is not a claim that a new change passed macOS; the macOS verdict
must be based on a CI run or direct macOS evidence for the exact revision.
