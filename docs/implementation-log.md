# Implementation Log

> **Status:** Historical implementation log. This file is not the current product, release, or compatibility contract. See [the documentation index](README.md).


This log records product defects and developer-experience issues observed while
using FolderForge itself to implement the AI/browser roadmap.

## P0 — Authorization boundary

### FF-040 — Agent could self-approve and elevate runtime policy

- Severity: critical
- Status: fixed in working tree; full local release gate passed
- Root cause: approval resolution and `policy_set_mode` shared the agent-facing
  MCP registry, and MCP elicitation could resolve the request created by the same
  caller. Approval records had no principal identity or expiry.
- Fix: introduced agent/admin tool audiences and principal propagation; MCP and
  workflows use the agent-only boundary; dashboard resolves approvals and changes
  policy as the admin plane. Requests now record requester/approver identity and
  expiry; once/session allowances are principal-bound; self-approval and expired
  resolution fail closed. Workspace routing reports only agent-visible tools, and
  workflow validation rejects admin-only tools before persistence.
- Regression coverage: agent tool advertisement/call denial, workspace-route
  metadata isolation, workflow admin-tool rejection, self-approval, distinct-admin
  approval, expiry, cross-principal session reuse, wrong arguments, one-shot replay,
  stable credential principal identity, and dashboard admin HTTP behavior.
- Release state: included in the local `2.1.0` preparation committed and merged
  into `main`. Push, Git tag, npm publication, and hosted release remain
  operator-controlled and were not performed here.


### FF-041 — Permission labels were not bound to a server-owned workspace capsule

- Severity: critical for remote autonomous use
- Status: fixed and locally verified
- Root cause: policy, identity, approvals, and workflow state existed separately;
  no object bound workspace root, client/session, profile, expiry, revocation,
  budgets, isolation, and task identity at the shared execution boundary.
- Fix: added atomically persisted Workspace Capsules, optional/remote/all
  enforcement, Observe/Propose/Develop/Autopilot profiles, exact path and symlink
  boundary checks, budgets, expiry/revocation, dashboard lifecycle endpoints, and
  agent-visible status.
- Regression coverage: missing remote capsule, session reuse, expiry, revocation,
  Observe mutation, network/command restrictions, exact managed-worktree proof,
  absolute and symlink path escape, persistence, and budget exhaustion.

### FF-042 — Task isolation had no apply/discard safety boundary

- Severity: critical for preserving user work
- Status: fixed for Git repository roots; checkpoint fallback remains open
- Root cause: workflow checkpoints did not create a separate filesystem/Git
  workspace, and a declared `worktree` profile was not runtime proof.
- Fix: added managed task branches/worktrees under the Git common directory,
  source dirty/fingerprint capture, review status/diff, clean-source-only apply,
  patch preflight, bounded regular untracked files, symlink/submodule rejection,
  rollback on copy failure, integrity-checked lifecycle state, and branch/worktree discard. Apply/discard are
  admin-only tools.
- Regression coverage: dirty source preservation, source drift, tracked/untracked
  apply, conflict/symlink checks, traversal task id, reload, non-Git degradation,
  agent/admin tool separation, and cleanup.

### FF-043 — Approval reuse was principal-only across execution contexts

- Severity: high
- Status: fixed and locally verified
- Root cause: exact arguments were fingerprinted, but matching used only the raw
  principal id, allowing the same credential to cross session/project/capsule/task
  boundaries.
- Fix: retain the raw requester id for self-approval checks while matching on a
  separate canonical fingerprint of client, project, session, capsule, and task.
- Regression coverage: mismatch of each dimension, exact-context success, legacy
  records, restart, self-approval, and dashboard operator action.

## Milestone 1.7 — Browser intelligence foundation

### FF-001 — Screenshot image was flattened into JSON text

- Severity: high
- Status: fixed and live-tested
- Symptom: Playwright returned a valid MCP `image` block, but FolderForge nested
  the child result under `data` and serialized it as text. Vision-capable clients
  could not render the screenshot.
- Fix: added generic child MCP content normalization and an internal image content
  block; `toCallToolResult` now emits top-level MCP image content.
- Evidence: live HTTP MCP test decoded a valid PNG at 390×844.

### FF-002 — Child MCP errors were audited as successful calls

- Severity: high
- Status: fixed and live-tested
- Symptom: proxy handlers returned `{ok:true}` even when the child result carried
  `isError:true`, producing false-success audit records.
