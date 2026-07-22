# Changelog

All notable changes to FolderForge are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning.

## [Unreleased]

### Added

- Add a local Mission Control dashboard for active calls, authorized Workspace
  Capsule sessions, durable tasks, approvals, managed processes, isolations,
  Proof Pack counts, and recent governed activity.
- Add persistent integrity-checked write freeze with restart restoration,
  prior-policy-mode recovery, and dashboard containment actions for pause/cancel,
  stop/kill, and rollback/discard.
- Make `project_verify` a durable owner-bound pipeline with `plan/run/status/list`,
  explicit passed/failed/skipped/unavailable check states, cancellation, restart
  interruption recovery, Proof Pack propagation, and Mission Control summaries.
- Add owner/project/client-bound durable workflow tasks with objective, acceptance
  criteria, persistent pause/cancel, reconnect-safe resume, targeted one-time
  handoff, state integrity, optimistic revisions, and task-bound child audit and
  approval context.
- Add secret-redacted terminal-task Proof Packs with JSON/Markdown reports, diffs,
  approvals, task audit events, rollback checkpoint metadata, per-file hashes, and
  manifest verification.
- Add server-enforced Workspace Capsules with permission profiles, exact
  workspace/principal/client/session/task binding, expiry, revocation, budgets,
  atomic integrity-checked persistence, tool/group scopes, dashboard lifecycle
  endpoints, and agent-visible status.
- Add managed Git task worktrees with dirty-source preservation, reviewable diff,
  byte-level clean-source drift checks, pre-mutation apply journals, bounded
  tracked/untracked apply, restart-safe exact rollback, and operator-only
  apply/rollback/discard.

### Changed

- Bind once/session approvals to client, project, session, capsule, and task in
  addition to exact canonical arguments, while retaining raw principal identity
  for self-approval prevention.

### Security

- Override `@hono/node-server` to `2.0.11` and `fast-uri` to `3.1.4` so published installs avoid GHSA-frvp-7c67-39w9, GHSA-4c8g-83qw-93j6, and GHSA-v2hh-gcrm-f6hx while the MCP SDK v1 dependency ranges lag the patched releases.
- Keep raw tool arguments out of Mission Control active-call state and restrict
  write-freeze bypass to a server-generated dashboard role plus an exact
  containment allowlist; normal agents remain fully readonly and HIGH actions
  retain approval and audit requirements.
- Deny native agent access to verification state, integrity-check every run,
  bind reads to principal/project/OAuth client, block execution when evidence
  preflight fails, and return an uncertain-outcome error when post-run persistence
  fails.
- Deny native agent access to workflow and Proof Pack state, detect workflow state
  tampering and stale writers, serialize one-time claims with per-run locks, and
  preserve operator pause/cancel during in-flight child completion.
- Deny capsule/store and isolation metadata through native file policy, reject
  capsule path/symlink and cross-worktree escapes, reject tracked or untracked
  symlink task output, detect state corruption, and fail closed on all capsule
  command execution until process sandbox enforcement is connected.

## [2.7.0] - 2026-07-21

This is a locally prepared release candidate. It has not been tagged, published
to npm, or created as a hosted GitHub release.

### Added

- Add an exact-version and npm-integrity-pinned five-product child MCP
  compatibility matrix with isolated installation, bounded discovery, reviewed
  safe probes, dependency audits, and cross-platform CI artifacts.
- Add dynamic MCP tool-surface propagation from child adapters, routing changes,
  and hot plugin lifecycle operations to already-connected clients through
  `notifications/tools/list_changed`.
- Add portable comparative benchmark evidence bundles whose raw files are read and
  SHA-256 verified before a result can support a publication claim.
- Add resumable runtime-soak evidence with governed samples, planned child
  restarts, fsynced hash-chained JSONL, interruption recovery, tamper verification,
  CI smoke artifacts, and a maintained 24-hour execution profile.

### Changed

- Make plugin install, update, enable, disable, and uninstall catalog changes
  atomic. Failed activation retains the previous facade and emits no transient or
  false client catalog notification.
- Refresh the local governance baseline on the disclosed Node 22/Linux machine;
  all maintained thresholds now pass, including cold stdio initialize plus
  `tools/list`.

### Security

- Reject benchmark evidence paths that escape their result bundle and detect raw
  evidence modification before comparison.
- Retain validated direct-child wrappers when catalog rediscovery fails instead of
  replacing the public surface with malformed or partial metadata.

## [2.6.0] - 2026-07-21

This is a locally prepared release candidate. It has not been tagged, published
to npm, or created as a hosted GitHub release.

### Added

- Add explicit audit durability controls with `required` and `best-effort`
  baselines, plus default durable evidence for HIGH/CRITICAL operations and
  token- or OAuth-authenticated HTTP callers.
- Add startup audit preflight, private audit-file permissions, complete-write
  loops, `fsync` enforcement, restart detection for incomplete JSONL records,
  deterministic failure injection, and an eight-process concurrent-writer smoke
  test.
- Add evidence store v2 with monotonic sequences, previous-record hashes,
  canonical SHA-256 record hashes, optional Ed25519 signatures, strict offline
  verification, cross-process writer locking, and explicit non-destructive v1
  migration that does not claim historical integrity.
- Add release provenance inventory and immutable bundle tooling that verifies the
  annotated tag, commit, source version, packed package bytes, npm integrity,
  checksums, SBOM, notes, attestations, and hosted release assets without
  retroactively rewriting historical releases.
- Add explicit `init` profiles and safe client connection helpers for Cursor,
  VS Code, Claude Code, and generic stdio, plus a built-binary three-command
  onboarding smoke that proves ordinary startup does not create configuration.
- Add a deterministic five-profile child MCP compatibility corpus, an acyclic
  architecture/boundary checker, risk-weighted critical coverage gates, and a
  five-run governance microbenchmark with raw samples and disclosed hardware.
- Extract `GodotCli` and `GodotRuntime` into the independently buildable and
  packable `@folderforge/adapter-godot` candidate while retaining the existing
  root tool schema through a private transition import map.
