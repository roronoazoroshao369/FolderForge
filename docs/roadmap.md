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
  an interactive confirmation before acting: `git_reset` (unstaging) and
  `git_push` (publishing commits to a shared remote). Clients without the
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