- Fix: `childCallToToolResult` maps child `isError:true` to `ToolResult.ok:false`,
  preserving diagnostics.
- Evidence: invalid browser navigation returns MCP `isError:true`; `audit_recent`
  contains `tool_error`, `ok:false` for `browser_open`.

### FF-003 — Screenshot base64 could be duplicated on the wire

- Severity: medium
- Status: fixed and tested
- Symptom: promoting an image while also stringifying the original
  `data.content` would send the same base64 twice.
- Fix: compatibility text omits nested `data.content` after rich blocks are
  promoted; structured/raw data remains available internally.
- Evidence: live screenshot contained 36,440 base64 characters and none were
  duplicated in the text blocks.

### FF-004 — No responsive viewport wrapper

- Severity: medium
- Status: fixed and live-tested
- Fix: added `browser_set_viewport`, mapped to Playwright `browser_resize`, with a
  bounded required width/height schema.
- Evidence: page `innerWidth`/`innerHeight` and screenshot dimensions both
  verified at 390×844.

### FF-005 — Browser capability could be evicted by `vibe-lite` cap

- Severity: high for AI UI workflows
- Status: fixed and regression-tested
- Symptom: after adding a tenth browser wrapper, `browser_eval` was the last tool
  and was silently removed by the 50-tool cap.
- Fix: current defaults remove 11 lower-value tools so the preset lands at 50;
  browser is also a pinned group during cap resolution.
- Evidence: tests verify all 10 browser wrappers remain both normally and under
  forced cap pressure.

### FF-006 — Playwright profile collision across FolderForge instances

- Severity: high for multi-agent/concurrent use
- Status: fixed in generated/default config; live-tested
- Symptom: a second server failed with `Browser is already in use for
  .../mcp-chrome` while another instance was active.
- Fix: default and generated Playwright adapter args include `--isolated`.
- Trade-off: browser state no longer persists by default. Persistence remains
  opt-in with a dedicated `--user-data-dir`.

### FF-007 — Source/global binary version mismatch

- Severity: medium
- Status: source verified; deployment action remains external
- Symptom: the previously running global `folderforge` endpoint reported `1.4.0`
  while the repository package is `1.6.0`.
- Finding: source `main.ts` reads the package version dynamically; a rebuilt
  `dist/main.js` live server reports `1.6.0` correctly.
- Resolution: reinstall/link/restart the global binary when this working tree is
  released. No source version constant was wrong.

### FF-008 — Git installs could receive an incomplete ignored `dist/` tree

- Severity: high for plugin distribution
- Status: fixed and package-verified
- Symptom: `dist/` is ignored while a legacy subset remains tracked. New runtime
  modules such as facade helpers and child-result normalization therefore do not
  appear in ordinary Git status and may be absent from a Git dependency archive.
- Fix: added the npm `prepare` lifecycle to rebuild `dist/` after dependencies are
  installed. npm registry publication continues to use `prepublishOnly`.
- Evidence: `npm pack --dry-run` includes the generated browser/result and adapter
  runtime modules. Source checkouts remain documented to build before direct use.

### FF-009 — Tool errors discarded structured evidence

- Severity: high for autonomous debugging
- Status: fixed and live-tested
- Symptom: `ToolResult.ok:false` serialized only its error sentence; exit code, stdout, stderr, parsed errors, and partial results in `data` were lost.
- Fix: error responses now append a JSON evidence block and mirror `structuredContent` when an output schema exists.
- Evidence: live `project_verify` failure returned exit code 2, stderr, parsed diagnostics, and MCP `isError:true`.

### FF-010 — Safe multi-file edits lacked a transaction boundary

- Severity: high
- Status: fixed and tested
- Fix: added bounded in-memory patch transactions with preview, exact-state conflict checks, atomic best-effort apply/rollback, diff resources, TTL, and HIGH-risk force override.

### FF-011 — AI coding context was primitive and unbounded

- Severity: medium
- Status: fixed and tested
- Fix: added project intelligence plus a bounded/redacted BM25 context pack with related tests and follow-up symbol hints.

### FF-012 — Verification scripts could be misclassified as read-only

- Severity: high
- Status: fixed before release
- Decision: only `project_verify dryRun:true` is LOW. Every real typecheck/lint/test/build execution remains MEDIUM because package scripts execute project code.