- Add a public maturity/proof matrix that separates reproducible local evidence
  from third-party compatibility, independent reproduction, soak, beta, hosted
  marketplace, and active-active external gates.

### Changed

- Move configuration composition and the service container from `core` to
  `runtime`; replace broad container coupling with narrow registry, task, routing,
  evidence, and artifact interfaces; remove the late-bound `registry:any` field.
- Replace the duplicate-TypeScript `lint` command with ESLint at zero warnings,
  pin CI checkout/setup actions, and run architecture, evidence, compatibility,
  onboarding, package, and benchmark proof selectively by risk.
- Stop ordinary server startup from creating or overwriting project config.
  Dashboard startup is now an explicit configuration capability and `doctor`
  checks only transports and services that are actually enabled.

### Security

- Fail closed with `AUDIT_UNAVAILABLE` before governed execution when required
  call, policy, approval, or rate-limit evidence cannot be persisted. Return
  `AUDIT_OUTCOME_UNCERTAIN` after a handler starts if terminal evidence fails,
  explicitly preventing automatic retries of potentially mutating work.
- Preserve low-risk local stdio availability only under the explicit
  best-effort baseline; client-facing audit errors contain stable remediation
  codes without raw tool arguments or operating-system error details.
- Detect audit modification, deletion, insertion, reordering, partial records,
  and invalid known signatures; surface corrupt approval and task records instead
  of skipping them, and roll back approval state when durable persistence fails.
- Require annotated release tags and synchronized package-lock metadata; publish,
  attest, registry-check, and attach the exact same tarball generated by the
  reviewed release workflow.

## [2.5.0] - 2026-07-19

This is a locally prepared release candidate. It has not been tagged, published
to npm, or created as a hosted GitHub release.

### Added

- Add full MCP platform primitives alongside governed tools: bounded redacted
  `resources/list|read|subscribe`, maintained `prompts/list|get`, standard
  progress/cancellation propagation, and task-augmented `tools/call` with
  `tasks/get|list|cancel|result` plus status notifications.
- Add principal-bound durable MCP task records with redacted argument summaries,
  SHA-256 fingerprints, bounded results, TTL cleanup, cancellation, pagination,
  audit events, and explicit no-replay recovery after server restart.
- Add restrictive policy-as-code from project-scoped YAML with deny/approval-only
  effects, fail-closed schema validation, tool/risk/mutation/mode selectors, and
  RBAC selectors for principal, role, organization, team, project, and session.
- Add execution identity propagation across stdio, token, and OAuth sessions,
  including verified organization/role claims, stable project/session IDs, and
  end-to-end audit correlation without weakening approval bindings.
- Add a first-party Plugin SDK CLI with dependency-free templates, production
  manifest validation, real child-MCP handshake tests, deterministic packing,
  protected Ed25519 key generation, CycloneDX/provenance generation, marketplace
  scanning, and locally signed immutable package entries.
- Add a durable single-coordinator remote-worker runtime with AES-256-GCM job
  payloads, Ed25519 coordinator/worker identities, short-lived rotatable tokens,
  capability matching, leases, acknowledgements, heartbeats, monotonic fencing,
  cancellation, recovery, and explicit `idempotent`/`no-replay` behavior.
- Add a TLS-required non-loopback worker API and `folderforge worker init|run`
  CLI. Workers require an explicit tool allowlist, execute through their own
  FolderForge governance pipeline, transfer only lease-bound artifacts, redact
  bounded result artifacts, sign execution evidence, and reject control-plane
  recursion.
- Add a verified local marketplace with Ed25519 publisher trust and revocation,
  immutable signed versions, package/manifest/SBOM/provenance/source digests,
  bounded HTTPS/local index sync, local moderation, and disabled-only install.
- Add quarantine extraction and scans for traversal, symlinks/hardlinks/devices,
  archive and expanded-size abuse, lifecycle scripts, secrets, compatibility,
  manifest, SBOM, provenance, and exact package integrity.
- Add `browser_emulate`, `browser_emulation_status`, and `browser_flow_run` with
  Playwright device/viewport/user-agent profiles, loopback HTTP/HTTPS CONNECT
  shaping for offline/latency/bandwidth, governed fixed-action flows, and bounded
  per-step evidence without arbitrary JavaScript.
- Add a no-shell benchmark execution runner with clean fixture workdirs, timeout
  capture, minimal environment inheritance, explicit env allowlisting, bounded
  redacted logs, raw evidence SHA-256, and preservation of failed/malformed runs.
- Add a strict beta evidence schema, hashed participant/plugin identifiers,
  deduplicated mode-0600 intake, redacted notes, and a graduation report that
  cannot pass without real OS/client/plugin/cohort/security/documentation evidence.
- Extend `folderforge doctor` with read-only distributed coordinator schema/key-
  permission checks and marketplace trust/index consistency checks.

### Changed

- Expand the native surface to 308 tools: 288 agent-facing and 20 admin-only;
  `vibe-lite` remains capped at exactly 50 while pinning browser and process
  lifecycle groups.
- Export plugin manifest/integrity validators for marketplace quarantine while
  keeping install/enable as separate governed operations.
- Update ADR-0005 from deferred design to an implemented local reference runtime,
  while retaining explicit external gates for active-active fleets and public
  hosted marketplace claims.
- Add the maintained `tar` runtime dependency for safe deterministic package
  creation and bounded quarantine extraction.

### Security

- Require TLS for non-loopback worker control-plane binds; worker bearer tokens
  and private keys are never exposed to the agent tool plane.
- Block stale fencing tokens, automatic replay of acknowledged no-replay work,
  worker execution outside its allowlist, admin/control-plane recursion, unsigned
  marketplace entries, revoked publishers, immutable version conflicts, held or
  yanked entries, and installation before a passing quarantine record.
- Strip proxy/hop-by-hop credentials from emulated HTTP forwarding and avoid TLS
  interception; benchmark harnesses no longer inherit the complete host
  environment by default.

