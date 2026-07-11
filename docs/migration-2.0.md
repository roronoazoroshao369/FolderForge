# Migrating to FolderForge 2.0

This document covers the `2.0.0-rc.1` candidate. The candidate is prepared
locally and has not been published.

## Runtime requirements

- Node.js 22 or newer is required.
- Rebuild or reinstall FolderForge after switching versions so the CLI and
  generated `dist/` match `package.json`.
- Confirm with `folderforge --version` before starting an MCP client.

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

## Local plugins

Local plugins remain an explicitly trusted-code feature. Manifest network and
filesystem permissions are review/audit metadata, not OS-enforced isolation.
Only enable packages whose source and prepared runtime you trust. Remote
marketplace distribution, signed provenance, and hard sandboxing are not part of
this candidate.

## Release verification

Contributors and release operators should run:

```bash
npm run release:check
```

The command validates source, tests, audits, build output, tarball installation,
CLI behavior, HTTP authentication, and MCP initialize/list/call behavior.