### FF-013 — Child plugins inherited the full parent environment

- Severity: critical for third-party plugin use
- Status: fixed and live-tested
- Symptom: the generic child client always merged `process.env`, which would expose unrelated tokens and credentials to installed MCP plugins.
- Fix: adapter definitions now support `cwd` and `inheritEnv`; installed plugins run with inheritance disabled, a minimal executable path, and only manifest-allowlisted variables.
- Evidence: live plugin saw the declared variable and received `null` for an undeclared parent secret.

### FF-014 — Dynamic adapter tools could be hidden by an already-active preset

- Severity: high
- Status: fixed and live-tested
- Symptom: child tools registered after `setActive` existed in the registry but were absent from `tools/list`.
- Fix: the registry can explicitly activate newly approved tools; full/no-filter startup activates adapters, and hot plugin enable activates only that plugin facade. Capped presets do not silently absorb every installed plugin.

### FF-015 — Plugin load failure could leave persisted enabled state

- Severity: high
- Status: fixed and tested
- Fix: install/update/enable activation failures now unload the adapter/risk map and persist the plugin as disabled.

### FF-016 — Declared plugin permissions are not an OS sandbox

- Severity: known security boundary
- Status: documented limitation
- Detail: network/filesystem declarations are review and audit metadata in 1.9. Local prepared packages still execute code. Remote distribution, signatures, publisher provenance, and hard sandbox enforcement are intentionally deferred instead of being represented as complete.

### FF-017 — Approved `once` requests were never consumed

- Severity: high
- Status: fixed and live-tested
- Symptom: approving a request with scope `once` changed persisted state but a retry generated a new request, creating an approval loop.
- Fix: exact tool + canonical args are matched, consumed once, and persisted with `consumedAt`. Session approvals remain unchanged.
- Evidence: a paused live workflow resumed after one approval; the approved child step ran once and prior successful steps were not replayed.

### FF-018 — Workflow checkpoint IDs could not be reloaded

- Severity: high
- Status: fixed in focused testing
- Symptom: shortened UUIDs retained a hyphen while checkpoint path validation allowed only alphanumeric IDs, so creation succeeded but status/run failed.
- Fix: generated IDs remove UUID separators before truncation.

### FF-019 — Tool cap preserved orchestration but evicted process lifecycle

- Severity: high for FE vibe coding
- Status: fixed and regression-tested
- Symptom: pinning workflow/agent/browser groups under a 50-tool cap caused automatic trimming to remove all process tools.
- Fix: explicitly remove seven lower-level primitives superseded by agent composition so process start/read/tail/stop/list remain available.

### FF-020 — Persisted workflow evidence could leak or balloon

- Severity: high
- Status: fixed by design and tested
- Fix: definitions with detected secrets are rejected; resolved args and evidence are redacted; data is capped; text/diffs are bounded; image base64 is replaced by metadata; run files are atomic mode `0600` and gitignored.

### FF-021 — Failed plugin update could interrupt the old enabled facade

- Severity: high
- Status: fixed and tested
- Symptom: lifecycle code unloaded an enabled plugin before validating the new
  package; an early update failure could leave the valid old package installed
  but unavailable until restart.
- Fix: failed pre-replacement updates hot-restore the previous facade and risk
  map. A focused integration test calls the old plugin successfully afterward.

## MCP developer-experience issues observed

### MCP-DX-001 — Patch context diagnostics

- Status: fixed and live-tested
- Resolution: `file_patch` and `file_edit_block` now return line-ending and
  whitespace-normalized mismatch flags plus the nearest bounded candidate range
  and similarity score. Matching remains exact; no fuzzy edit is applied.

### MCP-DX-002 — Non-zero shell commands lost primary diagnostics

- Status: fixed and live-tested
- Resolution: `shell_exec` declares an output schema, returns a useful primary
  error (`Command exited with code N`), and preserves exit code, stdout, stderr,
  duration, and classified risk in error data/structuredContent.

### MCP-DX-003 — Compound command failures hid partial evidence

- Status: fixed by the same structured-error bridge
- Resolution: shell stdout/stderr and exit code now survive MCP `isError:true`.
  A shell may still stop at the first failing `&&` segment, as expected, but
  evidence produced before failure remains available.

### MCP-DX-004 — Test fixtures accumulated persisted approvals