### Fixed

- Reject cancellation of terminal MCP tasks with the protocol-required invalid-
  params error and attach the standard related-task metadata to task results.
- Re-scan and verify quarantined plugin integrity immediately before marketplace
  installation, preventing post-scan tampering from bypassing quarantine.
- Bind distributed output artifacts to the exact active lease that uploaded them
  before accepting and coordinator-signing completion evidence.
- Resolve marketplace `file://` package URLs with Node's platform-native URL
  conversion so Windows drive-letter paths, spaces, and Unicode remain valid.
- Parse MCP Inspector resource payloads before comparing workspace paths, avoiding
  false Windows failures caused by JSON-escaped backslash separators.
- Persist and report lease-expiry recovery evidence from the same transaction
  instead of pre-recovering and returning an empty result.
- Ensure worker-side validation failures close the leased job as failed rather
  than leaving an orphaned lease.
- Preserve process lifecycle tools when the expanded browser surface is resolved
  under the 50-tool `vibe-lite` cap.

## [2.4.0] - 2026-07-19

This local release candidate was superseded by 2.5.0 and was not published to npm.

### Added

- Add coverage thresholds, property/fuzz suites, repeated child-MCP heartbeat
  stress, and official MCP Inspector stdio conformance to local and targeted CI
  release gates.
- Add a manual npm trusted-publishing workflow using GitHub OIDC, exact-tag
  verification, an exact packed tarball, CycloneDX SBOM generation, build/SBOM
  attestations, protected-environment review, and post-publish registry checks.
- Add optional digest-pinned Docker/Podman isolation for child MCP adapters and
  plugins with no automatic image pull, read-only root/plugin mounts, bounded
  workspace mounts, disabled-by-default network, dropped capabilities,
  no-new-privileges, PID/CPU/RAM/tmpfs limits, and doctor image readiness checks.
- Add a content-addressed artifact store with SHA-256 identities, atomic bounded
  storage, integrity verification, quotas, list/get/delete tools, and deterministic
  PNG comparison with optional diff artifacts.
- Persist browser screenshots as artifacts while preserving MCP-native image
  content, and add `browser_visual_compare` plus a fixed bounded
  `browser_accessibility_audit` for names, labels, language, headings, duplicate
  IDs, and approximate WCAG AA contrast checks.
- Add an immutable benchmark task/result protocol, real web-quality and sandbox
  fixtures, result validation/comparison scripts, external-beta intake templates,
  beta entry/exit criteria, and ADR-0005 gates for later distributed workers and
  a plugin marketplace.

### Changed

- Separate caller-visible pending child requests from internal heartbeat requests
  in transport metrics so heartbeat observation is deterministic without hiding
  internal liveness work.
- Keep `vibe-lite` at exactly 50 tools while pinning the expanded browser quality
  surface and preserving process lifecycle; lower-priority Git branch/checkout
  primitives remain available in broader presets or explicit configuration.
- Treat process-mode plugins as trusted local code and map declared plugin
  permissions to enforceable container runtime flags only when Docker/Podman mode
  is selected; invalid sandbox configuration fails closed instead of degrading to
  process mode.

### Fixed

- Remove the Node 22 heartbeat test race where metrics could be sampled while an
  internal ping was pending, and make initialize-timeout process-cleanup evidence
  wait for a deterministic child-start handshake rather than a scheduler sleep.
- Fix benchmark CLI argument resolution so file arrays do not pass callback
  indices into variadic `path.resolve`.

## [2.3.4] - 2026-07-19

This release publishes the child-MCP production hardening and cross-platform
release fixes prepared after the public `2.3.0` release. Versions `2.3.1` through
`2.3.3` were local preparation versions and were not published to npm.

### Added

- Add child-adapter lifecycle status and health evidence for state, PID, startup
  attempts, restart/failure counts, retry timing, failure disposition, uptime,
  observed availability, mean recovery time, failure histograms, and JSON-RPC
  transport counters.
- Add portable child-MCP safeguards for inbound/outbound JSON-RPC message size,
  unterminated stdout buffering, pending-request backpressure, idle heartbeats,
  bounded redacted stderr, and graceful-to-forced process-tree shutdown.
- Extend `folderforge doctor` readiness probes to every enabled child MCP adapter,
  including negotiated protocol, elapsed time, tool count, transport counters,
  classified disposition, and remediation evidence.

### Changed

- Single-flight concurrent lazy adapter starts, retry transient failures with
  exponential backoff and a circuit breaker, and allow one half-open recovery
  probe after cooldown.
- Mark configuration, protocol-compatibility, and resource-bound failures as
  `blocked` until the adapter definition is replaced or reloaded, avoiding
  unproductive respawn loops.
- Never automatically replay a failed `tools/call`; recovery applies only to a
  later request so uncertain side effects cannot be duplicated.
- Use the exact non-empty versioned changelog section as hosted release notes and
  reject dirty worktrees, tag/package mismatches, or tags that do not target the
  checked-out release commit before generating those notes.

### Fixed

- Classify facade sub-tools before OAuth and policy so each logical operation uses
  one governance pipeline with its real readonly/mutation contract, approval
  fingerprint, quota key, `policy_explain` result, and audit identity.
- Negotiate child MCP protocol versions against the installed official SDK instead
  of hard-coding the original protocol revision, while rejecting unsupported
  server selections before advertising child tools.
- Follow cursor-paginated child `tools/list` catalogs with cycle, page, and tool
  bounds, and invalidate cached catalogs only for capability-advertised
  `notifications/tools/list_changed` events.
- Isolate JSON-RPC request errors, timeouts, and cancellation so one failed child
  call no longer drains unrelated concurrent work; send cancellation notices and
  ignore late responses safely.
- Answer child-initiated ping requests, reject malformed protocol frames, drain
  pending work on real connection failure, and prevent stale child exit events
  from clobbering a restarted process.
- Make Playwright adapter regression tests platform-neutral by validating resolved
  package metadata and Node resolution semantics instead of Unix path substrings.
