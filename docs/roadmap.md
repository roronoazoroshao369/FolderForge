# Roadmap

Release history and production-readiness roadmap for FolderForge.

## Current release-candidate track

The `2.0.0-rc.2` candidate is committed and pushed on `main`, tagged as
`v2.0.0-rc.2`, and published to npm under the `next` dist-tag. Release gates
require clean production and full dependency audits, typecheck, lint,
unit/integration tests, build, `npm pack`, tarball installation, CLI/stdio smoke,
authenticated HTTP MCP initialize/list/call/error-evidence smoke, and clean
registry-install validation. No stable `latest` promotion or hosted release has
been created.

## Done (2.0 RC Milestone B — doctor and preflight diagnostics)

- Added the read-only `folderforge doctor` command with stable human and JSON
  output, deterministic findings, and exit codes `0` (healthy/warnings), `1`
  (environment failure), and `2` (invalid invocation).
- Covers Node/npm/dependency/version consistency, workspace access, Git, config,
  ports, adapters, Playwright, plugins, approvals, audit logs, and workflow state.
- Doctor never creates `.folderforge`, downloads a browser, or repairs state.
- Unit and packed-tarball smoke coverage enforce the contract.

## Done (2.0 RC Milestone C — explicit browser setup and install safety)

- Removed the automatic Playwright Chromium `postinstall` download and the
  mutable `npx --yes playwright` execution path. Standard npm/global/npx install
  no longer downloads a browser.
- Added explicit `folderforge setup browser` with optional `--with-deps`, stable
  JSON evidence, and `--dry-run` for no-network CI/package verification.
- Setup invokes Node directly on the Playwright CLI resolved from the installed
  FolderForge dependency graph; no shell or package re-resolution is involved.
- Package smoke rejects a `postinstall`, installs the tarball in a temporary
  project, resolves the package-local CLI, runs doctor read-only, and confirms no
  runtime state is created.
- Verification: typecheck, lint, build, 342/342 tests across 44 files, both npm
  audits with zero vulnerabilities, package smoke, and authenticated HTTP smoke.

## Done (2.0 RC Milestone D — documentation and state synchronization)

- Synchronized README, roadmap, implementation log, changelog, migration guide,
  release process, compatibility guide, plugin trust boundary, and explicit
  browser setup instructions with repository state.
- Current status now distinguishes committed/pushed code on `main` from tags, npm
  publication, hosted releases, and stable release, none of which have occurred.
- Removed stale `release/commit pending`, `stabilization branch`, and
  `no commit or push` statements from current-status documentation while keeping
  explicitly historical verification records intact.

## In verification (2.0 RC Milestone E — compatibility matrix)

- Added a six-entry CI matrix: Ubuntu, macOS, and Windows on Node 22 and Node 24.
- Every entry runs typecheck, lint, tests, build, packed-tarball smoke, and
  authenticated HTTP MCP smoke; dependency audits run once on Ubuntu/Node 22.
- Replaced POSIX-only package scripts with platform-neutral Node helpers.
- Centralized shell invocation for cmd.exe, PowerShell, POSIX shells, and Git Bash;
  fixed managed processes, build tools, project verification, and Godot path
  quoting.
- Converted filesystem/process tests away from hard-coded `/tmp`, `/bin/bash`, and
  `sleep`.
- Added stdio MCP initialize/list/call smoke and tarball installation in paths with
  spaces and Unicode.
- Added deterministic coverage for Windows junction escapes, managed-process stop
  wakeups, unusable/read-only runtime state, and Chromium-missing degradation.
- GitHub Actions run `29159746609` made the matrix observable: Ubuntu on Node
  22/24 passed, while macOS and Windows on Node 22/24 failed during tests. The
  failures exposed macOS path aliasing plus Windows doctor, temp-path, shell,
  plugin-cleanup, and Git-timing assumptions.
- Run `29160360527` proved the macOS fixes on Node 22/24 and narrowed the
  remaining failures to Windows process-tree lifetime and `cmd.exe` quote
  handling. The second Windows fix terminates descendant trees synchronously and
  preserves quoted executables through `/s /c`.
- The corrected tree passes the complete local release gate: typecheck, lint,
  367/367 tests across 46 files, build, both zero-vulnerability audits, 96-file
  package smoke, stdio smoke, and authenticated HTTP smoke. A fresh six-entry
  Actions run remains the acceptance gate.

## Done (2.0 RC Milestone F — approval and plugin security hardening)

