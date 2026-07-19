# Local MCP Plugin System

The 2.0 candidate supports prepared local MCP packages without creating a
second execution or governance path. Installed plugins become child MCP adapters
and use the same facade, policy, approval, audit, rate-limit, and rich-content
bridges as built-in adapters. This remains a local package flow rather than a
public marketplace. Trusted plugins may run directly as host processes; plugins
that declare Docker or Podman use an enforceable container boundary with bounded
mounts, network, process, memory, CPU, and temporary storage.

## Package format

A plugin directory contains `folderforge.plugin.json` plus already-prepared
runtime files. FolderForge does not fetch remote packages, install dependencies,
or execute package lifecycle scripts.

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "Example child MCP server",
  "compatibility": {
    "folderforge": ">=1.6.0",
    "mcpProtocol": "2024-11-05"
  },
  "runtime": {
    "command": "node",
    "args": ["{pluginDir}/server.mjs"],
    "facade": true
  },
  "permissions": {
    "network": false,
    "filesystem": "workspace",
    "env": ["EXAMPLE_API_KEY"]
  },
  "risk": {
    "default": { "risk": "MEDIUM", "mutates": true },
    "tools": {
      "search": { "risk": "LOW", "mutates": false }
    }
  }
}
```

Supported runtime placeholders are `{pluginDir}` and `{projectRoot}`. The command
must be a bare executable name or a `./` path that remains inside the copied
plugin package.

## Lifecycle tools

- `plugin_list` and `plugin_inspect` are read-only.
- `plugin_install`, `plugin_update`, and `plugin_uninstall` are HIGH risk.
- `plugin_enable`, `plugin_disable`, and `plugin_health` are MEDIUM risk.

Install defaults to disabled. This lets a user inspect compatibility,
permissions, risk declarations, and facade mode before starting executable code.
Enable/disable/update are hot operations; no server restart is required.

## Storage and limits

Plugin state lives under `.folderforge/plugins/` and creates a local `.gitignore`
so copied runtime files and registry metadata do not pollute project history.
Registry writes are atomic and mode `0600`. Every newly installed or updated
package records a deterministic SHA-256 digest over sorted relative file paths and
file bytes. `plugin_inspect`, adapter startup, and `folderforge doctor` recompute
the tree and reject a mismatch. Legacy registry records without a digest remain
readable but are reported as `unverified` until reinstalled or updated.

A package is rejected when it exceeds 2,000 files or 50 MB, contains symlinks,
has an invalid/reserved id, uses an incompatible FolderForge version, or declares
an invalid runtime/permission/risk contract. Update stages a full replacement,
keeps the previous package and registry record until the new child MCP catalog
loads successfully, and restores the old package/facade on validation, copy,
registry-write, or activation failure.

## Environment and process isolation

Process-mode plugin children run with their package directory as `cwd`. They do
not inherit the full parent environment; only a minimal executable path and the
manifest `permissions.env` allowlist are passed. Process mode still executes with
the current user's host privileges and is only appropriate for trusted code.

Docker and Podman modes enforce the declared boundary. The plugin package is
mounted read-only at `/plugin`; `filesystem: "workspace"` adds a bounded writable
`/workspace` mount; `network: false` disables container networking; capabilities
are dropped; the root filesystem is read-only; and CPU, memory, PID, and tmpfs
limits are applied. Images are digest-pinned and never pulled automatically.
`folderforge doctor` verifies the runtime and local image before readiness. See
[Sandboxing](sandbox.md) for the exact contract and remaining host-kernel limits.

## Trust evaluation

| Control | Current status | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Package integrity hash | **Enforced for new installs/updates** | Copied package bytes have not changed since installation | Publisher identity, authenticity, or safety of the original bytes |
| Package lock / pinning | **Evidence-only** | A copied lockfile and prepared dependencies are included in the package digest | FolderForge does not resolve/install dependencies or guarantee registry reproducibility |
| Provenance | **Prepared for FolderForge releases; not yet a plugin publisher contract** | The npm publishing workflow can attest the FolderForge tarball and SBOM | A local plugin directory still has no publisher attestation |
| Publisher identity | **Not provided for plugins** | None | A local directory name/manifest id is not a verified publisher |
| Permission review | **Validated; enforced in container mode** | Env forwarding is allowlisted; container network/filesystem intent maps to runtime flags and mounts | Process mode retains host-user privileges; container engines still depend on the host kernel/runtime |
| Sandbox | **Optional Docker/Podman enforcement** | Read-only root/plugin mount, bounded workspace mount, disabled/bridge network, dropped capabilities, no-new-privileges, and resource limits | It does not prove image authorship or eliminate container-runtime vulnerabilities |

A bare external `runtime.command` (for example `node`) is resolved from the host
`PATH` and is outside the package digest. A `./` runtime path and all copied
runtime files are inside the digest. Only install prepared local packages whose
source, dependency preparation, and host runtime you trust.

## Tool exposure

Facade mode defaults to true and is recommended. A plugin then consumes two
advertised tools regardless of its child catalog size:

```text
<plugin-id>__list_tools
<plugin-id>__call_tool
```

Per-sub-tool risk is resolved from the manifest and re-enters the normal dynamic
governance pipeline. Unknown sub-tools conservatively use the manifest default,
which itself defaults to MEDIUM/mutating.

Enabled plugins are restored on restart. They are advertised automatically when
there is no tool filter or the `full` preset is active. Explicit hot enable also
activates the plugin's facade in the current routed tool view. Capped presets do
not silently absorb every installed plugin.

## Historical live acceptance

An earlier source-built HTTP MCP acceptance run (before later native-tool growth)
verified:

- eight lifecycle tools and 262 native tools before plugin activation;
- hot install produced a two-tool facade (264 total);
- manifest risk metadata appeared in `list_tools`;
- child tool calls and health checks worked;
- env allowlisting exposed the declared variable and hid an undeclared secret;
- enabled plugin persisted across a FolderForge restart in `full`;
- hot disable removed facade tools immediately;
- uninstall removed copied files and registry metadata.

## Deferred trust features

- cryptographic plugin signatures, verified publisher identity, revocation, and signed plugin provenance;
- remote registry/marketplace and dependency resolution;
- automatic compatibility migration;
- stronger platform-specific sandbox profiles and independently attested runtime evidence;
- plugin capability-change notifications to clients.