- Make packed-package browser smoke tolerate macOS canonical `/private/var` paths
  and npm hoisting while still proving the CLI comes from the installed
  `@playwright/mcp` dependency tree.
- Keep workflow approval/resume integration coverage deterministic on loaded
  Windows runners by using a lightweight governed read step instead of unrelated
  project-analysis subprocess work.

## [2.3.0] - 2026-07-18

### Added

- Add a shared ChatGPT lifecycle state machine for CLI and dashboard, covering
  Auth0, the resource server, local runtime, public endpoint, OAuth metadata,
  DCR client detection, login connections, user grants, authorize readiness,
  final user login, and authenticated MCP activity.
- Extend `folderforge connect chatgpt` into a one-command DCR lifecycle: capture a
  client baseline, wait for the new ChatGPT client, verify exact ChatGPT callback
  and Auth0 resource-log evidence, enable selected login connections, provision a
  per-client `subject_type=user` grant, and probe `/authorize` with PKCE S256.
- Add `--wait`, `--no-wait`, `--wait-timeout`, `--poll-interval`, and repeatable
  `--login-connection` controls without requiring a copied `tpc_*` client ID in
  the normal flow.
- Add persisted ChatGPT runtime profiles and CLI overrides: `--profile`,
  `--full-access`, `--policy`, `--tools-preset`, `--adapters`, dashboard controls,
  offline-access controls, DCR client policy, and `--force-config`.
- Add ChatGPT dashboard overall status, lifecycle timeline, diagnostics, repair
  actions, project/runtime configuration, and bounded redacted server/tunnel logs.
- Correlate authenticated MCP audit events with the exact verified OAuth client
  before reporting the lifecycle as `CONNECTED`.
- Add receipt schema version 2 with backward-compatible version 1 migration and
  non-secret lifecycle evidence for clients, connections, grants, authorize
  checks, diagnostics, and timestamps.
- Add regression coverage for delayed/new DCR clients, timeout, multiple matching
  clients, callback/resource mismatch, connection selection and repair, user-grant
  idempotency, no-connection and unauthorized-client errors, no-restart repair,
  dashboard consistency, exact-client connection evidence, and textual redaction.

### Changed

- Quick mode now checks and optionally enables the Auth0 DCR tenant flag, enables
  refresh-token support, and uses `user.require_client_grant` plus
  `client.deny_all` instead of broad third-party-client access.
- `chatgpt status` and `doctor` now verify the complete Auth0 and MCP lifecycle,
  not only process state and public metadata. Status checks show network progress,
  use bounded latency, distinguish unreachable public/Auth0 endpoints, and avoid
  duplicate lifecycle output.
- The ChatGPT dashboard now summarizes completed lifecycle checks, omits empty
  evidence rows, and uses 44px touch targets on narrow screens.
- `chatgpt repair --no-start` can repair Auth0 drift and verify an existing public
  endpoint without restarting the process serving the dashboard.
- `chatgpt start` and full `repair` preserve generated runtime settings; explicit
  start overrides rewrite the generated YAML and restart the managed server.
- A changed Cloudflare quick-tunnel URL no longer silently reuses the old ChatGPT
  client for a different resource/audience.

### Fixed

- Paginate Auth0 clients, connections, and client grants at the Management API
  maximum of 100 items per page instead of requesting the invalid
  `per_page=1000`, while still collecting tenants with more than 100 records.
- Persist the current tenant, issuer, server PID, metadata checks, and waiting
  lifecycle before blocking for ChatGPT DCR, so concurrent status checks do not
  read or overwrite a stale receipt from a previous connection attempt.
- Recover a unique recent ChatGPT DCR client from an exact Auth0 resource log even
  when an interrupted connection attempt already placed that client in the next
  baseline, instead of waiting forever for another newly created client.
- Configure selected Auth0 login connections as domain-level connections required
  by strict third-party DCR clients, replacing the unsupported
  `/connections/{id}/clients` flow that returned 404 before user grants were made.
- Treat Auth0's expected `login_required` response to the non-interactive
  `prompt=none` authorize probe as readiness instead of misclassifying its HTTP 400
  error page as a public-endpoint failure.
- Provision a scoped `subject_type=user` default grant with
  `default_for=third_party_clients` before exposing each DCR MCP URL, so every
  current or future ChatGPT `tpc_*` client can authorize the exact folder audience
  without a timing-dependent per-client repair.
- Check the dashboard port before starting the managed server and report the
  conflicting `--dashboard-port` directly instead of allowing an `EADDRINUSE`
  crash to surface later as an ambiguous `fetch failed` error.
- Detect Auth0 tenants that already have ten counted applications before waiting
  for DCR, surface the likely entity-limit failure instead of a generic timeout,
  and add `chatgpt prune-dcr` to preview or explicitly remove only stale duplicate
  ChatGPT clients while preserving successful, current-receipt, and latest-per-
  callback clients.
- Accept modern Auth0 resource evidence from consent `grantInfo.audience`, refresh
  token `requested_audience`, and revocation `audience` log fields instead of
  requiring the legacy `details.qs.resource` shape, preventing false
  `CLIENT_NOT_AUTHORIZED` results after a successful ChatGPT OAuth exchange.

### Security

- Automatic Auth0 mutations are limited to a safely matched ChatGPT DCR client:
  exact name, DCR metadata, public authorization-code behavior, bounded ChatGPT
  callbacks, connect-session boundary, and an exact Auth0 resource log.
- Only an explicitly selected login connection is promoted to Auth0 domain level,
  as required for third-party DCR clients. Quick-mode MCP authorization uses a
  `subject_type=user` default grant restricted to the exact folder audience and
  required scopes; secure predefined clients continue to use client-specific
  authorization. Multiple client matches fail closed; remote Auth0 resources are
  never deleted automatically.
- Extend CLI/dashboard redaction to bearer credentials, complete JWTs, common
  token/secret assignments, and API-key-shaped values.

## [2.2.3] - 2026-07-17

### Added

- Add regression coverage for the expanded ChatGPT lifecycle and Auth0 management flows.

