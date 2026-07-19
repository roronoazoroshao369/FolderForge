# Child MCP and plugin sandboxing

FolderForge supports three child runtime modes: `process`, `docker`, and
`podman`. `process` preserves the existing trusted-local behavior. Container
modes create a real operating-system isolation boundary and fail closed when the
runtime, image, mount, or resource contract is invalid.

## Container defaults

Docker and Podman launches use:

```text
run --rm -i --pull=never
--network=none
--cap-drop=ALL
--security-opt=no-new-privileges
--read-only
--pids-limit=128
--memory=512m
--cpus=1
--tmpfs /tmp:rw,noexec,nosuid,size=64m
```

On POSIX, the container also runs with the current host UID/GID. Images must be
pinned as `image@sha256:<digest>` unless an explicit development-only
`requireImageDigest: false` override is present. FolderForge never pulls images
automatically.

Only environment names declared in `env` are forwarded with `--env KEY`; values
are inherited by the container runtime at execution time and are not embedded in
logged arguments. Mount sources must be absolute host paths and mount targets
must be absolute POSIX paths without `..` or duplicate targets.

## Plugin manifest

A local plugin can request a sandbox inside `runtime`:

```json
{
  "runtime": {
    "command": "node",
    "args": ["{pluginDir}/server.mjs"],
    "facade": true,
    "sandbox": {
      "mode": "docker",
      "image": "registry.example/plugin@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "memoryMb": 512,
      "cpus": 1,
      "pidsLimit": 128,
      "tmpfsMb": 64
    }
  },
  "permissions": {
    "network": false,
    "filesystem": "workspace",
    "env": ["PLUGIN_API_KEY"]
  }
}
```

For sandboxed plugins FolderForge mounts the installed plugin at `/plugin`
read-only. `filesystem: "workspace"` adds the project at `/workspace` read-write;
a plugin that does not request workspace access receives no workspace mount.
`network: false` maps to `--network=none`; `true` maps to the container runtime's
bridge network. Sandboxed plugins cannot request `filesystem: "external"`.
Placeholders become `/plugin` and `/workspace` inside the container.

## Diagnostics

`folderforge doctor` validates the sandbox contract, checks that Docker or Podman
is on PATH, and uses read-only `image inspect` to prove the exact digest-pinned
image exists locally. The readiness probe then performs the normal MCP initialize
and `tools/list` handshake through the container. Invalid sandbox arguments are
classified as configuration failures and block automatic retry until the adapter
or plugin is updated.

## Boundary

Container mode materially improves filesystem, process, capability, network, and
resource isolation, but it is not a claim that every container engine or host
kernel is vulnerability-free. Operators still need a patched runtime, reviewed
images, minimal mounts, rootless execution where practical, and host-level
monitoring. Windows and macOS container engines normally run Linux containers in
a VM; host-path mount semantics should be validated on the deployment platform.