- Status: fixed
- Resolution: `FOLDERFORGE_APPROVALS_PATH` allows an explicit store override;
  Vitest setup assigns a per-worker temporary store and removes it after the run.
  The stale fixture-local log was removed. Repeated suites no longer grow it.

### MCP-DX-005 — Safe disposable temp cleanup was over-classified

- Status: fixed conservatively and live-tested
- Resolution: only one standalone deletion targeting an absolute top-level
  `/tmp/ff-*` or `/tmp/folderforge-*` tree is MEDIUM. Variables, globs, chaining,
  relative paths, other temp names, root, home, and system paths remain
  HIGH/CRITICAL. Embedded scripts containing destructive operations remain
  conservatively classified; callers should execute a reviewed script file.

## Milestone A — Release-candidate readiness

### FF-022 — Test toolchain had high/critical audit findings

- Severity: blocker
- Status: fixed and regression-tested
- Symptom: the production dependency audit was clean, but the full audit reported
  one critical and one high vulnerability through Vitest 2 / Vite 5.
- Fix: upgraded Vitest to 4.1.10 and refreshed the lockfile.
- Evidence: npm installation reported zero vulnerabilities; the full release
  regression is recorded below.

### FF-023 — Package audit failures lost actionable diagnostics

- Severity: medium
- Status: fixed and regression-tested
- Symptom: a package-manager audit with findings returned a generic tool failure
  even though the child command produced JSON evidence.
- Root cause: `runPm` returned `ok:false` with data but no primary error string.
- Fix: non-zero package commands now return a useful exit-code error while
  retaining command, exit code, stdout, and stderr.
- Evidence: `tests/unit/pkg-tools.test.ts` verifies a non-zero command preserves
  all evidence under Vitest 4.1.10.

### FF-024 — Published package declared a license file that did not exist

- Severity: blocker
- Status: fixed and package-verified
- Symptom: the first tarball smoke test failed because `package.json` listed
  `LICENSE`, but the repository contained no license file.
- Fix: added the Apache-2.0 license text and made the package smoke require it.
- Evidence: `npm pack` produced an installable tarball containing the license,
  build, README, and package metadata; the installed CLI passed version/help.

### FF-025 — Release workflow did not exercise the distributable artifact

- Severity: high
- Status: fixed for the Node 22/Linux release gate
- Fix: added deterministic scripts for verification, dependency audits, tarball
  pack/install/CLI smoke, and authenticated HTTP MCP initialize/list/call smoke;
  CI now runs those gates with least-privilege repository permissions.
- Evidence: the full operating-system and Node-version matrix is implemented in
  Milestone E; GitHub Actions run `29161853457` passed all six jobs.

## Milestone C — install safety and explicit browser setup

### FF-026 — Package installation performed an optional network download

- Severity: high
- Status: fixed and package-verified
- Symptom: `npm install`, global installation, and `npx` startup could execute a
  `postinstall` hook that ran `npx --yes playwright install chromium`.
- Risk: installation unexpectedly required network access, silently tolerated
  failure, and allowed mutable package resolution during a lifecycle script.
- Fix: removed `postinstall`; added explicit `folderforge setup browser` with
  `--with-deps`, stable JSON evidence, and a no-download `--dry-run`. The command
  invokes Node directly on the Playwright CLI from FolderForge's installed
  dependency graph, without a shell or `npx`.
- Evidence: focused setup tests passed 7/7; packed-package smoke rejects any
  `postinstall`, validates the package-local CLI path, runs doctor read-only, and
  confirms no `.folderforge` state is created.

### FF-027 — Playwright CLI subpath was blocked by package exports

- Severity: medium
- Status: fixed and package-verified
- Symptom: the first built CLI dry-run failed because `playwright/cli` is not an
  exported package subpath.
- Root cause: source-level dependency resolution did not match Playwright's public
  export map.
- Fix: resolve the exported `playwright/package.json`, derive the adjacent
  `cli.js`, and verify that file exists before execution.
- Evidence: the source-built CLI and temporary tarball installation both resolve
  `node_modules/playwright/cli.js` and return exit 0 in dry-run mode.

## Milestone D — documentation and state synchronization

### FF-028 — Current-status documentation lagged Git state

- Severity: medium
- Status: fixed and reviewed
- Symptom: README, changelog, roadmap, implementation log, and AI roadmap still
  described committed/pushed work as pending or confined to a stabilization
  branch after it had been merged into `main`.