### Changed

- Bump package and lockfile metadata to 2.2.3.

## [2.2.2] - 2026-07-16

### Fixed

- Fix Auth0 API provisioning for ChatGPT DCR by using the valid subject policy pair
  `user.allow_all` and `client.deny_all`; Auth0 rejects `client.allow_all`.
- Make the Auth0 CLI test double reject invalid client subject policies so this
  provisioning regression cannot silently return.

## [2.1.0] - 2026-07-15

### Added

- Add an explicit `none|token|oauth` HTTP authentication contract with CLI,
  environment, YAML defaults, conflict validation, and backward-compatible
  inference for existing token/API-key deployments.
- Add external authorization-server discovery, RFC 9728 protected-resource
  metadata, RFC 6750 challenges, PKCE S256 capability checks, cryptographic
  JWT/JWKS verification, resource audience binding, and read/write scope
  enforcement before tool execution.
- Add ChatGPT per-tool OAuth `securitySchemes`, tool-level
  `_meta["mcp/www_authenticate"]` step-up responses, deterministic OAuth protocol
  tests, JWKS rotation coverage, and packed-package OAuth startup smoke.
- Add `folderforge connect chatgpt` with guided quick/secure modes, active Auth0
  tenant discovery, issuer/PKCE/JWKS verification, idempotent API/scope
  provisioning, optional Cloudflare quick tunnel, public metadata/401 checks, and
  a secret-free connection receipt.
- Add `folderforge chatgpt status|doctor|repair|start|stop|disconnect`, dry-run,
  concurrent-operation locking, safe local cleanup, and preservation of remote
  Auth0 resources during disconnect.
- Add ADR-0004, a dedicated Auth0/ChatGPT connection guide,
  deployment/migration/security guidance, and a live ChatGPT Developer Mode
  acceptance checklist.

### Changed

- Non-loopback HTTP/dashboard startup now requires an explicitly configured
  credential instead of generating and logging one, preventing credential
  disclosure through startup logs.
- Add `jose` as a direct runtime dependency for maintained JWT/JWKS primitives.
- Sanitize inherited npm dry-run flags inside package smoke so
  `npm publish --dry-run` still builds and installs the real tarball before the
  publish simulation completes.

### Security

- Separate the agent-facing MCP tool plane from the approval/policy admin plane.
  Agents can no longer advertise or invoke `approval_approve`, `approval_deny`,
  or `policy_set_mode`, and MCP elicitation cannot self-resolve a request.
- Bind approvals to requester and approver principals, reject self-approval,
  expire pending requests, scope session allowances per requester, and preserve
  exact requester/tool/argument replay protection for one-shot approvals.
- Keep indirect agent surfaces aligned with the boundary: workspace routing only
  reports agent-visible tools, and persisted workflows reject admin-only tools
  during validation as well as execution.

## [2.0.0] - published 2026-07-12 under npm `latest`

This stable release promoted the validated `2.0.0-rc.2` line after the complete
local release gate and the Ubuntu/macOS/Windows × Node 22/24 GitHub Actions matrix
passed. npm `latest` resolves to `2.0.0`; a stable Git tag and hosted GitHub
release remain separate operator-controlled release actions.

### Fixed

- Canonicalize allowed and requested filesystem paths so macOS `/var` to
  `/private/var` aliases do not produce false workspace-escape failures while
  real symlink/junction escapes remain blocked.
- Make doctor npm probing, terminal failure fixtures, disposable temp-path
  classification, plugin cleanup, and Git integration timing portable on Windows.
- Preserve quoted executables through `cmd.exe /s /c`, disable Node's second-pass
  argv escaping for shared cmd callers, and terminate complete managed/child
  process trees on Windows so descendants cannot outlive their shell or keep
  temporary/plugin directories locked.
- Run the npm CLI and installed FolderForge `dist/main.js` directly through Node
  during package smoke while still requiring npm to create the expected bin shim;
  this avoids Windows wrapper quoting without weakening artifact validation.
- Replace fixed scheduler sleeps in process-stream exit tests with bounded
  observation of the real managed-process exit event, eliminating a loaded-runner
  race without changing runtime semantics.
- Use script-file execution for HTTP structured-error smoke and upgrade the CI
  checkout action to its Node 24-compatible release.

## [2.0.0-rc.2] - published 2026-07-11 under npm `next`

This release-candidate supersedes the internal RC.1 preparation and includes the
doctor, explicit browser setup, cross-platform compatibility work, approval
confidentiality, and plugin integrity/rollback hardening now committed on `main`.
It is tagged as `v2.0.0-rc.2` and published to npm under the `next` dist-tag. No
stable `latest` promotion or hosted release has been created.

### Changed

- Bumped package and lockfile metadata to `2.0.0-rc.2`.
- Extended authenticated HTTP release smoke to prove non-zero shell failures keep
  structured `exitCode`, `stdout`, and `stderr` evidence over MCP.
- Validated a clean install from the npm registry, including CLI/help,
  no-postinstall, browser setup dry-run, doctor, stdio MCP, and authenticated HTTP
  success/error-evidence smoke.
- Documented the remaining stable-release blocker: unobserved cross-platform
  GitHub Actions evidence.

## [2.0.0-rc.1] - candidate prepared 2026-07-11 (not published)

This candidate is committed and pushed on `main`. It has not been tagged,
published to npm, or released as a hosted artifact.

### Added

