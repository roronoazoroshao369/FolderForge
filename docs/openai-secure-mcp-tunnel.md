# OpenAI Secure MCP Tunnel

Use this flow when FolderForge runs on a workstation or private network and ChatGPT must reach it without a public MCP URL. FolderForge supervises both the local MCP server and OpenAI's official `tunnel-client` with one command.

## Prerequisites

1. Node.js 22 or 24.
2. An OpenAI Secure MCP Tunnel created for the correct Platform organization and linked ChatGPT workspace.
3. A runtime API key whose principal can read and use that tunnel.

Create or inspect these in OpenAI Platform:

- Tunnels: <https://platform.openai.com/settings/organization/tunnels>
- Runtime API keys: <https://platform.openai.com/settings/organization/api-keys>

FolderForge cannot grant organization permissions. An organization administrator must provision the tunnel and runtime-key permissions first.

## One-command startup

First run:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --project /absolute/path/to/project
```

FolderForge then:

1. detects or installs the official `openai/tunnel-client`;
2. verifies the downloaded GitHub release archive against its published SHA-256 digest;
3. starts FolderForge on a free loopback port;
4. requires a random per-run local API token between `tunnel-client` and FolderForge;
5. starts `tunnel-client` with the selected tunnel ID and API-key reference;
6. waits for both `/healthz` and `/readyz` to pass;
7. stores a secret-free local receipt; and
8. opens the local tunnel UI and ChatGPT connector settings when running interactively.

Keep the process running. Press `Ctrl+C` to stop both FolderForge and the tunnel.

After the first successful run, the project receipt remembers the tunnel ID, client path, profile, and API-key reference. The API-key value is not stored. Later startup is normally:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel --project /absolute/path/to/project
```

When the current directory is already the project root:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel
```

## Connect ChatGPT

Open ChatGPT connector settings, create or edit the MCP connector, choose the tunnel connection option, and select or paste the `tunnel_...` ID printed by FolderForge:

<https://chatgpt.com/#settings/Connectors>

Do not enter `localhost`, a Cloudflare Quick Tunnel URL, or the local FolderForge port in ChatGPT. ChatGPT connects to the OpenAI tunnel; `tunnel-client` performs the private hop to FolderForge.

## Profiles

The default profile is `developer`:

```text
policy: dev
tools preset: full
approval dashboard: enabled
```

Other profiles:

```bash
folderforge connect chatgpt --openai-tunnel --profile safe
folderforge connect chatgpt --openai-tunnel --profile full
```

`safe` uses `safe` policy and `vibe-lite` tools. `full` uses `danger` policy and the full built-in tool surface, but it does **not** pass `--dangerously-allow-critical`; critical operations remain approval-gated. Use the local dashboard shown at startup to review approvals.

Override individual settings when needed:

```bash
folderforge connect chatgpt --openai-tunnel \
  --policy dev \
  --tools-preset godot \
  --dashboard-port 7442
```

## API-key handling

FolderForge accepts references, not a raw CLI flag:

```bash
# Preferred environment variable
export CONTROL_PLANE_API_KEY='sk-...'

# Alternate environment variable name
export MY_TUNNEL_KEY='sk-...'
folderforge connect chatgpt --openai-tunnel --api-key-env MY_TUNNEL_KEY

# Locked-down file
printf '%s' 'sk-...' > ~/.config/folderforge/tunnel-key
chmod 600 ~/.config/folderforge/tunnel-key
folderforge connect chatgpt --openai-tunnel \
  --api-key-file ~/.config/folderforge/tunnel-key
```

The API-key value is not written to the receipt or process argv. A file reference is rejected on POSIX when group or world permissions are present.

## Installer and offline operation

Install or verify the official client without requiring tunnel credentials:

```bash
folderforge connect chatgpt --openai-tunnel --install-only
```

The managed binary is stored under:

```text
~/.folderforge/bin/tunnel-client
```

Use a preinstalled binary and disable network installation:

```bash
folderforge connect chatgpt --openai-tunnel \
  --tunnel-client /absolute/path/to/tunnel-client \
  --no-install
```

Inspect the launch plan without starting either process:

```bash
folderforge connect chatgpt --openai-tunnel \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --dry-run
```

## Runtime state

Per-project state is written under `.folderforge/` and ignored by Git:

```text
.folderforge/openai-tunnel.json
.folderforge/openai-tunnel-server.log
.folderforge/openai-tunnel-health-<pid>.url
```

The receipt contains the tunnel ID and an API-key **reference** such as `env:CONTROL_PLANE_API_KEY`; it must never contain the API-key value. The health URL file is removed when the supervisor exits.

## Troubleshooting

### No runtime API key found

Export `CONTROL_PLANE_API_KEY`, choose `--api-key-env`, or supply a mode-0600 `--api-key-file`.

### Tunnel ID rejected

Use the exact Platform tunnel ID in this format:

```text
tunnel_0123456789abcdef0123456789abcdef
```

### Permission or control-plane errors

Verify that the API-key principal has tunnel read/use permission and that the tunnel is linked to the same ChatGPT workspace. FolderForge cannot repair organization RBAC.

### Local port already in use

Without an explicit port, FolderForge selects another free loopback port. When `--port` or `--dashboard-port` is explicitly supplied, an occupied port fails rather than silently changing it.

### Browser does not open

Opening URLs is best-effort. Copy the printed Tunnel UI and ChatGPT settings URLs manually, or use `--no-open` on headless systems.

### Process exits unexpectedly

Review:

```text
.folderforge/openai-tunnel-server.log
```

`tunnel-client` logs remain attached to the foreground terminal. Re-run with `--dry-run` to verify the generated command and credential references without exposing secret values.