- Fix: synchronized current-state wording and explicitly separated code prepared,
  committed, pushed, tagged, published, hosted release, and stable release.
- Scope: historical evidence that names older runtime versions remains historical
  and was not rewritten as if it were current acceptance evidence.

## Milestone E — cross-platform compatibility

### FF-029 — Windows received POSIX shell arguments

- Severity: high
- Status: fixed and cross-platform CI verified
- Symptom: the default Windows shell was `cmd.exe`, but `shell_exec`, managed
  processes, build tools, and project verification always passed `-lc`, which is
  valid for POSIX shells but not for cmd.
- Fix: added a shared shell invocation helper. cmd uses `/d /s /c`, PowerShell
  uses `-Command`, and POSIX/Git Bash use `-lc`. Godot launch arguments now use
  shell-specific literal quoting.
- Evidence: focused shell/process/terminal/game tests pass locally; the six-entry
  OS/Node CI matrix is the cross-platform acceptance gate.

### FF-030 — Build and clean scripts were POSIX-only

- Severity: high
- Status: fixed and cross-platform CI verified
- Symptom: `npm run build` called `chmod +x`, and `npm run clean` called `rm -rf`,
  causing Windows npm scripts to fail before runtime tests.
- Fix: replaced both operations with Node scripts. Windows relies on npm's `.cmd`
  bin shim; POSIX builds still set mode `0755`.
- Evidence: clean/build, package smoke, and a regression contract test pass
  locally.

### FF-031 — Tests encoded Linux filesystem and command assumptions

- Severity: medium
- Status: fixed and cross-platform CI verified
- Symptom: process and LSP/setup tests hard-coded `/tmp`, `/bin/bash`, and `sleep`.
- Fix: tests now use `tmpdir()`, the platform default shell, and Node-based delay
  commands. The Godot process fixture uses `process.execPath`.
- Evidence: full local suite passes 357/357 across 46 files.

### FF-032 — Release gates did not exercise stdio MCP end to end

- Severity: high
- Status: fixed and cross-platform CI verified
- Symptom: package and HTTP smoke covered the distributable and network transport,
  but no release gate initialized the server and called a tool over stdio.
- Fix: added an SDK-based stdio smoke that verifies server version, `tools/list`,
  and `file_read` in a project/config path containing spaces and Unicode.
- Evidence: local smoke reports 42 readonly tools and a successful file read.

### FF-033 — Runtime-state diagnostics accepted a file as `.folderforge`

- Severity: medium
- Status: fixed and regression-tested
- Symptom: doctor checked write access but did not require `.folderforge` to be a
  directory, so an unusable state path could be reported healthy.
- Fix: doctor now fails when the state path is not a directory; deterministic
  tests also cover POSIX permission denial and missing Chromium warn/fail behavior.

### FF-034 — Compatibility tests missed junction and Unicode path behavior

- Severity: high for Windows release confidence
- Status: fixed and cross-platform CI verified
- Fix: package and stdio smoke use Unicode/space paths; PathPolicy tests use a
  Windows junction (directory symlink elsewhere) and require escape rejection.
  Managed-process tests verify stop wakes a long-poll without Unix-only commands.

### FF-039 — First observable compatibility matrix failed four non-Linux jobs

- Severity: stable-release blocker
- Status: fixed and cross-platform CI verified
- Evidence: GitHub Actions run `29159746609` passed Ubuntu on Node 22/24 and
  failed macOS plus Windows on Node 22/24 during tests. Runs `29160360527` through
  `29161451454` isolated the portability defects; final run `29161853457` passed
  all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- macOS root cause: temporary paths entered through `/var` but resolved through
  `/private/var`, so lexical containment produced false workspace escapes.
- Windows root causes: `.cmd` doctor probes could return missing output, temp-path
  tests assumed `/tmp`, `cmd.exe /s /c` stripped quotes around executable paths,
  terminating only the shell left descendants alive with temp/plugin directories
  locked, and Node then escaped the already-wrapped cmd argv a second time. A real
  Git remote test also exceeded the default timeout.