- **MCP facade for large child servers.** Added opt-in two-tool `list_tools` / `call_tool` surfacing so 100+ child tools remain reachable without exceeding common client tool caps.
- **Per-sub-tool governance for facade calls.** Each dispatched child operation re-enters policy, approval, rate-limit, and audit handling under its own synthetic identity.
- **BM25 relevance ranking for facade discovery.** `list_tools` now accepts `query`, ranks tool names and descriptions, and returns `ranked: true` with per-tool scores.
- **Vision-ready child MCP results.** Standard child `image`, text `resource`, and `resource_link` blocks are promoted into the parent MCP response; screenshot base64 is not duplicated in compatibility text.
- **Correct child error semantics.** Child `isError:true` now returns parent MCP `isError:true` and records `tool_error` instead of a false-success audit event.
- **Responsive browser testing.** Added `browser_set_viewport` and expanded `browser_screenshot` inputs for format, full-page, and element capture.
- **Concurrent browser isolation.** Generated/default Playwright adapter configuration now includes `--isolated` to avoid shared-profile lock collisions and cross-session state leakage.
- **Stable 50-tool UI surface.** `vibe-lite` keeps all 10 browser wrappers, pins workflow, agent, and browser groups under cap pressure, and removes superseded/lower-value primitives while preserving process lifecycle in exactly 50 tools.
- **Reliable Git installs.** Added an npm `prepare` build so installs from a Git repository regenerate the complete ignored `dist/` tree instead of depending on an incomplete set of legacy tracked artifacts.
- **AI coding runtime.** Added typed `project_analyze`, `code_context`, `patch_transaction`, `project_verify`, and `change_summary` tools for governed analyze→edit→verify loops.
- **Transactional edits.** Multi-file patch previews now enforce exact-state apply/rollback checks and return MCP diff resources.
- **Structured failure evidence.** Error responses preserve data/structuredContent, including verification exit codes, stdout/stderr, and parsed diagnostics.
- **Local MCP plugin lifecycle.** Added validated local manifests plus list/inspect/install/update/enable/disable/uninstall/health tools with hot facade registration and restart persistence.
- **Plugin environment isolation.** Installed child MCP servers receive only a minimal executable path and explicitly allowlisted environment variables instead of inheriting the complete parent environment.
- **Dynamic adapter registry.** Child adapters can be added, refreshed, and removed at runtime with manifest risk maps while continuing through the same policy, approval, rate-limit, rich-content, and audit pipeline.
- **Governed agent workflows.** Added persistent role-scoped workflows with dependencies, step references, expectations, checkpointed execution, cancellation, reports, and restart-safe non-replay.
- **Complete one-shot approvals.** Approved `once` requests now match exact canonical tool arguments, are consumed once, and allow paused workflows to resume without repeated approval prompts.
- **Bounded workflow evidence.** Checkpoints redact and cap tool evidence, persist image metadata instead of base64, reject detected secrets in definitions, and store atomically outside Git.
- **Self-hosting diagnostics.** Non-zero shell calls now expose a useful primary error plus typed stdout/stderr/exit data; exact patch failures return nearest-context and whitespace/line-ending diagnostics without fuzzy mutation.
- **Isolated test approvals.** Vitest uses temporary approval storage instead of accumulating state in repository fixtures.
- **Conservative temp cleanup.** A standalone cleanup of explicitly prefixed FolderForge temp roots is MEDIUM, while chained, wildcard, root/home/system, and non-prefixed targets remain blocked or approval-gated.
- **Plugin update availability.** Failed validation/copy before replacement restores the previous enabled plugin facade.
- **Executable release gates.** Added dependency audits, package/tarball install and CLI smoke checks, plus authenticated HTTP MCP initialize/list/call smoke checks to the release workflow.
- **Apache-2.0 license artifact.** Added the license file required by package metadata and enforced its presence in the packed tarball.
- **Read-only doctor command.** Added stable human/JSON installation, configuration, dependency, port, plugin, and state diagnostics with exit codes 0/1/2.
- **Explicit browser setup.** Added `folderforge setup browser`, including `--with-deps`, machine-readable output, and a no-download `--dry-run` mode that resolves the installed package-local Playwright CLI.
- **Cross-platform release matrix.** Added Ubuntu, macOS, and Windows CI coverage on Node 22 and Node 24, including tarball, stdio MCP, and authenticated HTTP smoke tests.
- **Path and degradation compatibility.** Added spaces/Unicode package and stdio paths, Windows junction escape coverage, process-stop wakeups, runtime permission diagnostics, and explicit missing-Chromium warn/fail contracts.
- **Approval confidentiality and exact retry matching.** Approval state now persists redacted arguments plus a canonical SHA-256 fingerprint, keeps mode `0600`, redacts audit/elicitation summaries, and preserves exact once/restart semantics.
- **Plugin package integrity.** New installs/updates record and verify a deterministic SHA-256 package-tree digest; doctor and adapter startup reject tampering.
- **Transactional plugin activation rollback.** Updates keep the old package/registry until the new facade loads, then restore the old enabled facade if activation fails.

### Fixed

- **Package-manager failure diagnostics.** Non-zero package/audit commands now keep exit code, stdout, and stderr while returning an actionable primary error.
- **Release dependency findings.** Upgraded the Vitest/Vite test toolchain to remove the full-audit high/critical advisories.
- **Install-time browser side effect.** Removed the automatic `postinstall` network download and mutable `npx --yes playwright` execution; browser setup is now explicit and package-local.
- **Windows shell and package scripts.** Replaced POSIX-only `chmod`/`rm -rf` lifecycle commands and stopped passing `-lc` to `cmd.exe`; shell, managed-process, verification, and Godot launch paths now use platform-specific invocation and quoting.
- **Release documentation drift.** Corrected approval persistence semantics, tool preset counts, and the explicit non-sandbox boundary of local plugins.

