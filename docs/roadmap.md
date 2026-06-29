# Roadmap

Status of FolderForge toward a stable 1.0.

## Done (0.1)

- Core config loader with YAML merge and path normalization.
- Dependency container and workspace activation.
- Policy engine: path, command, and secret policies + risk model.
- Approval queue (once/session scopes).
- Append-only JSONL audit log + ring buffer.
- Full native tool catalog (files, search, terminal, processes, git, build,
  code, memory, security, db).
- Native structural code search (`search_ast`) - regex-backed declaration finder,
  no language server required.
- Task-preset routing exposed as a tool (`workspace_route`): switch the visible
  tool set to `explore` / `run_ui` / `fix_tests`, or reset to all.
- MCP server with `tools/list` / `tools/call` handlers.
- stdio and Streamable HTTP transports.
- Local dashboard (`/status`, `/audit`, `/processes`, `/approvals`).
- New `main.ts` entrypoint with arg parsing.

## Done (0.2)

- Child-MCP adapters wired end-to-end (Serena, Playwright, Desktop Commander) with tool namespacing (`serena__<tool>`).
- Persisted approvals across restarts (stored under `.folderforge/approvals.jsonl`).
- Dashboard auth token for non-loopback binds.
- Integration tests against the sample fixtures (registry pipeline, policy
  enforcement, and child-MCP adapter discovery via a fake stdio MCP server).

## Done (0.3)

- Policy "explain" tool (`policy_explain`): dry-run a call and return the
  decision + reasoning.
- Streaming tool results for long-running commands: `process_tail` long-polls a
  process session, blocking until new output or exit (backed by
  `ProcessManager.readUntil`).
- Per-tool rate limits and quotas: sliding-window + rolling daily quota
  (`RateLimiter`), enforced in the tool pipeline and surfaced via
  `policy_ratelimits`; denied/approval-gated calls don't consume quota.
- Multi-project sessions: activate more than one workspace at once, switch the
  current one (`workspace_list`, `workspace_switch`, `workspace_deactivate`),
  with isolated memory stores per project.
- Pluggable secret scanners: Shannon-entropy detection flags bespoke
  high-entropy tokens that no regex rule matches (configurable via
  `secretScan`).

## Done (1.0 hardening)

- Documented config surface with validation errors (`validateConfig` throws a
  single aggregated, human-readable error).
- Hardened HTTP transport: bearer-token auth (constant-time), CORS allowlist +
  preflight, and idle session expiry (`sessionTtlMs`).

## Done (1.0)

- Frozen tool schema: the public native tool surface (names + `mutates`/`risk`
  contract) is locked in `src/tools/schema-lock.ts`. A guard test
  (`tests/unit/schema-lock.test.ts`) fails CI if the live registry diverges, so
  accidental renames, removals, or risk reclassifications are caught before
  release. Renaming/removing a tool is now an explicit, major-version change.
- Full policy-pipeline coverage: `tests/unit/policy-pipeline.test.ts` exercises
  the end-to-end `registry.call()` path through all four modes (readonly / safe
  / dev / danger) - risk classification, mode gating, approval creation,
  once-vs-session scope, the no-quota-on-denied/gated-calls guarantee, and audit
  event recording - composed with the existing per-policy unit suites.

## 1.0 criteria

- [x] Documented config surface with validation errors.
- [x] Hardened HTTP transport (auth, CORS, session expiry).
- [x] Stable tool schema (no breaking renames) - frozen in
  `src/tools/schema-lock.ts` and CI-guarded.
- [x] Full unit + integration coverage for the policy pipeline - per-policy unit
  suites (rate limiter, entropy scanner, config validation, HTTP hardening,
  command/path/secret policy) plus an end-to-end pipeline suite and multi-project
  flows.

**1.0 is complete: all four release criteria are met.**

## Done (1.2 - MCP protocol features)

These extend the server's MCP conformance beyond `tools/list` + `tools/call`.
They are wired through a single per-call `ToolCallControl` object
(`src/core/types.ts`) injected by the `tools/call` request handler
(`src/server/mcp-server.ts`) and threaded into every tool via `ToolContext.control`.
This adds **zero** new entries to the frozen tool surface, so the schema-lock is
untouched.

- **P4 - progress notifications.** When the client sends a `progressToken` in
  the request `_meta`, `control.reportProgress(progress, total?, message?)`
  emits `notifications/progress`. Consumers: `process_tail` reports a tick each
  long-poll cycle (cursor as progress, status as message), and `git_push`
  brackets the network call with a start/complete tick. Handlers without a token
  see `reportProgress === undefined` and no-op.
- **P6 - cancellation.** `control.signal` mirrors the SDK's per-request
  `AbortSignal` (aborted on `notifications/cancelled`). `registry.call()`
  refuses pre-cancelled calls early; `ProcessManager.readUntil(signal)` wakes
  immediately on abort instead of blocking out the full `timeoutMs`, so a
  cancelled tail returns at once with `cancelled: true`.