- Fix: canonicalize the nearest existing path ancestor while retaining symlink
  escape rejection; make doctor output nullable-safe and invoke `.cmd` through
  `cmd.exe`; derive temp paths from `tmpdir()`; wrap quoted executables for cmd;
  terminate Windows process trees synchronously with `taskkill /T /F`; pass
  `windowsVerbatimArguments` through shared cmd callers; run npm's JavaScript CLI
  and the installed FolderForge `dist/main.js` directly through Node in package
  smoke while still requiring the npm-created bin shim; retry bounded plugin tree
  removal; and give the real Git remote flow a bounded 20-second timeout. HTTP
  structured-error smoke uses the same script-file path, and Actions checkout is
  upgraded to v5.
- Local evidence: `npm run release:check` passes 369/369 tests across 46 files,
  both zero-vulnerability audits, build, 96-file package smoke, stdio, and
  authenticated HTTP smoke.

## Milestone F — approval and plugin security hardening

### FF-035 — Approval evidence could retain raw secrets

- Severity: high
- Status: fixed and regression-tested
- Symptom: approval JSONL stored raw arguments, while audit and elicitation
  summaries serialized argument values without structured secret redaction.
- Fix: exact retry matching now uses a canonical SHA-256 fingerprint; retained
  arguments are recursively redacted with sensitive-key, regex, and entropy
  rules. Approval state is mode `0600`; audit and prompt summaries share the safe
  representation.
- Evidence: persisted JSONL, audit summaries, and elicitation prompts exclude test
  secrets while exact same arguments still consume the once approval after
  restart.

### FF-036 — Installed plugin bytes had no tamper detection

- Severity: high
- Status: fixed and regression-tested
- Symptom: a copied local plugin could be modified after review/installation and
  would still be loaded from the same registry record.
- Fix: new installs/updates record a deterministic SHA-256 digest over sorted
  relative paths and bytes. Inspect, adapter startup, and doctor recompute and
  reject mismatches. Legacy records remain explicitly `unverified`.
- Boundary: the digest detects change but does not authenticate publisher or
  provenance, and a bare host executable is outside the package tree.

### FF-037 — Post-replacement plugin activation failure was not transactional

- Severity: high
- Status: fixed and integration-tested
- Symptom: update rollback covered invalid input before replacement, but a valid
  package whose child MCP server failed during hot activation could replace the
  old bytes and interrupt the enabled facade.
- Fix: retain old package/registry until discovery succeeds; on activation error,
  restore package, registry, runtime adapter, risk map, and old enabled facade.
- Evidence: integration test updates to a valid manifest with a crashing child,
  observes failure, confirms version rollback, and successfully calls the old
  facade afterward.

### FF-038 — Plugin security declarations lacked executable boundary tests

- Severity: high
- Status: fixed and integration-tested
- Fix: a live child test receives only an allowlisted environment variable, sees
  an undeclared parent secret as `null`, and exposes a CRITICAL sub-tool whose
  execution counter remains at one only after explicit once approval.

### MCP-DX-006 — Compound shell and audit failures can surface generic text

- Severity: medium
- Status: fixed and wire-regression-tested
- Finding: older connected binaries could collapse compound shell failures to a
  generic tool error even after the source package/audit path was corrected.
- Fix: unit coverage preserves non-zero package and shell evidence, and the RC.2
  authenticated HTTP smoke now calls a deliberate exit-7 `shell_exec` against the
  rebuilt server and asserts `isError`, `exitCode`, `stdout`, and `stderr` over MCP.

## Verification record

- Stable candidate version: `2.0.0`; `package.json`, package-lock metadata,
  packed tarball, installed CLI, and live MCP `serverInfo.version` agree.
- Typecheck: passed.
- Lint (`tsc --noEmit`): passed.
- Build: passed.
- Final local unit/integration suite after the portability fixes: 369/369 passed across 46 test files.
- Production and full dependency audits: 0 vulnerabilities.
- `npm pack` produced a 96-file candidate tarball containing the license, README,
  package metadata, and generated runtime; temporary installation passed CLI
  version/help, doctor, no-postinstall, and browser-setup dry-run checks and
  cleaned its artifacts.
- Stdio MCP smoke passed initialize, `tools/list` with 42 readonly tools, and
  `file_read` from a project/config path containing spaces and Unicode.
- Authenticated HTTP MCP smoke passed unauthorized rejection, initialize,
  `tools/list` with the 50-tool `vibe-lite` invariant, and wire-level calls to
  `pkg_audit`, `file_read`, plus a deliberate non-zero `shell_exec` whose
  structured error evidence remained intact.
