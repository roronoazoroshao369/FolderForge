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

A green job proves only the steps that ran. NOT_RUN is not a pass. Docker
success is not Podman evidence, and a Windows success is not Ubuntu or macOS
evidence.

Ubuntu and macOS jobs install dependencies with lifecycle scripts disabled and
run typecheck, lint, architecture and documentation checks, the full unit and
integration suite, production build, packed-tarball CLI smoke, stdio MCP smoke,
and authenticated HTTP MCP smoke. Ubuntu/Node 22 additionally runs coverage,
property/fuzz, real Docker isolation, the containerized child-MCP boundary,
heartbeat stress, MCP Inspector, and the Ubuntu-only evidence gates named in
the workflow. macOS/Node 22 also runs heartbeat stress. These checks remain
required where the workflow enables them.

Windows jobs install dependencies the same way and run typecheck, lint,
architecture and documentation checks, routing-only sandbox selection tests,
Fleet reconnect recovery, the focused Windows danger-mode regression, and the
production build. Windows/Node 22 also runs the pinned third-party child-MCP
probe and retains its artifact. Windows danger-mode regression is not the full unit and integration suite.
The package, stdio, and authenticated HTTP smokes are not Windows evidence.
In particular, heartbeat stress and MCP Inspector do not run on Windows.
No Windows gate was removed to make this contract true.

The table below is the Windows run/NOT_RUN contract for every named workflow
step except runner setup. `tests/unit/windows-ci-claims.test.ts` regenerates it
from `.github/workflows/ci.yml` and fails if the document drifts or if a gate
that already runs on Windows stops running.

<!-- windows-ci-contract:start -->
| Step | Node 22 | Node 24 |
| --- | --- | --- |
| Install dependencies without lifecycle downloads | run | run |
| Typecheck | run | run |
| Lint | run | run |
| Architecture boundaries | run | run |
| Documentation and version checks | run | run |
| Real container-runtime isolation (Docker, digest-pinned image) | NOT_RUN | NOT_RUN |
| Sandbox smoke runtime selection (routing-only, not containment evidence) | run | run |
| macOS operator-state directory fsync feasibility (not power-loss evidence) | NOT_RUN | NOT_RUN |
| Fleet reconnect recovery (orphan reaping, lease fencing) | run | run |
| Audit durability failure injection | NOT_RUN | NOT_RUN |
| Preserve audit durability evidence | NOT_RUN | NOT_RUN |
| Evidence integrity and release provenance corpus | NOT_RUN | NOT_RUN |
| Preserve evidence integrity results | NOT_RUN | NOT_RUN |
| Test | NOT_RUN | NOT_RUN |
| Windows danger-mode regression | run | run |
| Coverage regression gate | NOT_RUN | NOT_RUN |
| Property and fuzz checks | NOT_RUN | NOT_RUN |
| Child MCP heartbeat stress | NOT_RUN | NOT_RUN |
| Build | run | run |
| Containerized child MCP boundary smoke | NOT_RUN | NOT_RUN |
| Child MCP compatibility corpus | NOT_RUN | NOT_RUN |
| Preserve child MCP compatibility evidence | NOT_RUN | NOT_RUN |
| Pinned third-party child MCP compatibility | run | NOT_RUN |
| Preserve third-party child MCP evidence | run | NOT_RUN |
| Concurrent audit writer stress | NOT_RUN | NOT_RUN |
| Evidence migration and tamper smoke | NOT_RUN | NOT_RUN |
| Resumable runtime soak smoke | NOT_RUN | NOT_RUN |
| Preserve runtime soak smoke evidence | NOT_RUN | NOT_RUN |
| Full-day soak evidence volume gate | NOT_RUN | NOT_RUN |
| Preserve soak volume evidence | NOT_RUN | NOT_RUN |
| Five-minute onboarding smoke | NOT_RUN | NOT_RUN |
| Godot adapter package smoke | NOT_RUN | NOT_RUN |
| Governance microbenchmark | NOT_RUN | NOT_RUN |
| Preserve governance benchmark evidence | NOT_RUN | NOT_RUN |
| MCP Inspector conformance | NOT_RUN | NOT_RUN |
| Pack, install tarball, and smoke CLI | NOT_RUN | NOT_RUN |
| Smoke stdio MCP with spaces and Unicode | NOT_RUN | NOT_RUN |
| Smoke authenticated HTTP MCP | NOT_RUN | NOT_RUN |
| Production dependency audit | NOT_RUN | NOT_RUN |
| Full dependency audit | NOT_RUN | NOT_RUN |
<!-- windows-ci-contract:end -->

Every Node 22 operating-system job, including Windows, installs and exercises
the exact-version/integrity-pinned third-party child MCP matrix and retains its
JSON report. That probe audits its own temporary production dependency graph.
FolderForge's own dependency audits run once on Ubuntu/Node 22.

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
