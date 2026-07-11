# Migrating to FolderForge 2.0

This document covers the `2.0.0-rc.2` candidate committed and pushed on `main`.
The candidate has not been tagged, published to npm, or released as a hosted
artifact. Install it from the npm `next` dist-tag only after the RC is published.

## Runtime requirements

- Node.js 22 or newer is required. The release matrix covers Node 22 and Node 24
  on Ubuntu, macOS, and Windows.
- Rebuild or reinstall FolderForge after switching versions so the CLI and
  generated `dist/` match `package.json`.
- Confirm with `folderforge --version` before starting an MCP client.
- FolderForge no longer downloads Chromium from an npm lifecycle script. Normal
  installation is browser-download-free. Run `folderforge setup browser` only on
  machines that need browser tools, or add `--with-deps` when supported Linux
  operating-system packages are also required.
- Run `folderforge doctor` after migration. A missing Chromium runtime is a
  warning when Playwright is disabled and a failure when the adapter is enabled.
- Windows shell execution now uses `cmd.exe /d /s /c` by default; PowerShell and
  POSIX shells use their native command switches. Existing explicit
  `terminal.shell` overrides remain supported.

## Configuration and state paths

- Current project state lives under `.folderforge/`.
- Persisted approvals live at `.folderforge/approvals.jsonl` unless
  `FOLDERFORGE_APPROVALS_PATH` is explicitly set.
- Legacy `.vibemcp` paths are not read as current configuration/state. Preserve
  old data separately before moving only the records you intentionally trust.

## Tool-surface changes

The audited candidate contains 269 native tools. Preset sizes are:

| Preset | Native tools |
| --- | ---: |
| `vibe` | 71 |
| `vibe-lite` | 50 |
| `readonly` | 42 |
| `full` | 269 |

`vibe-lite` intentionally does not force-add the workspace group. It pins the
workflow, agent, and browser capabilities while staying at the common 50-tool
client limit. Dynamic child/plugin tools may increase counts outside capped
presets.

## Approval behavior

- A `once` approval is bound to the exact tool and canonical arguments, is
  consumed by one retry, and cannot be replayed.
- A `session` approval lasts only for the current process. Persisted history is
  retained after restart, but session allowance is not re-armed.
- Clients with elicitation can approve inline. Other clients receive an
  `approvalId` for the dashboard/tool flow.

## Approval-state hardening

Approval JSONL remains backward-compatible. On load, legacy raw argument records
are fingerprinted, redacted, and atomically compacted. New records store a
canonical SHA-256 argument fingerprint plus redacted argument evidence; session
approvals still do not survive process restart.

## Local plugins

Local plugins remain an explicitly trusted-code feature. Manifest network and
filesystem permissions are review/audit metadata, not OS-enforced isolation.
Only enable packages whose source and prepared runtime you trust. New installs
and updates record a SHA-256 package-tree digest and reject later tampering, but
this is not a signature or publisher proof. Remote marketplace distribution,
verified publisher identity, signed provenance, and hard sandboxing are not part
of this candidate.

## Release verification

Contributors and release operators should run:

```bash
npm run release:check
```

The command validates source, tests, audits, build output, tarball installation,
CLI behavior, HTTP authentication, and MCP initialize/list/call behavior.
