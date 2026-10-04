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

## Terminal command sandbox

`terminal.sandbox` governs `shell_exec` and `process_start`. The default is
`mode: process` with `requireInDanger: true`: safe/dev preserve approval-gated
host execution, while danger fails closed instead of silently running a command
on the host. Configure a pre-existing digest-pinned image to enable danger
commands:

```yaml
terminal:
  shell: /bin/bash
  defaultTimeoutMs: 120000
  maxOutputBytes: 200000
  envPolicy: redact
  sandbox:
    mode: docker # or podman
    image: registry.example/folderforge-terminal@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    shell: /bin/sh
    network: none
    readOnlyRoot: true
    memoryMb: 512
    cpus: 1
    pidsLimit: 128
    tmpfsMb: 64
    requireInDanger: true
```

FolderForge mounts only the active project root, read-write, at `/workspace` and
maps the requested cwd beneath it. The root filesystem remains read-only and host
environment variables are not forwarded into the container. A cwd escape,
mutable image tag, missing runtime/image, or invalid resource contract fails the
call; it never falls back to process mode.

A trusted local operator may explicitly set `requireInDanger: false` with
`mode: process` for backward compatibility. That opts back into commands running
with the FolderForge user's host privileges. Destructive-command blocks,
workspace policy for native tools, authorization, audit, and rate limits still
apply; the opt-out is not a general hard-deny bypass.

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

## Verifying the boundary locally

`npm run smoke:sandbox` proves the container boundary end to end: it starts a
sandboxed child MCP adapter, confirms the declared environment value is visible
inside the container, and confirms an undeclared host secret is not.

The suite never pulls an image. Provide a digest-pinned image that is already
present locally:

```bash
docker pull python:3.12-alpine
export FOLDERFORGE_SANDBOX_IMAGE="$(docker inspect --format '{{index .RepoDigests 0}}' python:3.12-alpine)"
npm run smoke:sandbox
```

The image only needs a `python` interpreter on `PATH`; the fixture server is
mounted read-only from `tests/fixtures`. Without a valid
`image@sha256:<digest>` value the suite exits with an explicit prerequisite
message rather than a runtime failure.

### Terminal (shell_exec / process_start) runtime tests
`tests/integration/sandbox-runtime.test.ts` runs real commands through the policy pipeline in a real container and checks the isolation from the inside (uid/gid, capabilities, mounts, network, read-only root, cgroup limits, `--pull=never`, no host fallback). Without a prerequisite image the container cases skip; set `FOLDERFORGE_REQUIRE_RUNTIME_TESTS=1` (as CI does) to make a missing runtime a failure:

```bash
docker pull alpine:3.20
export FOLDERFORGE_SANDBOX_IMAGE="$(docker inspect --format '{{index .RepoDigests 0}}' alpine:3.20)"
FOLDERFORGE_REQUIRE_RUNTIME_TESTS=1 npx vitest run tests/integration/sandbox-runtime.test.ts
```

Containers are named `folderforge-term-<host>-<pid>-<random>` and are force-removed on `shell_exec` timeout, `process_kill`, and forced shutdown (R11). If FolderForge itself hard-crashes, the next startup in the same Docker/Podman mode scans only these names and force-removes same-host containers whose owner PID is no longer alive (R14). Containers from live owners, other hosts, or malformed/legacy names are left untouched.

## Boundary

Container mode materially improves filesystem, process, capability, network, and
resource isolation, but it is not a claim that every container engine or host
kernel is vulnerability-free. Operators still need a patched runtime, reviewed
images, minimal mounts, rootless execution where practical, and host-level
monitoring. Windows and macOS container engines normally run Linux containers in
a VM; host-path mount semantics should be validated on the deployment platform.