- **P8 - elicitation.** `control.elicitInput(params)` is present only when the
  client advertised the `elicitation` capability (checked via
  `server.getClientCapabilities()`); otherwise it is `undefined` and handlers
  fall back to non-interactive defaults. Two destructive native tools now elicit
  an interactive confirmation before acting: `git_reset` (unstaging),
  `git_push` (publishing commits to a shared remote), and `git_pull` (integrating
  remote changes into the working tree). Clients without the
  capability proceed non-interactively, still gated by policy/approval upstream.

Verification status: typechecked logic reviewed manually; unit tests cover
control propagation + early-cancel + progress emit
(`tests/unit/tool-control.test.ts`) and signal-driven wakeup
(`tests/unit/process-stream.test.ts`); integration tests cover the `git_reset`
and `git_push` elicitation accept/decline/no-capability paths end-to-end against
throwaway repos (`tests/integration/git-ops.test.ts`). Run
`npm run typecheck && npm test` in the repo (with `node_modules` installed)
before tagging 1.2.

## Housekeeping

- Removed stale pre-rename artifacts from the working tree (legacy "vibemcp"
  naming). The leftover approval log was renamed
  `.trash/vibemcp-approvals.jsonl.removed` -> `.trash/legacy-approvals.removed`.
  Both `.trash/` and `**/.vibemcp/` are already gitignored (never committed).
- Still pending a manual delete (the empty fixture dir cannot be removed via the
  filesystem tooling): run
  `rm -rf .trash tests/fixtures/sample-ts-project/.vibemcp`.

## Done (1.3.3 - Interactive approval UI via elicitation + embedded resources)

Closes the UX gap where AI clients got stuck on high-risk tool calls (e.g.
`git_commit`, `file_delete`) when the dashboard was disabled (`--no-dashboard`).

- **Elicitation-based approval flow.** `registry.call()` now checks
  `control.elicitInput` before falling back to the dashboard. When the MCP
  client advertises the `elicitation` capability, the approval prompt appears
  **directly in the chat** with two fields: `approve` (bool) and `scope`
  (`once` | `session`). An approved+session result is written into
  `ApprovalEngine.sessionAllowed` so the tool runs without further prompts for
  the rest of the session. Decline / cancel / `approve:false` → immediate deny
  with a clear error.
- **Fallback parity.** When `elicitInput` is absent or throws (transport
  closed, unsupported client), the existing dashboard flow is invoked unchanged,
  preserving the `approvalId` + redirect message. No regressions for headless
  setups.
- **`ToolContentBlock` type system.** `ToolResult` grows an optional `content`
  array of typed blocks (`text | resource | resource_link`). `toCallToolResult`
  in `mcp-server.ts` maps them to MCP content items; the text block is always
  emitted first to stay backwards-compatible with clients that only read the
  first content item.
- **`git_diff` embedded resource.** `git_diff` attaches the raw diff as an
  embedded `text/x-diff` resource block so clients with a diff-viewer capability
  can render it natively instead of as a plain text wall.
- 8 new unit tests (`tests/unit/elicit-approval.test.ts`) cover:
  elicitation-approve, elicitation-deny, elicitation-cancel → fallback,
  elicitation-error → fallback, no-elicitation → dashboard fallback, session
  scope, content-block mapping (text+resource), and resource_link blocks.
  All 225 tests pass.

## Done (1.4 - zero-config + ergonomics)

- **1.4.0 - Zero-config first run.** When no config is found in any discovery
  location, FolderForge writes a complete, batteries-included `folderforge.yaml`
  next to the project and loads it immediately (`policy.defaultMode: dev`,
  `tools.preset: vibe-lite`, `adapters.playwright.enabled: true`). Existing
  config files are never overwritten; `--config <file>` skips auto-generation; a
  failed write is non-fatal and falls back to built-in defaults.
- **1.4.1 - Config-file handling** writes the auto-generated `config.yaml` on
  first run (refinement of the 1.4.0 behavior).
- **1.4.2 - Playwright adapter pin.** The Playwright child-MCP adapter is pinned
  to `@playwright/mcp@0.0.41` for reproducible browser-automation installs.

Verification status: `npm run typecheck`, `npm run lint`, `npm run build`, and
`npm test` (27 files, 225 tests) all green at 1.4.2.

## In progress (1.5 - Godot Step 1 shipped, Step 2 next)

- **Step 0 - `approval_approve` / `approval_deny`** - **Done** (see below).
- **Step 1 - adapter + headless read tier** - **Done.** New `GodotCli`
  (`src/adapters/godot/cli.ts`) is the CLI/file-read channel; six read-only
  `game_*` tools route through it (`src/tools/game-tools.ts`, group `game`):
  `game_get_godot_version`, `game_get_project_info`, `game_read_scene`,
  `game_read_project_settings`, `game_list_project_files`, `game_read_file`. All
  LOW risk. They parse Godot project files directly, so the file reads work even
  without a Godot binary installed; the engine probe degrades to
  `available: false` instead of failing. Wired through config
  (`adapters.godot` + `GodotConfig`), `risk.ts`, the frozen `schema-lock.ts`,
  and `index.ts` (`game` added to the `full` preset + a new `godot` preset).
  Covered by `tests/integration/game-ops.test.ts` (8 tests). Verification:
  typecheck, lint, `npm test` (29 files, 239 tests), and build all green.