- **Godot bridge addon shipped (`addons/folderforge_bridge/`, wiring point #8).**
  The RUN-channel GDScript addon - the last unbuilt architectural piece of the
  1.5 Godot integration - is now in the tree: an `EditorPlugin` (`plugin.gd`)
  that registers a `FolderForgeBridge` autoload, and a runtime autoload
  (`runtime_bridge.gd`) that runs a loopback-only (`127.0.0.1:9090`)
  line-delimited JSON/TCP server inside the live game. It implements the full
  RUN-channel op set the TS adapter (`src/adapters/godot/runtime.ts`) speaks -
  liveness/`ping`, scene-tree/UI/node inspection, performance, logs/errors,
  `eval`, property/method/signal/group control, node spawn/remove/reparent,
  scene instantiate/change, screenshots, input injection, animation/audio,
  window/world settings, and `locale`. Port is overridable via the
  `FOLDERFORGE_RUNTIME_PORT` env var or the `folderforge/runtime_port` project
  setting. Every op is wrapped so a bad path or failed call returns
  `{ok:false,error}` instead of crashing the game; `eval` maps to the
  CRITICAL/approval-gated `game_eval` tool. Includes an install/protocol/security
  `README.md`. Requires Godot 4.2+. Verified end-to-end against a real Godot
  4.4.1 engine (headless): a 14-check smoke client exercised ping/liveness,
  scene-tree/UI/group/class inspection, performance, property round-trip,
  call_method, eval, get_node_info, os_info, spawn_node, and structured-error
  paths (unknown op, bad node path) - 14/14 passed. The smoke run surfaced and
  fixed a coroutine bug: `_handle_line` now `await`s `_dispatch` (which can
  suspend via `wait`/`await_signal`), so the autoload loads cleanly.

- **Godot integration Step 5d - remaining editor/scene helpers (`game_*`
  tools).** 7 new tools bring the surface to **149/149 - full parity with the
  149-tool reference (`tugcantopaloglu/godot-mcp`) reached.** All risk-classified,
  frozen in the schema lock, and covered by `tests/integration/game-ops.test.ts`
  (full suite green; typecheck, lint, test, build all pass):
  - **Family 2 - scene helpers.** `game_load_sprite` (HIGH; ensures a
    `Texture2D` ext_resource and sets the sprite property), `game_modify_scene_node`
    / `game_remove_scene_node` (HIGH; headless `.tscn` node edits),
    `game_manage_scene_signals` (HIGH; connect/disconnect/list in-scene signals).
  - **Family 26 / resources.** `game_export_mesh_library` (HIGH; writes a text
    MeshLibrary resource referencing the source scene - a deliberate offline
    approximation of editor baking), `game_manage_shader` (**CRITICAL**,
    approval-gated; writes `.gdshader` GPU code), `game_manage_theme_resource`
    and `game_manage_resource` (HIGH; `.tres` `[resource]`-block upserts via the
    shared `upsertResourceProperty` helper).
  - **Family 13 - localization.** `game_locale` (RUN channel; only Step 5d tool
    needing a live game, tested against the structured "no game running" path).

  All CLI tools are pure file edits (no Godot binary required). This completes
  the 1.5 Godot integration plan; see `docs/godot-mcp.md` Session Handoff for the
  release/next-step proposals (tag 1.5.0, ship the `folderforge_bridge` addon,
  real-engine smoke test).

- **Godot integration Step 5c - project management (PROC) + headless
  project/editor CLI tier (`game_*` tools).** 16 new tools bring the surface to
  **142/149**, all risk-classified, frozen in the schema lock, and covered by
  `tests/integration/game-ops.test.ts` (full suite 269 green; typecheck, lint,
  test, build all pass):
  - **Family 1 - project management (PROC channel).** `game_list_projects`
    (LOW), `game_run_project` / `game_launch_editor` / `game_stop_project`
    (MEDIUM), `game_get_debug_output` (LOW). Launch tools start the Godot binary
    through the shared `ProcessManager`, so output streams and they are governed
    like any other long-running process; stop/read reuse the process session id.
  - **Family 17 - build & export (PROC).** `game_export_project` (MEDIUM) runs a
    headless preset export as a managed process.
  - **Family 2 (writes) - scene save + UID.** `game_save_scene` (HIGH,
    validate-and-rewrite round-trip), `game_get_uid` (LOW, reads `uid://` from a
    text header), `game_update_project_uids` (HIGH, headless `--import`).
  - **Family 15 - project creation + config.** `game_create_project`
    (**CRITICAL**, approval-gated; bootstraps a valid `project.godot`),
    `game_manage_autoloads` / `game_manage_input_map` /
    `game_manage_export_presets` (HIGH).
  - **Family 24 - editor & project tools.** `game_manage_layers` /
    `game_manage_plugins` / `game_manage_translations` (HIGH), all
    `project.godot`-backed text edits.

  All CLI tools are pure file edits (no Godot binary required); PROC tools degrade
  to a normal process error when the binary is absent. Remaining to 149: a handful
  of editor/scene helpers (shader/scene-signals/theme management, `game_locale`,
  `game_load_sprite`, `game_export_mesh_library`, `game_modify_scene_node` /
  `game_remove_scene_node`).

### Added (earlier in Unreleased)

- **Godot integration Step 4 - runtime mutation + input tier (`game_*` tools).**
  46 new RUN-channel tools shipped in three green increments, all risk-classified,
  frozen in the schema lock, and covered by `tests/integration/game-ops.test.ts`
  (31 game tests; full suite 262 green):
  - **Step 4a - node manipulation + signals (12 tools).** Family 8:
    `game_get_property` (LOW), `game_set_property` (HIGH),
    `game_call_method` (CRITICAL), `game_instantiate_scene` /
    `game_remove_node` / `game_change_scene` / `game_reparent_node` (HIGH).
    Family 9: `game_connect_signal` / `game_disconnect_signal` /
    `game_emit_signal` (HIGH), `game_list_signals` / `game_await_signal` (LOW).
  - **Step 4b - input + animation + audio (20 tools).** Family 5 runtime input
    and Family 14 enhanced input (MEDIUM), Family 10 animation
    (`game_play_animation`, `game_tween_property`, MEDIUM), Family 22 advanced
    animation and Family 23 advanced audio (MEDIUM).
  - **Step 4c - system/window + UI controls (14 tools).** Family 19:
    `game_os_info` (LOW), `game_time_scale` (MEDIUM),
    `game_window` / `game_process_mode` / `game_world_settings` (HIGH),
    `game_script` (CRITICAL). Family 25 UI controls (`game_ui_control`,
    `game_ui_text`, `game_ui_popup`, `game_ui_tree`, `game_ui_item_list`,
    `game_ui_tabs`, `game_ui_menu`, `game_ui_range`, all MEDIUM).

  When no game is running, every tool returns a structured, actionable error.

- **Godot integration Step 3 - runtime bridge + runtime read tier (`game_*`
  tools).** A new RUN channel (`GodotRuntime`, `src/adapters/godot/runtime.ts`)
  talks to a GDScript runtime-bridge autoload inside the _live game_ over a
  line-delimited JSON TCP protocol (default :9090). Twelve `game_*` tools:
  - `game_runtime_status` (LOW) - probe whether a live game is reachable;
    returns `running: true/false` and never fails when the game is stopped.
  - `game_get_scene_tree`, `game_get_node_info`, `game_get_ui`,
    `game_get_performance`, `game_get_nodes_in_group`,
    `game_find_nodes_by_class`, `game_get_errors`, `game_get_logs` (LOW) -
    read-only introspection of the running game.
  - `game_pause` / `game_wait` (MEDIUM) - transiently perturb the live game.
  - `game_eval` (CRITICAL) - run arbitrary GDScript in the live process;
    approval-gated even in danger mode (Step 0).

  When no game is running, every tool returns a structured, actionable error.
  The surface is risk-classified, added to the frozen schema lock, and covered by
  `tests/integration/game-ops.test.ts` (Step 3 suite drives a fake TCP bridge).

- **Godot integration Step 2 - headless edit tier (`game_*` tools).** Mutating
  `game_*` tools backed by `GodotCli`, working directly on project files with the
  editor closed and project-root-guarded paths:
  - `game_create_directory` (MEDIUM) - create a `res://` directory tree.
  - `game_write_file` / `game_rename_file` (HIGH) - write or move a project file.
  - `game_delete_file` (CRITICAL) - remove a project file.
  - `game_create_scene` / `game_add_node` / `game_remove_node` /
    `game_modify_node` / `game_attach_script` (HIGH) - create and mutate `.tscn`
    scenes and their node trees.
  - `game_create_script` (CRITICAL) - create a new GDScript file.
  - `game_create_resource` / `game_modify_project_settings` /
    `game_set_main_scene` (HIGH) - create resources and edit `project.godot`.

  CRITICAL tools require an explicit approval (Step 0), even in danger mode. The
  new surface is risk-classified, added to the frozen schema lock, and covered by
  `tests/integration/game-ops.test.ts`.

- **Godot integration Step 1 - headless read tier (`game_*` tools).** A new
  `game` tool group with six LOW-risk, read-only tools backed by `GodotCli`
  (`src/adapters/godot/cli.ts`), the headless-CLI + file-parsing channel:
  - `game_get_godot_version` - probe `godot --headless --version`; reports
    `available: false` (not an error) when no binary is found.
  - `game_get_project_info` - parse `project.godot` (name, config version, main
    scene).
  - `game_read_scene` - parse a `.tscn` into its node tree + external resource
    references.
  - `game_read_project_settings` - raw `project.godot` plus its section list.
  - `game_list_project_files` - recursive `res://` listing, skipping
    `.git`/`.godot`/`.import` caches, with a coarse kind classification.
  - `game_read_file` - capped, project-root-guarded UTF-8 file read.

  These parse project files directly, so they work with the editor closed and
  even without Godot installed. New `adapters.godot` config block (`enabled`,
  `godotPath`, `editorPort`, `runtimePort`); the surface is risk-classified,
  added to the frozen schema lock, and registered with `game` in the `full`
  preset plus a new `godot` group preset. Covered by
  `tests/integration/game-ops.test.ts` (8 tests).

- **`approval_approve` / `approval_deny` tools** to resolve a pending approval
  request directly over the MCP tool channel. `approval_approve` takes an `id`
  and an optional `scope` (`once` | `session`); `approval_deny` takes an `id`.
  This unblocks HIGH/CRITICAL tool calls when the dashboard is disabled
  (`--no-dashboard`) and the client cannot elicit - the prerequisite (Godot
  integration Step 0) before any CRITICAL `game_*` tool can ship. Both are LOW
  risk, recorded in the schema lock and audit log, and covered by
  `tests/integration/approval-ops.test.ts`.
- **`--policy <mode>` CLI flag** (alias `--policy-mode`) to set the policy mode at
  startup: `readonly` | `safe` | `dev` | `danger`. The CLI value wins over the
  config file's `policy.defaultMode`. Invalid values are ignored with a warning
  and the configured mode is kept. Documented in the README CLI table.

## [1.4.2] - 2026-06-28

### Changed

- Pin the Playwright child-MCP adapter to a specific version (`@playwright/mcp@0.0.41`)
  instead of a floating tag, for reproducible browser-automation installs.

## [1.4.1] - 2026-06-28

### Changed

- Config-file handling now writes the auto-generated `config.yaml` on first run
  (refinement of the 1.4.0 zero-config behavior).

## [1.4.0] - 2026-06-28

### Added

- **Zero-config first run.** When no config is found in any discovery location,
  FolderForge writes a complete, batteries-included `folderforge.yaml` next to
  the project and loads it immediately (`policy.defaultMode: dev`,
  `tools.preset: vibe-lite`, and `adapters.playwright.enabled: true` so the
  `browser_*` tools work out of the box). Existing config files are never
  overwritten; `--config <file>` skips auto-generation; a failed write is
  non-fatal and falls back to built-in defaults.

## [1.3.3] - 2026-06-27

### Added

- **Interactive approval via MCP elicitation** with dashboard fallback. High-risk
  tool calls (e.g. `git_commit`, `file_delete`) prompt for approval directly in
  the chat when the client advertises the `elicitation` capability, falling back
  to the dashboard flow otherwise.
- **`ToolContentBlock` content blocks** (`text | resource | resource_link`) on
  `ToolResult`, with `git_diff` attaching the raw diff as an embedded
  `text/x-diff` resource.

---

For the full pre-1.3.3 history (1.0 hardening, 1.2 MCP protocol features and agent
ergonomics, and the 0.1-0.3 foundations), see `docs/roadmap.md`.