- Approval `once` uses exact tool + canonical-argument SHA-256 fingerprints, is
  consumed by one retry, executes the approved action, and creates a fresh
  request on any later retry. Approved unconsumed once requests survive restart;
  session allowances do not.
- Approval JSONL stores only recursively redacted argument evidence, remains mode
  `0600`, and audit/elicitation summaries use key-aware, regex, and entropy
  redaction.
- New plugin installs and updates record a deterministic SHA-256 package-tree
  digest. Inspect, adapter startup, and doctor reject post-install tampering;
  legacy records are reported as unverified.
- Plugin update rollback now covers valid replacement packages that fail child MCP
  activation, restoring the old package, registry record, risk map, and enabled
  facade.
- Integration coverage proves environment allowlisting, CRITICAL per-sub-tool risk
  enforcement before child execution, real once-approved file deletion, no-loop
  behavior, update rollback, and restart semantics.
- Trust review explicitly records: package digest enforced; lock/pinning
  evidence-only; publisher identity and signed provenance absent; permissions
  reviewable but not OS-enforced; no sandbox.
- Verification: typecheck, lint, build, 365/365 tests across 46 files, both npm
  audits with zero vulnerabilities, package smoke, stdio smoke, and authenticated
  HTTP smoke.

## Done (2.0 RC Milestone G — RC.2 release rehearsal and publication)

- Bumped package and lockfile metadata from `2.0.0-rc.1` to `2.0.0-rc.2`.
- Extended authenticated HTTP smoke with a deliberate non-zero `shell_exec` and
  asserted `isError`, `exitCode`, `stdout`, and `stderr` over the MCP wire.
- The exact RC.2 tree passed `npm run release:check`: typecheck, lint, 365/365
  tests, build, both audits with zero vulnerabilities, 95-file tarball smoke,
  stdio smoke, and authenticated HTTP success/error-evidence smoke. Package-content,
  version-consistency, Git, and security reviews also pass locally.
- Created and pushed annotated tag `v2.0.0-rc.2`, then published
  `@musashishao/folderforge@2.0.0-rc.2` under the npm `next` dist-tag.
- Installed `@next` into a clean temporary project whose path contained spaces and
  Unicode. The registry artifact passed package metadata/no-postinstall,
  CLI/version/help, browser setup dry-run, doctor human/JSON, stdio MCP, and
  authenticated HTTP MCP success/error-evidence validation.

## Blocked (2.0 RC Milestone H — stable release verdict)

- No `READY FOR 2.0 STABLE` verdict is issued until the second Windows-fix commit
  passes all six GitHub Actions jobs. Run `29160360527` already proves Ubuntu and
  macOS on Node 22/24; the corrected tree must now prove Windows on both Node
  lines without regressing those four jobs.
- RC.2 registry publication and clean-install validation are complete.
- A stable `2.0.0` version/tag and npm `latest` publish require observable CI
  success, a separate exact stable-version release gate, and an explicit final
  release decision.

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
  naming). Both `.trash/` and `**/.vibemcp/` are gitignored (never committed) and
  no longer present in the working tree; the previously pending manual delete
  (`rm -rf .trash tests/fixtures/sample-ts-project/.vibemcp`) is done.

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

## Done (1.5 - Godot integration complete, 149/149)

The full 1.5 Godot integration is delivered: the live registry contains exactly
**149/149 `game_*` tools**, matching the frozen surface in `schema-lock.ts` (the
`schema-lock.test.ts` guard is the source of truth). Verified green at 1.5.0:
typecheck, lint, `npm test` (29 files, 279 tests), and build. See
`docs/godot-mcp.md` for the per-step delivery record and session handoff.

- **Step 0 - `approval_approve` / `approval_deny`** - **Done** (see below).
- **Step 5d - remaining editor/scene helpers (7 tools)** - **Done.** Reaches
  **149/149**. Six headless CLI text edits (`game_load_sprite`,
  `game_export_mesh_library`, `game_manage_scene_signals`, `game_manage_shader`
  (CRITICAL), `game_manage_theme_resource`, `game_manage_resource`) plus the
  RUN-channel `game_locale`. All risk-classified, frozen in `schema-lock.ts`, and
  covered by the Step 5d suite in `tests/integration/game-ops.test.ts`.