- **Step 2 - headless edit tier (~35 tools)** - next.

## In progress (1.4.x - CLI policy override)

- **`--policy <mode>` flag** (alias `--policy-mode`): set the policy mode at
  startup (`readonly` | `safe` | `dev` | `danger`); the CLI value wins over the
  config file's `policy.defaultMode`. Invalid values are ignored with a warning.
  Wired in `src/main.ts` and documented in the README CLI table. Not yet
  version-tagged; tests/build green.

## Planned (1.5 - Godot game engine integration)

A new `game` tool group integrating the Godot 4.x engine, covering both
edit-time and runtime control, routed through the existing policy / approval /
audit pipeline. Full design, the complete tool map, wiring points, and the
step-by-step delivery plan live in `docs/godot-mcp.md`.

- **Coverage target: 149/149.** Full parity with the most complete open-source
  Godot MCP today (`tugcantopaloglu/godot-mcp`, 149 tools across 26 families).
  Every reference tool maps 1:1 to a FolderForge `game_*` equivalent so an agent
  can vibe-code a whole game; FolderForge then exceeds the baseline by adding the
  governance layer it lacks.
- **Differentiator:** governance-first - destructive/runtime-mutating ops
  (`game_eval`, `game_call_method`, `game_delete_file`, networking,
  `game_create_project`, runtime script attach) are CRITICAL and gated through
  the approval queue; HIGH ops (scene/project/node edits) are approval-gated
  outside `dev`/`danger`; every engine op is audited. No other Godot MCP offers
  this.
- **Architecture:** TS adapter (`src/adapters/godot/`) with three channels - a
  headless-CLI runner (`godot --headless`) for editor-less edits, a WebSocket
  client to a GDScript editor addon (`addons/folderforge_bridge/`), and a TCP
  autoload bridge for the running game.
- **Delivery (sliced to 149):**
  - Step 0 - `approval_approve` / `approval_deny` tools (unblock CRITICAL approval
    over the MCP channel when `--no-dashboard` and no elicitation). **Done** -
    LOW-risk tools in `src/tools/security-tools.ts`, registered in `risk.ts` +
    `schema-lock.ts`, covered by `tests/integration/approval-ops.test.ts`.
  - Step 1 - adapter + headless read tier (~25 tools). **Next.**
  - Step 2 - headless edit tier (~35 tools).
  - Step 3 - runtime bridge + runtime read tier (~20 tools).
  - Step 4 - runtime mutation + input tier (~35 tools).
  - Step 5 - advanced runtime + rendering tier (~34 tools).
- **Status:** planning complete; the full 149-tool surface is mapped to risk
  bands + channels; no code started. See `docs/godot-mcp.md` for the per-family
  tool map, live status table, and open decisions.

## Next (post-1.0 ideas)

- Distributed/shared rate limiting for multi-instance deployments.
- Streaming over the MCP transport itself (incremental tool results) once the
  protocol stabilizes that path.
- Expanded file/git/db integration tests (Q8) - broaden coverage beyond the
  current unit suites to full `registry.call()` flows against the sample
  fixtures.
- Wire P8 elicitation into a real consumer (interactive confirmation for
  destructive db/git operations). **Done in 1.2** for `git_reset` and
  `git_push`; db tools remain read-only so there is no destructive db consumer
  to wire.

## Done (1.2 - agent ergonomics)

Rounded out the tool surface so an agent can comfortably explore, edit, run, and
manage source control without falling back to raw `shell_exec`. All additions are
backwards-compatible (new tools only) and synchronized across the risk map
(`src/policy/risk.ts`), the frozen schema lock (`src/tools/schema-lock.ts`), and
the integration suites.

- **Git convenience tools.**
  - `git_fetch` (MEDIUM, `openWorldHint`) - update remote-tracking refs only,
    never touches the working tree; emits progress.
  - `git_pull` (HIGH, `openWorldHint`) - merge or `--rebase` remote changes into
    the current branch, with an elicitation confirmation (warns on a dirty tree)
    and progress reporting.
  - `git_stash` (MEDIUM) - `op`: `push` (default) | `pop` | `apply` | `list` |
    `drop`. Deliberately omits `clear` to avoid irreversible data loss.
- **File convenience tools.**
  - `file_move` (MEDIUM) - rename/relocate a file or directory; both endpoints
    boundary-checked, refuses to clobber unless `overwrite=true`.
  - `file_copy` (MEDIUM) - copy a file or directory (recursive); same overwrite
    guard.
  - `list_directory` (LOW) - enumerate a directory (optional recursion + entry
    cap), skipping anything the path policy denies (secrets, `node_modules`,
    `.git` internals).

Verification: `npm run typecheck && npm test && npm run build` all green
(26 test files, 215 tests). New behavior is covered in
`tests/integration/file-ops.test.ts` (list flat/recursive, move + overwrite +
escape guard, file/dir copy) and `tests/integration/git-ops.test.ts` (stash
push/list/pop, fetch+pull against a bare remote, pull cancellation on declined
elicitation).
