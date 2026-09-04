# Adaptive tool surface (`--tools-preset adaptive`)

The adaptive surface is FolderForge's answer to tool-list token bloat (the
webcodex `adaptive_runtime` pattern applied to the native registry): instead of
advertising the full catalog to every client, `tools/list` exposes only a small
typed coding core plus two meta tools — a governed gateway and a manifest.

## Usage

```bash
folderforge --project . --stdio --tools-preset adaptive
# or for a fleet instance / the control plane:
folderforge control start            # then pick the `adaptive` preset per instance
```

`adaptive` is also a valid fleet tools preset (`FLEET_TOOLS_PRESETS`) and is
offered in the Mission Control Fleet dropdown.

At runtime an agent can route itself onto the adaptive surface without a
restart: `workspace_route({ preset: "adaptive" })` switches the visible set to
the same core + gateway (keeping the recovery tools visible), and
`workspace_route({ reset: true })` (or `preset: "all"`) restores everything.

## What `tools/list` advertises

- The typed core (~25 tools): workspace status/health/activate, file
  read/read-many/write/edit-block, list_directory, search_text/search_files,
  shell_exec, the process lifecycle tools, git status/diff/log/add/commit/
  branch/checkout, and run_test/run_lint/run_typecheck/run_build.
- `tool_manifest` — describe one tool: description, input schema, annotations,
  group, frozen risk/mutates, output-schema presence, and `availability`:
  `direct` (listed), `gateway` (callable only through the gateway), or
  `unavailable` (unknown or admin-only). Routing metadata, not authorization.
- `call_runtime_tool` — the gateway to every other registered agent-facing
  tool (including child-adapter wrappers): `{ name, arguments }`.

## Governance: one pipeline, keyed as the target

The gateway is NOT a governance bypass. `call_runtime_tool`'s `classifyCall`
delegates to the target tool's own classification — including dynamic
re-classification such as `shell_exec`'s minimum HIGH — so the single policy +
capsule + OAuth-scope + approval + rate-limit + audit pipeline runs exactly as
a direct call to that target, and the audit trail is keyed with the target's
name. The handler then invokes the target handler directly; there is no nested
second pipeline, so no double approvals or double rate-limit charges.

Refusals are fail-closed: unknown names, admin-only tools, and the gateway pair
itself (recursion) are rejected with an actionable error pointing at
`tool_manifest`.

The gateway's static listing envelope is deliberately read-only
(`mutates: false`) so scope-filtered listings keep it visible to read-only
OAuth principals; the concrete call is always re-classified before governance,
which remains the authoritative gate.

## OAuth scope-filtered listing

When the adaptive surface is active (`hideScopeInsufficientTools`, set by
`main.ts` for the `adaptive` preset only), `tools/list` additionally hides
tools whose required OAuth scopes are absent from the principal: read-only
tools need the read scope, mutating tools need read + write. Other presets are
unchanged — they keep annotating `securitySchemes` without hiding.

## Measured token overhead

Measured by `tests/integration/adaptive-surface.test.ts` on this repository's
default registry (serialized `tools/list` payload):

| Surface | Tools | Bytes | Saving |
| --- | --- | --- | --- |
| Unrouted (full registry) | 321 | 152,924 | — |
| `adaptive`, read-only OAuth principal | 19 | 11,417 | **~92.5%** |

A principal holding the write scope sees the mutating core tools as well
(~27 tools), still an order of magnitude below the full catalog. Long-tail
tools cost one `tool_manifest` lookup each when needed.
