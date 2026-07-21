# Compatibility

**Audience:** Users, operators, and contributors.

FolderForge supports Node.js 22 and 24. The required repository matrix covers the
current GitHub-hosted Ubuntu, macOS, and Windows runners.

## Required matrix

| Operating system | Node 22 | Node 24 |
| --- | --- | --- |
| Ubuntu latest | Required | Required |
| macOS latest | Required | Required |
| Windows latest | Required | Required |

Every matrix entry installs dependencies with lifecycle scripts disabled and
runs:

1. Typecheck and lint.
2. Unit and integration tests.
3. Production build.
4. Documentation, link, and version consistency checks.
5. Packed-tarball local and global-prefix installs plus CLI, doctor, browser
   resolution, and package-local Playwright MCP handshake smoke in paths with
   spaces and Unicode.
6. Stdio MCP initialize, `tools/list`, and governed file-read smoke.
7. Authenticated HTTP MCP initialize, list, and call smoke.

Ubuntu/Node 22 additionally enforces coverage thresholds and property/fuzz checks.
Ubuntu/Node 22 and Windows/Node 22 run repeated heartbeat stress plus official MCP
Inspector stdio `tools/list`/`tools/call` conformance. Every Node 22 operating-system
job installs and exercises the exact-version/integrity-pinned third-party child MCP
matrix and retains its JSON report. These targeted jobs protect the runtime versions
and platforms that exposed the original scheduling race. Dependency audits for the
FolderForge tree run once on Ubuntu/Node 22; the isolated third-party matrix audits
its own temporary production dependency graph on every Node 22 operating system.

## Evidence rule

Compatibility belongs to an exact Git commit. A platform is accepted only when
its required job passes for that revision, or when equivalent direct evidence is
recorded for that same revision. Old workflow run IDs and local results on another
operating system are not transferable evidence.

The latest public `main` run should be checked before making a readiness claim:

```bash
gh run list --repo roronoazoroshao369/FolderForge --workflow ci.yml --branch main --limit 5
gh run view <run-id> --repo roronoazoroshao369/FolderForge
```

Documentation must say that a revision is awaiting platform verification when its
fix has not yet been pushed and exercised by the full matrix.

## Shell behavior

FolderForge uses platform-specific invocation:

- `cmd.exe`: `/d /s /c <command>`
- PowerShell: `-NoLogo -NoProfile -NonInteractive -Command <command>`
- POSIX shells and Git Bash: `-lc <command>`

Configured commands, managed processes, verification, and Godot launch paths use
shared quoting and process-tree cleanup helpers. Tests cover spaces, Unicode,
Windows junction escape rejection, and bounded child cleanup.

## Browser installation

Normal package installation does not download Chromium. Setup is explicit:

```bash
folderforge setup browser
folderforge doctor
```

`--with-deps` is intended only for supported Linux environments that need
Playwright operating-system packages. The built-in adapter resolves its CLI and
compatible runtime from FolderForge's installed package tree. See
[Playwright setup](playwright-macos.md).

## Degraded behavior

An unavailable optional Playwright child does not make non-browser tools fail.
FolderForge records a structured diagnostic and removes unusable browser wrappers
from the advertised surface. This is degraded operation, not browser readiness.


## Distributed and marketplace compatibility

The 2.5 reference coordinator/worker transport is tested on loopback with real
artifact transfer and signed completion evidence. Non-loopback deployments must
provide TLS files and separately validate certificate lifecycle, firewall, worker
host isolation, and recovery in their target environment. The durable coordinator
is single-writer per project state root.

Marketplace package creation/quarantine uses the maintained `tar` runtime and is
covered by traversal/link/archive/lifecycle/secret/digest tests. Public HTTPS
hosting, publisher identity verification, and moderation operations are not
created by the package and require deployment-specific acceptance evidence.
