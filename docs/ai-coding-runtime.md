# AI Coding Runtime

Milestone 1.8 adds a governed composition layer for the common AI development
loop. The five `agent` tools do not bypass FolderForge primitives, policy, audit,
or Git; they package project evidence into stable, typed MCP contracts.

## Workflow

```text
project_analyze
  -> code_context
  -> patch_transaction preview
  -> patch_transaction apply
  -> project_verify
  -> change_summary
  -> browser review when the task has UI
```

## Tools

### `project_analyze`

Returns languages, package managers, detected frameworks, commands, manifests,
configuration files, source/test roots, likely entrypoints, monorepo signals, and
Git state. The scan is read-only and bounded.

### `code_context`

Builds a BM25-ranked context pack from source, tests, documentation, and config.
The index is bounded to prevent an agent request from loading an entire large
repository into memory:

- 256 KB maximum per file;
- 4 MB aggregate indexed text;
- 48 KB indexed from any one file;
- 2,000 files and 30 returned results at the public schema boundary.

Denied paths are skipped and returned snippets pass through FolderForge secret
redaction. Results include related test files and hints for following up with
symbol/reference tools.

### `patch_transaction`

Supports `preview`, `apply`, `status`, and `rollback` for a bounded multi-file
text patch. A preview stores exact before/after snapshots and returns each diff as
an MCP `text/x-diff` resource.

Safety rules:

- maximum 25 files;
- maximum 256 KB before or after per file;
- maximum 2 MB aggregate snapshot budget;
- duplicate paths are rejected;
- apply refuses if a file no longer matches the preview's before state;
- rollback refuses if a file no longer matches the applied state;
- partial write failures are restored best-effort;
- `force=true` is HIGH risk and should be exceptional;
- transactions are in-memory, bounded, and expire after one hour.

Transactions intentionally do not survive server restart. Git is the durable
history layer; persisting stale rollback snapshots would be unsafe.

### `project_verify`

Plans or executes detected `typecheck`, `lint`, `test`, and `build` commands in a
fixed order. Every result contains the resolved command, exit code, duration,
redacted stdout/stderr, parsed diagnostics, and pass/fail state.

Only `dryRun:true` is LOW/read-only. Real project scripts are executable code and
remain MEDIUM/mutating even when the requested check is only lint or test.
Failure data is preserved in MCP text and `structuredContent`, so clients no
longer lose the evidence behind `isError:true`.

### `change_summary`

Returns Git branch/clean state, staged/unstaged/untracked/deleted/conflicted files,
numstat totals, suggested verification checks, and whether the tree is ready for
a commit. It never stages or commits files.

## Presets

The `agent` group is included in `vibe`, `vibe-lite`, `readonly`, `full`, and
`godot`. In `vibe-lite`, all five agent tools and all fifteen browser wrappers are
pinned under the 50-tool cap. Sixteen lower-value or superseded primitives are
removed by default so the advertised surface remains exactly 50.

Task routing adds:

- `implement` — all five agent tools plus focused read/search/symbol/diff tools;
- `fix_tests` — agent loop plus direct diagnostics and shell fallback;
- `run_ui` — complete browser and process lifecycle.

## MCP contracts

All five tools declare `outputSchema`. Spec-aware clients receive typed
`structuredContent`; text-only clients retain a JSON compatibility block.
`patch_transaction` additionally emits diff resources.

When a tool fails with structured data, FolderForge now keeps that data in a
second text block and in `structuredContent` instead of returning only a generic
error sentence.

## Live acceptance

A source-built HTTP MCP server was started against an independent temporary Git
project. The acceptance run verified:

- server version `1.6.0` and 254 native tools in the full preset;
- all five agent tools and their output schemas;
- React/Vite project analysis;
- BM25 context ranking `src/calc.ts` first with its related test;
- patch preview without mutation, apply, Git summary, and rollback;
- verification dry run;
- failing test returned MCP `isError:true`, exit code 2, stderr, parsed diagnostic,
  and `structuredContent`;
- audit recorded the verification failure as `tool_error`.

## Deferred work

Milestone 1.8 deliberately does not add autonomous planning or hidden multi-step
execution. Durable workflows, checkpoints, role-scoped tool views, and resumable
runs belong to Milestone 2.0 after the plugin lifecycle is stable.