- **Step 5c - project mgmt (PROC) + project/editor CLI tier (16 tools)** -
  **Done.** PROC channel launches the Godot binary
  through the shared `ProcessManager`: `game_run_project`, `game_launch_editor`,
  `game_stop_project`, `game_get_debug_output`, `game_export_project`. Headless
  CLI: `game_list_projects`, `game_save_scene`, `game_get_uid`,
  `game_update_project_uids`, `game_create_project` (CRITICAL),
  `game_manage_autoloads`, `game_manage_input_map`, `game_manage_export_presets`,
  `game_manage_layers`, `game_manage_plugins`, `game_manage_translations`. Wired
  through `risk.ts` + frozen `schema-lock.ts`, covered by
  `tests/integration/game-ops.test.ts`.
- **Step 5a/5b - advanced runtime + networking/3D/2D/rendering** - **Done.**
  Family 16 (23 tools), plus Families 18, 20, 21, 26.
- **Step 4 - runtime mutation + input tier** - **Done** (4a node/signals,
  4b input/anim/audio, 4c system/window + UI).
- **Step 3 - runtime bridge + runtime read tier** - **Done.**
- **Step 2 - headless edit tier (~13 tools)** - **Done.** Mutating `game_*`
  tools backed by `GodotCli` doing text-based edits on project files with the
  editor closed (project-root-guarded): `game_write_file`, `game_rename_file`,
  `game_create_directory`, `game_delete_file` (CRITICAL), `game_create_scene`,
  `game_add_node`, `game_remove_node`, `game_modify_node`, `game_attach_script`,
  `game_create_script` (CRITICAL), `game_create_resource`,
  `game_modify_project_settings`, `game_set_main_scene`. CRITICAL tools stay
  approval-gated even in danger mode. Wired through `risk.ts`, the frozen
  `schema-lock.ts`, and covered by `tests/integration/game-ops.test.ts`.
  Verification: typecheck, lint, `npm test` (29 files, 246 tests), and build all
  green.
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

## In progress (1.4.x - CLI policy override)

- **`--policy <mode>` flag** (alias `--policy-mode`): set the policy mode at
  startup (`readonly` | `safe` | `dev` | `danger`); the CLI value wins over the
  config file's `policy.defaultMode`. Invalid values are ignored with a warning.
  Wired in `src/main.ts` and documented in the README CLI table. Not yet
  version-tagged; tests/build green.

## Done (1.6 - MCP facade for large child servers)

A facade/gateway layer so a single child MCP server with 100+ tools (e.g. Godot,
149 tools) is reachable in full while consuming only ~2 tool slots on the agent
side - staying under the common ~50-tool client cap. Full design, option
comparison, ecosystem survey, and the step-by-step delivery plan live in
`docs/mcp-facade.md`.

- **Approach: Option B (`list_tools` + `call_tool`), opt-in per adapter.** A
  `facade: true` flag on the adapter def makes it emit a fixed
  `<adapter>__list_tools` / `<adapter>__call_tool` pair instead of N namespaced
  tools. `list_tools` returns paginated/filterable sub-tool descriptors (name,
  description, live `inputSchema`, risk); `call_tool` runs one sub-op. Unflagged
  adapters (Serena, Playwright) keep flat `<adapter>__<tool>` namespacing.
- **Governance-first:** `call_tool` never calls the child directly. It resolves
  the sub-op risk (per-adapter risk map; Godot uses the 149-tool bands from
  `docs/godot-mcp.md`, default `MEDIUM`/`mutates:true`) and re-enters the full
  policy / approval / elicitation / rate-limit / audit pipeline, keyed on the
  synthetic identity `<adapter>__call_tool:<subtool>`. CRITICAL sub-ops
  (`game_eval`) stay approval-gated; audit records the real sub-tool.
- **Schema-lock:** the two facade tools are native and frozen in
  `schema-lock.ts`; the fronted sub-tools stay dynamic/out-of-lock like today's
  adapter tools.
- **Confirmed decisions:** (1) sub-op key `<adapter>__call_tool:<subtool>`;
  (2) Godot risk map = `docs/godot-mcp.md` bands + `MEDIUM` fallback;
  (3) `list_tools` v1 = substring filtering; BM25 relevance ranking followed as a post-1.6 enhancement;
  (4) `tools/list_changed` dynamic surfacing out of scope for v1.