- Clean npm-registry installation of `@musashishao/folderforge@next` passed in
  a path containing spaces and Unicode. The published artifact reported
  `2.0.0-rc.2`, declared no `postinstall`, resolved package-local browser setup,
  kept doctor read-only, advertised 42 stdio and 50 HTTP tools, enforced HTTP
  authentication, and preserved deliberate shell failure evidence over MCP.
- Source-built HTTP MCP acceptance covered:
  - Browser foundation: native image blocks, viewport 390×844, interaction,
    console/network, error propagation, and audit correctness.
  - AI coding runtime: project analysis/context, transactional patch lifecycle,
    Git summary, and structured verification failures.
  - Plugin ecosystem: package integrity, hot lifecycle, risk facade, environment
    allowlist, health, restart persistence, disable/update/uninstall, and
    pre/post-replacement failed-update recovery.
  - Governed workflows: role scope, dependency/reference execution, approval
    pause/resume, exact non-replay, reports, audit, and restart persistence.
  - Self-hosting DX: non-zero shell evidence, nearest patch diagnostics, bounded
    disposable temp cleanup, and denial of non-prefixed temp deletion.

Milestone checkpoints through the stable-release verdict are complete. The exact
`2.0.0` candidate passed the complete local release gate, and corrected commit
`6cde6708201873647b8f682cd6918fa86e520f24` passed GitHub Actions runs
`29215028974` and `29215294614` across all six Ubuntu/macOS/Windows × Node 22/24
jobs. The obsolete fix/release branches were deleted locally and from `origin`,
leaving only `main`. npm `latest` resolves to `2.0.0`; a clean registry install
reported version `2.0.0`, no `postinstall`, a working CLI, and successful read-only
`doctor --json` validation. The stable Git tag and hosted GitHub release remain to
be created.

## 2026-07-15 — OAuth resource-server mode for ChatGPT

- Repository baseline: branch `hardening/authorization-boundary`, HEAD
  `b3c97ee45eb380099d4f9d7826d2e8673fe57466`; dirty authorization-boundary work
  was preserved without reset/stash/overwrite. Baseline typecheck and targeted
  auth/admin tests passed.
- Research: implementation aligned to MCP Authorization 2025-11-25, RFC 9728,
  RFC 8414/OIDC discovery, RFC 7636/PKCE, RFC 8707 resource indicators, OAuth
  2.1 draft requirements, current OpenAI Apps SDK authentication, and current
  ChatGPT Developer Mode connection guidance. The latest MCP spec uses HTTP 403
  for insufficient scope, so transport scope denial follows that current rule
  rather than the older prompt assumption of 401.
- ADR: selected external authorization server / resource-server-only Option A;
  default client strategy CIMD, with validated DCR and predefined alternatives.
- Implementation: config/CLI/env contract, metadata/challenge routes,
  discovery/JWKS runtime, asymmetric JWT validation, exact resource audience,
  per-tool security schemes, tool-level step-up challenge, and read/write scope
  enforcement before execution. OAuth principals remain agent-only.
- Security: production HTTPS, loopback-only unsafe HTTP, no OAuth/static fallback,
  no generated credentials in logs, JWKS host trust restriction, no redirects on
  metadata fetch, bounded discovery response/timeouts, no custom cryptography.
- Evidence checkpoint: build passed; complete Vitest suite passed with 49 files
  and 385 tests; OAuth integration passed metadata, challenge, valid token,
  malformed/expired/nbf/wrong issuer/wrong audience/invalid signature/wrong JWT type, missing
  scope, API-key bypass, exact JWKS host/port trust, JWKS rotation, CIMD capability,
  and PKCE downgrade cases. Packed-package
  smoke installed the tarball and started its CLI in OAuth mode, then verified
  metadata, 401 discovery, and signed-token `tools/list`.
- External gate: live ChatGPT acceptance remains unobserved because no public
  HTTPS resource, IdP tenant, redirect allowlist, or user ChatGPT UI session was
  supplied. Exact minimal checklist is in `docs/oauth.md`.
- Release preparation: package and lock metadata target `2.1.0`; the exact tree
  passed `npm run release:check` with typecheck, lint, 49 test files / 385 tests,
  both zero-vulnerability audits, build, 100-file packed-package OAuth startup,
  stdio smoke, and authenticated HTTP smoke. The package smoke also sanitizes
  inherited npm dry-run flags so the final `npm publish --dry-run` path validates
  a real tarball. Changes were committed on `hardening/authorization-boundary`
  and merged locally into `main`; no push, Git tag, npm publication, or hosted
  release was performed.

