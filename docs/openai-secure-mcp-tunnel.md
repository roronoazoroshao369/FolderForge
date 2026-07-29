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
  --oauth \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --project /absolute/path/to/project
```

`--oauth` requires an active Auth0 CLI login (`auth0 login`). Omit it only when a single static-token principal is sufficient.

FolderForge then:

1. detects or installs the official `openai/tunnel-client`;
2. verifies the downloaded GitHub release archive against its published SHA-256 digest;
3. derives the public OAuth resource as `https://api.openai.com/v1/mcp/<tunnel_id>`;
4. provisions or reuses the Auth0 API, scopes, DCR policy, and login connections;
5. starts FolderForge on loopback with OAuth JWT validation plus a separate random per-run gateway guard;
6. configures `tunnel-client` to inject that guard for both discovery and runtime requests while preserving the user's `Authorization` bearer token;
7. verifies local RFC 9728 metadata and the unauthenticated OAuth challenge;
8. waits for tunnel `/healthz` and `/readyz`, opens ChatGPT, and watches for the DCR client;
9. repairs the detected ChatGPT client and grant through the existing Auth0 lifecycle; and
10. stores secret-free local receipts.

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

## OAuth through the private tunnel

The OAuth mode uses two independent checks:

1. a random `X-FolderForge-Tunnel-Guard` value proves that the local request came through the supervised `tunnel-client`; and
2. the OAuth bearer JWT identifies the ChatGPT user/client and carries `folderforge:read` / `folderforge:write` scopes.

The guard value exists only in child-process environments for the current run. It is never stored in `.folderforge/openai-tunnel.json`. The OpenAI runtime API key is also isolated from the FolderForge child so governed tools cannot read it.

The default public audience is derived automatically. For an enterprise control-plane gateway, override the base path:

```bash
folderforge connect chatgpt --openai-tunnel --oauth \
  --tunnel-base-url https://gateway.example/workspace/dev
```

Or provide the exact resource explicitly:

```bash
folderforge connect chatgpt --openai-tunnel --oauth \
  --oauth-resource https://api.openai.com/v1/mcp/tunnel_0123456789abcdef0123456789abcdef
```

Useful lifecycle options:

```text
--oauth-repair                 Re-provision Auth0/DCR instead of reusing saved state
--oauth-no-wait                Start without waiting for a new ChatGPT DCR client
--oauth-tenant <tenant>        Select a specific Auth0 tenant
--oauth-login-connection <id>  Repeat or comma-separate Auth0 connections
--no-oauth                     Force legacy static-token tunnel mode
```

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

The tunnel receipt contains the tunnel ID, authentication mode, public OAuth resource, Auth0 issuer/scopes, and an API-key **reference** such as `env:CONTROL_PLANE_API_KEY`. It never contains the control-plane API key, OAuth tokens, or per-run gateway guard. The health URL file is removed when the supervisor exits.

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

### OAuth discovery still shows 404

Run with `--oauth`. Legacy static-token mode intentionally does not advertise RFC 9728 metadata. In OAuth mode, both `/.well-known/oauth-protected-resource/mcp` and the root fallback are served locally behind the tunnel guard.

### Auth0 login or DCR repair fails

Run `auth0 login`, confirm the selected tenant, then retry with `--oauth-repair`. The authorization server must remain publicly reachable for the ChatGPT login flow; only the MCP resource is private behind Secure MCP Tunnel.

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