- **Delivery (9 slices):**
  - Step 0 - config surface (`facade?: boolean` on `AdapterDef`). **Done.**
  - Step 1 - child schema pass-through (`listTools()` returns `inputSchema`). **Done.**
  - Step 2 - sub-tool catalog cache per flagged adapter. **Done.**
  - Step 3 - per-adapter risk map (Godot bands + `MEDIUM` fallback). **Done.**
  - Step 4 - facade tool builder (`list_tools` + `call_tool`). **Done.**
  - Step 5 - governance re-entry keyed per sub-op. **Done.**
  - Step 6 - schema-lock review/contract handling for the two facade tools. **Done.**
  - Step 7 - integration tests (100+-tool fake child; CRITICAL sub-op gated). **Done.**
  - Step 8 - docs. **Done.**
- **Status:** implementation complete. Steps 0-8 landed in the July 1, 2026
  facade commits, with integration coverage confirming two-tool surfacing,
  dispatch, per-sub-op governance, approval gating, and audit identity. See
  `docs/mcp-facade.md` for the design record and implementation details.

### Post-1.6 enhancement - BM25 relevance ranking

- **Implemented, committed, and pushed on `main`; release pending.** Facade
  `list_tools` accepts an optional free-text `query`, ranks the substring-filtered
  catalog with dependency-free BM25 over tool names and descriptions (with tool
  names weighted higher), drops non-matching tools, returns a per-tool `score`,
  and sets `ranked: true`. Existing unranked catalog order, substring filtering,
  and pagination remain unchanged when `query` is omitted. Covered by unit and
  integration tests; the full typecheck/test/build suite is green (294/294 tests).

## Done (1.7 - browser intelligence foundation)

FolderForge can now support an end-to-end AI frontend workflow through its stable
`browser_*` wrappers: implement a page, run it locally, inspect semantic state,
exercise interactions, review console/network evidence, resize for responsive
layouts, and receive screenshots as MCP-native image content for vision review.

- **Vision-ready screenshots.** Child MCP `image` blocks are promoted into the
  parent `tools/call` response instead of being flattened into JSON text. The raw
  child result remains available internally, while promoted `data.content` is
  omitted from the compatibility summary so image base64 is not sent twice.
- **Correct child error semantics.** A child `isError:true` now becomes
  `ToolResult.ok:false`, MCP `isError:true`, and an audited `tool_error` event.
  This fixes false-success records for failed browser and generic child-adapter
  calls.
- **Responsive and richer capture primitives.** Added
  `browser_set_viewport` (Playwright `browser_resize`) and exposed screenshot
  inputs for PNG/JPEG, full-page, and snapshot-ref element capture.
- **Stable capped UI surface.** `vibe-lite` still advertises exactly 50 tools,
  includes all 10 browser wrappers, and pins the browser group so future catalog
  growth cannot silently evict UI-testing capabilities under cap pressure.
- **Concurrent session safety.** Default and generated Playwright adapter args
  include `--isolated`, preventing profile-lock collisions between simultaneous
  FolderForge instances and avoiding accidental browser-state leakage. Persistent
  state remains opt-in through a dedicated `--user-data-dir` override.
- **Architecture and delivery records.** See
  [`mcp-plugin-architecture.md`](./mcp-plugin-architecture.md),
  [`browser-agent-design.md`](./browser-agent-design.md),
  [`ai-agent-roadmap.md`](./ai-agent-roadmap.md), and
  [`implementation-log.md`](./implementation-log.md).
- **Live verification.** A source-built HTTP MCP server reported version `1.6.0`,
  advertised 249 native tools in the full preset, returned a valid top-level PNG
  screenshot at 390×844, preserved console/network/browser interaction behavior,
  propagated invalid navigation as an error, and recorded it as
  `tool_error`, `ok:false`.

## Done (1.9 - local MCP plugin ecosystem)

FolderForge can install and govern prepared local MCP packages through a validated manifest and hot lifecycle. Plugins use the existing child MCP facade, rich-result bridge, dynamic risk classification, policy, approval, rate limiting, and audit pipeline. Environment inheritance is disabled for installed plugins, only declared variables are passed, and enabled plugins survive restart. Remote marketplaces, signatures, provenance, and hard OS sandboxing remain explicitly deferred. See [`plugin-system.md`](./plugin-system.md).

## Done (2.0 - governed agent workflows)

FolderForge now persists role-scoped plans, executes every step through the existing tool governance pipeline, pauses/resumes at approval boundaries, avoids replaying successful work, and emits reproducible bounded reports across restart. This completes the initial browser → coding runtime → plugin ecosystem → workflow control-plane goal. See [`workflows.md`](./workflows.md).

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