## 2026-07-15 — Auth0/ChatGPT one-command connector

- Repository state: local `main`, HEAD
  `66d5931f5d42afecedfe0787f640b15d26e68b34`, one commit ahead of
  `origin/main`. The working tree was clean before this connector work and was
  preserved without reset, clean, stash, forced checkout, commit, push, tag, or
  publication.
- Product architecture: Auth0 remains the OAuth Authorization Server,
  FolderForge remains the OAuth Resource Server, and ChatGPT remains the OAuth +
  MCP client. Quick mode uses DCR and may use an explicitly warned temporary
  Cloudflare quick tunnel; secure mode requires a stable HTTPS resource and a
  predefined public client identifier.
- Implementation: added `folderforge connect chatgpt` plus
  `folderforge chatgpt status|doctor|repair|start|stop|disconnect`; active Auth0
  tenant discovery; issuer/PKCE S256/DCR/JWKS verification; exact-identifier
  Auth0 API lookup/create/update; scope merging; generated OAuth config; process
  supervision; public metadata and 401 challenge verification; dry-run; PID lock;
  and a versioned secret-free connection receipt.
- Security: subprocesses use argv arrays with `shell: false`; public/tenant URLs
  are structurally validated; a tenant override must be present in the authenticated
  Auth0 CLI tenant list; authorization, token, registration, and JWKS endpoints are
  limited to the selected tenant's HTTPS origin; and metadata bodies are capped at
  1 MiB. Production URLs require HTTPS; RS256 and RFC 9068 access-token dialect are
  provisioned; offline access is disabled. Existing Auth0 scopes and descriptions
  are preserved while missing FolderForge scopes are appended through a targeted
  Management API PATCH. Management API tokens, access/refresh tokens, codes,
  secrets, private keys, PKCE verifiers, API keys, passwords, and cookies are not
  persisted. Receipt validation rejects secret-shaped keys and JWT-shaped values.
  Disconnect never deletes remote Auth0 resources automatically.
- Unit/integration coverage: 12 connector tests cover parsing, HTTPS canonical URL
  validation, Auth0 provisioning/update idempotency, preservation of existing scope
  descriptions, paths with spaces and Unicode, no-write dry-run, nested secret/JWT
  receipt rejection, secure-mode fail-closed, authenticated-tenant allowlisting,
  cross-origin discovery/JWKS rejection, concurrent lock rejection, endpoint status,
  remote-resource-preserving disconnect, and pre-mutation purge confirmation.
- Real Auth0/tunnel evidence: active tenant
  `dev-a8mb18fj03epznxd.us.auth0.com` passed discovery, issuer, PKCE S256, DCR,
  and JWKS validation. Quick setup created Auth0 API
  `6a57ad1b6e649ab2f2e5997e` once for
  `https://quest-proprietary-seat-carnival.trycloudflare.com/mcp`, with RS256,
  `rfc9068_profile`, 3600-second lifetime, offline access disabled, and scopes
  `folderforge:read` plus `folderforge:write`. A second connect and repair reused
  the same tunnel/API without changes.
- Public protocol evidence: protected-resource metadata at
  `https://quest-proprietary-seat-carnival.trycloudflare.com/.well-known/oauth-protected-resource/mcp`
  returned the exact resource, issuer, and scopes. An unauthenticated MCP POST
  returned HTTP 401 with the exact `resource_metadata` URL and read scope.
  Generated config, receipt, and logs were mode `0600`; a generated-state secret
  scan found no secret-shaped content.
- Packaging evidence: the 102-file tarball contained the built connector and guide,
  installed from a path containing spaces and Unicode, and passed packed CLI help,
  OAuth startup, protected-resource metadata, 401 challenge, and a signed-JWT
  `tools/list` call.
- Automated acceptance: local typecheck, lint, 50 test files / 397 tests, build,
  production/full audits with zero vulnerabilities, 102-file packed-package smoke,
  stdio smoke, authenticated HTTP smoke, and `git diff --check` all passed on the
  final working tree.
- External live gate: ChatGPT app creation, Auth0 login/consent, authenticated
  `tools/list`, one read-only call, and one write-scope call remain unobserved
  because they require the operator's ChatGPT UI and user-owned login session.
  The running quick endpoint is temporary and must not be treated as production.
