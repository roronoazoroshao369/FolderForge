# Fleet Zero-Manual-Config Trusted Host — TDD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a Fleet owner to request `full + danger + trusted-host` in Mission Control, confirm it once through a genuine on-host operator flow without editing YAML, and apply a consistent per-instance authorization without granting remote HTTP/MCP actors the power to self-elevate.

**Architecture:** An immutable Fleet profile intent is created by an authenticated Dashboard endpoint, then approved by a separately invoked local CLI via owner-restricted state outside the workspace. A typed, instance/tuple-bound grant is checked synchronously at each existing Fleet apply/start; this preserves the current synchronous FleetManager API. Journaled, synchronous storage updates avoid event-loop interleaving, and startup recovery runs before Fleet reads/child starts. UI represents requested, persisted, observed and revoked states separately.

**Tech Stack:** Node >=22 ESM, TypeScript, Vitest, React 18/Vite, existing FolderForge FleetManager/Container/Operator/ToolRegistry, macOS owner-restricted POSIX files, current GitHub 6-job matrix.

**Spec:** `docs/superpowers/specs/2026-10-10-fleet-zero-config-trusted-host-consent-design.md` (approved written spec, PR #75 commit `bde1b57c0f421f81be555237927783e283906b06`).

**Pre-plan feasibility:** `docs/superpowers/feasibility/2026-10-10-fleet-macos-local-consent.md`; GitHub-hosted macOS primitive probe SUCCESS, operator acceptance on user's Mac **NOT_RUN**. This plan does not approve product code.

## Global Constraints

- **Remote-only fail-closed:** neither HTTP/MCP nor `localhost`/query-token access may mint, replay or alter an approved operator grant. Authenticated Dashboard may create/cancel **pending intents only**; an old grant binds to one exact three-setting tuple and instance identity.
- **MacOS first:** real host interactive acceptance required before a product merge; Linux separate gate; Windows remains UNSUPPORTED/fail-closed until independently reviewed.
- **Default unchanged:** `terminal.sandbox.mode: process`, `requireInDanger: true` for unconsented children. Keep the explicit legacy parent-startup opt-in but never auto-write it globally. Only one Fleet instance may be authorized at a time by its scoped grant.
- **Authentication mandatory:** reject child auth=`none`, unverified admin sessions, write freeze, mismatched identity or expired/replayed operator request. New sensitive Dashboard intent endpoints reject URL query-string credential as the only authentication factor and require origin/CSRF protection.
- **Same-UID limitation:** interactive terminal and owner-only files are NOT hardware presence and do NOT defend against malicious arbitrary code executing as the FolderForge OS account. Surface this accurately in UX/docs.
- **No interruption:** no silent restart of running instances, active OpenAI tunnels, unverified orphan PID/lease or tasks. Persisted profile is not the observed running profile.
- **Synchronous Fleet compatibility:** existing `FleetManager.get(id): FleetInstance`, `list(): FleetInstance[]`, `create(input)`, `setToolsPreset(id, preset)`, `setPolicyMode(id, mode)`, `setTerminalExecution(id, profile)`, `start(id): FleetInstance`, `restart(id): FleetInstance` and `load()` behavior remain synchronous. Use synchronous file I/O and fail-fast inter-process locking; no event-loop yield or indefinite lock wait. Preserve external types unless a separate approved compatibility change is required.
- **Crash consistency:** two files are NOT atomic as a single filesystem operation. Serialize Fleet API readers/writers/spawns; journal recovery must be completed (or fail closed) before any new child start. Validate APFS directory-sync behavior on real macOS; if the approved invariant fails, stop and amend/reapprove spec.
- **Journal states are explicit:** under cross-process exclusive lock, PREPARED contains old bytes/hashes and approved new hashes; only after both validated writes and read-back durably mark COMMITTED. PREPARED interrupted at any point rolls back both files before a read/start; COMMITTED restores/validates both new files; corrupt/absent backing evidence -> RECOVERY_REQUIRED blocks operations. Never continue after an audit write failure. Record intent/precommit durably before mutation and final outcome afterward. POWER-LOSS durability remains UNVERIFIED until real macOS qualification.
- **Quality gates:** targeted RED → GREEN every task, full `npm run verify`, `npm run build`, smoke HTTP/stdio, exact-final-head CI, independent security review and macOS human/operator acceptance before any product merge. No G59 changes, no npm publish/tag/release.
- **Branching:** product work in a new isolated branch AFTER separate review/approval of this plan and execution mode. Preserve G59's three managed worktrees and isolation registry.

## Review Focus

Five likely user-facing failures and the exact task that will pin them:
1. **Same-profile Save twice or rapid concurrent Save:** no new grant and no partial writes; tests in Task 5 and Task 6.
2. **Two authenticated principals / stolen request ID / query-token Dashboard:** cannot create or consume each other's operator authorization; Task 5 and Task 8.
3. **Crash between Fleet JSON and YAML renames, or unsupported directory durability:** recover coherently or block starts; Task 6.
4. **Revoke during an active process whose PID cannot be verified:** mark `revoked_execution_uncertain`, prevent new starts, alert operator; Task 7.
5. **Changing child auth/installation/workspace while a grant exists:** invalidate grant immediately, require new local approval; Task 2, Task 5 and Task 9.

---

### Task 1: Pin macOS host acceptance and platform fail-closed seams

**Files:**
- Create: `tests/unit/trusted-host-platform.test.ts`
- Create: `src/operator/trusted-host-platform.ts`
- Reference: `docs/superpowers/feasibility/2026-10-10-fleet-macos-local-consent.md`

**Interfaces:**
- Produce: `type OperatorPlatform = 'darwin' | 'linux' | 'unsupported'`; `detectConsentPlatform(platform: string): OperatorPlatform`; `requireSupportedLocalPlatform(platform: string): void`.
- Export a `checkLocalTerminal(io: { stdinIsTTY: boolean; stdoutIsTTY: boolean }): void` guard for Task 4.

- [ ] **Step 1: Write RED tests** — `win32` and unknown platforms throw `LOCAL_CONFIRMATION_UNAVAILABLE`, `darwin` resolves support, non-TTY stdin/stdout throws `LOCAL_TERMINAL_REQUIRED`. Run `npx vitest run tests/unit/trusted-host-platform.test.ts`; expect FAIL (symbols absent).
- [ ] **Step 2: Implement minimal platform and TTY guards** in `src/operator/trusted-host-platform.ts` with the signatures above; don't interpret a fabricated pseudo-TTY as physical-presence evidence.
- [ ] **Step 3: Run GREEN and platform regressions** — targeted test PASS; record in test output whether the OS-native human acceptance test is NOT_RUN (no deceptive PASS).
- [ ] **Step 4: Commit** `test/feat: pin trusted-host platform and TTY preconditions`.

### Task 2: Define stable scope identity and digest (no remote grants)

**Files:**
- Create: `src/operator/trusted-host-scope.ts`
- Create: `tests/unit/trusted-host-scope.test.ts`
- Modify: `src/provisioner/fleet-manager.ts` (types only initially)

**Interfaces:**
- Produce `type FleetProfileTuple = { toolsPreset: string; policyMode: string; terminalExecution: 'sandbox-required' | 'trusted-host' }`.
- Produce `type ConsentIdentity = { installationId: string; serviceUid: number; instanceId: string; workspaceRealpath: string; authMode: 'token'|'api-key'|'oauth'|'none'; revocationGeneration: number }`; use a **separate** `expectedInstanceRevision: string` only in a pending intent / CAS transaction, not in the durable grant digest.
- Produce `scopeDigest(tuple: FleetProfileTuple, identity: ConsentIdentity): string`, based on canonical, ordered serialization and SHA-256.

- [ ] **Step 1: RED tests** — unchanged stable scope+tuple yields identical grant digest after an ordinary Fleet instance revision bump; changed UID/path/auth/tuple/revocation generation changes digest. An intent with expected revision R MUST reject commit after the instance changes to R+1, requiring a new intent/local approval (without destroying any separate valid unchanged grant). Verify redacted digest never includes token.
- [ ] **Step 2: Run** `npx vitest run tests/unit/trusted-host-scope.test.ts` → FAIL on missing functions.
- [ ] **Step 3: Implement ordered serialization + realpath identity**, rejecting non-existent/ambiguous identities and key casing variants.
- [ ] **Step 4: Run GREEN**, then commit `feat: bind trusted-host grants to exact Fleet scope`.

### Task 3: Secure operator-only store and tamper/replay protection

**Files:**
- Create: `src/operator/trusted-host-store.ts`
- Create: `tests/unit/trusted-host-store.test.ts`
- Modify: `src/runtime/config.ts` only if a non-HTTP host-operator directory is needed for dependency injection (no new globally writable opt-in)

**Interfaces:**
- Produce `class TrustedHostStore` constructed with `{ operatorRoot: string; currentUid: number; now: () => number }`.
- Methods (all **synchronous**, matching FleetManager call paths): `createPending(intent: TrustedHostIntent): void`, `readPending(requestId: string): TrustedHostIntent | null`, `consumeLocalApproval(requestId: string, expectedDigest: string): TrustedHostGrant`, `validateGrant(identity: ConsentIdentity, tuple: FleetProfileTuple): boolean`, `revoke(identity: ConsentIdentity): void`. Define `TrustedHostIntent`/`TrustedHostGrant` as versioned records; never put grant payload in public Fleet JSON. The caller's CLI prompt may await input, then invoke the synchronous store action.

- [ ] **Step 1: RED tests** for `0700` operator directory and `0600` files, UID/link-count/mode checks on opened descriptors, symlink refusal, invalid digest, replay, cancellation, ten-minute TTL, two requests racing, unsupported platform/ACL.
- [ ] **Step 2: Run** `npx vitest run tests/unit/trusted-host-store.test.ts` → FAIL for missing store.
- [ ] **Step 3: Implement minimal owner-only file protocol and single-use approval**, protected outside every agent project root. Use `O_NOFOLLOW|O_EXCL` and descriptor checks, fsync/read-back. Fail closed if atomics/ownership cannot be verified.
- [ ] **Step 4: Run GREEN** and a dedicated real macOS CI test of chosen directory file-sync/rename operations. **STOP** if fsync semantics differ from spec's recovery contract; amend spec before continuing.
- [ ] **Step 5: Commit** `feat: persist scoped operator consent outside agent workspaces`.

### Task 4: Local operator CLI with explicit human decision

**Files:**
- Create: `src/operator/trusted-host-cli.ts`
- Create: `tests/integration/trusted-host-operator-cli.test.ts`
- Modify: `src/main.ts` to add `operator trusted-host approve|revoke` dispatch, before general CLI parsing.

**Interfaces:**
- Produce `runTrustedHostOperatorCli(args: string[], io: OperatorCliIO, store: TrustedHostStore): Promise<{ exitCode: number; output: string }>`.
- `OperatorCliIO` provides `stdinIsTTY`, `stdoutIsTTY`, `print(text)`, `ask(question)`, `osUid`, and an injectable secure path resolver; no noninteractive approval flag.

- [ ] **Step 1: RED tests**: print canonical scope and exact tuple; deny wrong UID, invalid request, piped stdin, `--yes`, stdout not TTY, stale/cancelled request, wrong installation, negative answer; no store mutation on denial; accepted input binds only exact tuple. An SSH-created or synthetic TTY is not trusted physical proof. Pin a **real interactive macOS operator acceptance transcript** as external MERGE gate; it remains NOT_RUN until performed on the host.
- [ ] **Step 2: Run** `npx vitest run tests/integration/trusted-host-operator-cli.test.ts` → FAIL.
- [ ] **Step 3: Implement minimal CLI, not an HTTP callback**; require a direct local invocation. Treat simulated TTY acceptance in tests as logic verification, **not a real human/macOS approval**.
- [ ] **Step 4: Run GREEN**, validate `folderforge --help` output, then commit `feat: add local-only Fleet host authorization prompt`.

### Task 5: Immutable requests, grants and audit lifecycle

**Files:**
- Create: `src/operator/trusted-host-consent.ts`
- Create: `tests/unit/trusted-host-consent.test.ts`
- Modify: `src/runtime/container.ts` to wire store into parent-owned service, not global sandbox flag.

**Interfaces:**
- Produce `class TrustedHostConsentService` with synchronous methods `requestProfile(instanceId: string, tuple: FleetProfileTuple, principal: OperatorPrincipal): PendingView`, `status(instanceId: string, requestId?: string): RedactedConsentView`, `cancelPending(instanceId: string, requestId: string, principal: OperatorPrincipal): void`, `assertAuthorized(instanceId: string, tuple: FleetProfileTuple): void`, `revokeFromLocal(instanceId: string): void`.
- Access Fleet instance/read-only identity and current `missionControl.writeFreeze`; no HTTP method for `approve` or grant mutation.

- [ ] **Step 1: RED tests**: pending request has no side effects, repeated identical committed tuple is idempotent even after routine instance revision bumps, different tuple requires a new grant, conflicting concurrent intents reject, cross-principal/stolen request ID insufficient, 600-second expiry, changed auth/service UID/installation invalidates grant, CAS revision changed between local approval and commit rejects the stale intent, write freeze/audit failure denies before persistence.
- [ ] **Step 2: Run** `npx vitest run tests/unit/trusted-host-consent.test.ts` → FAIL.
- [ ] **Step 3: Implement state machine with bounded pending counts**, durable audit entries and grant check on every use; don't allow remote calls to `consumeLocalApproval`.
- [ ] **Step 4: Run GREEN** and assert no secrets in logs; commit `feat: gate Fleet host grants by approved intent scope`.

### Task 6: Journaled Fleet profile transaction and recovery

**Files:**
- Create: `src/provisioner/fleet-profile-transaction.ts`
- Create: `tests/unit/fleet-profile-transaction.test.ts`
- Modify: `src/provisioner/fleet-manager.ts` so all read/update/start paths serialize against recovery.

**Interfaces:**
- Produce `class FleetProfileTransaction` with **synchronous** `commit(instanceId: string, tuple: FleetProfileTuple, approvedDigest: string): FleetInstance` and `recoverBeforeReadOrStart(): void` (or recovery performed once in FleetManager construction before any public API). No async gap is permitted within the critical section.
- Produce `FleetManager.updateProfileAtomically(instanceId: string, tuple: FleetProfileTuple, authorization: TrustedHostConsentService): FleetInstance`, preserving synchronous `get()` and `start()` callers. No silent partial `setToolsPreset → setPolicyMode → setTerminalExecution` chain.

- [ ] **Step 1: RED tests**: simulate crash BEFORE PREPARED, AFTER PREPARED fsync, AFTER first rename, AFTER second rename but BEFORE COMMITTED, AFTER COMMITTED marker, and BEFORE final read-back; deterministic old tuple recovery for PREPARED and new tuple recovery for COMMITTED. Inject disk full, fsync/directory fsync failure, invalid old/new file hash, audit precommit failure, symlink/hard-link, concurrent process lock attempt, duplicate Save, auth rotation, and reader/start during RECOVERY_REQUIRED. Assert no partial-success response and no child starts before successful recovery.
- [ ] **Step 2: Run** `npx vitest run tests/unit/fleet-profile-transaction.test.ts` → FAIL.
- [ ] **Step 3: Implement synchronous lock + journal + recovery**: use exclusive owner-verified lockfile (`O_CREAT|O_EXCL|O_NOFOLLOW`), return a bounded `FLEET_PROFILE_BUSY` error on competing processes instead of waiting/reentering; stale lock recovery requires verified owning PID/lease. Under lock: durable PREPARED (includes original+approved hashes, backed old content and request digest), staged writes+fsync, ordered renames and directory checks, durable COMMITTED marker, verified read-back and postcommit audit. On startup/next API read under lock: PREPARED=>restore both old files, COMMITTED=>validate/complete both new files, ambiguous=>RECOVERY_REQUIRED. No claim of atomic two-file rename. If macOS APFS cannot satisfy the approved recovery invariant, STOP and amend/reapprove spec.
- [ ] **Step 4: Run GREEN** plus `tests/unit/provisioner.test.ts`; commit `feat: atomically expose recovered Fleet profile updates`.
- [ ] **Step 4a: Verify existing signatures**: `FleetManager.get/list/create/start/restart/setToolsPreset/setPolicyMode/setTerminalExecution` remain synchronous and return their prior types; `FleetManager.load()` recovers before public getters; all legacy setter calls (including `provision_update`) go through the lock. Test a second manager process attempting the same lock, no deadlock/hang.

### Task 7: Live Fleet execution, revocation and restart gating

**Files:**
- Modify: `src/provisioner/fleet-manager.ts`, `src/runtime/container.ts`
- Create: `tests/integration/fleet-trusted-host-lifecycle.test.ts`

**Interfaces:**
- Consume `TrustedHostConsentService.assertAuthorized` **at every child start**, including auto-restart/orphan reconciliation.
- Produce `FleetManager.effectiveExecutionStatus(instanceId: string): FleetExecutionStatus`, combining requested tuple, persisted tuple, verified child process and grant state.

- [ ] **Step 1: RED tests**: unconsented `danger + process` stays denied; authenticated authorized instance starts; other instance/no-auth denied; dynamic check on `start`, `restart`, auto-restart and orphan reconciliation; changed service UID/auth/path/revocation generation immediately denies; unknown PID/tunnel/active task causes deferred restart; revocation either verifies stop or reports `revoked_execution_uncertain`. Ensure no accepted invalid start lease.
- [ ] **Step 2: Run** `npx vitest run tests/integration/fleet-trusted-host-lifecycle.test.ts` → FAIL.
- [ ] **Step 3: Implement lifecycle checks with existing process lease/fingerprint fencing**; no auto-kill if quiescence uncertain and no stale cached startup authorization.
- [ ] **Step 4: Run GREEN** plus `tests/unit/provisioner.test.ts` and `tests/integration/dashboard-openai-tunnel.test.ts`; commit `feat: enforce host consent at Fleet start and revoke`.

### Task 8: Read-only status and intent-only Dashboard APIs

**Files:**
- Modify: `src/dashboard/server.ts`
- Create: `tests/integration/dashboard-trusted-host-consent.test.ts`

**Interfaces:**
- `POST /fleet/:id/profile-intents` accepts exact `FleetProfileTuple`, returns only `requestId, expiresAt, tupleSummary`.
- `GET /fleet/:id/profile-intents/:requestId`; `DELETE /fleet/:id/profile-intents/:requestId`; `GET /fleet/:id/execution-authority` return redacted state only. **No approval endpoint.**

- [ ] **Step 1: RED tests at the actual `startDashboard(...)` HTTP middleware**: new sensitive route refuses all anonymous loopback requests despite existing legacy loopback behavior; refuses `?token=...` without Authorization Bearer; accepts a valid scoped Bearer admin; rejects invalid bearer, wrong role, spoofed `Host` or `Origin`, cross-site `Sec-Fetch-Site`, missing required CSRF defense, cross-instance request lookup, oversized body, method spoof, freeze and replay. Preserve existing unrelated auth behavior. Even successful POST only creates intent, no grant.
- [ ] **Step 2: Run** `npx vitest run tests/integration/dashboard-trusted-host-consent.test.ts` → FAIL.
- [ ] **Step 3: Implement protected routes and admin gate**; preserve existing unrelated legacy Fleet endpoints, but never let them indirectly mint/consume a grant.
- [ ] **Step 4: Run GREEN** plus `tests/integration/dashboard-fleet.test.ts`/`tests/integration/dashboard-runtime-settings.test.ts`; commit `feat: expose Fleet host consent requests without approval over HTTP`.

### Task 9: Close legacy tool and config bypass paths

**Files:**
- Modify: `src/tools/provision-tools.ts`, `src/provisioner/fleet-manager.ts`
- Create: `tests/integration/fleet-host-bypass.test.ts`

**Interfaces:**
- Legacy `provision_update`, `/fleet/:id/policy`, `/preset`, `/terminal` may not promote a request to trusted-host without the approved grant. If `toolsPreset` and `policyMode` are updated alongside trusted-host, route as **single logical transaction** or reject, never partial success.
- Leave historical host-owned explicit parent opt-in compatibility **intact**, while preventing automatic inheritance of that permit by `sandbox-required` children.

- [ ] **Step 1: RED tests on actual `src/tools/provision-tools.ts` `provision_update` (accepted keys: `autoRestart`, `toolsPreset`, `policyMode`, `terminalExecution`, legacy `allowCriticalInDanger`) and Dashboard's `/fleet/:id/{preset,policy,terminal}` routes**. A combined `full+danger+trusted-host` update without exact grant must leave all three fields unchanged (also test any ordering and stale grant). Separate standalone preset/policy updates retain legacy authorized behavior but cannot form an unauthorized trusted-host promotion. Parent host-owned startup opt-in must not silently elevate children still marked `sandbox-required`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/fleet-host-bypass.test.ts` → FAIL.
- [ ] **Step 3: Route every trusted-host transition through the same scope check/transaction**, even if invoked via an old `provision_update` field or direct setter. A request combining multiple fields must be all-or-nothing. Verify existing safe single-field operations remain compatible and no child inherits host powers merely from parent startup opt-in.
- [ ] **Step 4: Run GREEN**, legacy policy/provisioning suites; commit `fix: fail closed all alternate Fleet host profile setters`.

### Task 10: Mission Control one-Save UX and truthful statuses

**Files:**
- Modify: `packages/mission-control/src/screens/Fleet.tsx`, `packages/mission-control/src/types.ts`
- Modify: `tests/visual/spa-visual.test.ts` (existing browser-backed SPA harness); add Fleet modal scenario.

**Interfaces:**
- UI consumes `RedactedConsentView`; single Save creates intent or updates an already fully approved tuple; statuses `awaiting local confirmation`, `expired`, `persisted runtime unchanged`, `restart deferred`, `running verified`, `revoked execution uncertain`.
- Show copyable local terminal command without a secret grant or misleading “Save successful” toast. Keep destructive consequences explicit and keyboard accessible.

- [ ] **Step 1: RED integration/browser test**: Save once sends exactly one intent (not three setter POSTs), pending intent never shown as live, incorrect auth doesn't look successful, polling ends on terminal statuses, no auto-restart of active tunnel, keyboard/warning/accessible labels.
- [ ] **Step 2: Run** `npx vitest run tests/visual/spa-visual.test.ts` after `npm run build:mission-control`; expect RED on the old three-request UI.
- [ ] **Step 3: Implement modal state machine and clear recovery actions**, require explicit confirm for stop-and-apply; no link auto-executes a shell command.
- [ ] **Step 4: Run** `npm run build:mission-control && npx vitest run tests/visual/spa-visual.test.ts` → GREEN, then commit `feat: add zero-YAML Fleet trusted-host consent workflow`.

### Task 11: Platform qualification, compatibility docs and final verification

**Files:**
- Modify: `docs/mission-control.md`, `docs/security.md`, `docs/sandbox.md`
- Create: `tests/integration/fleet-trusted-host-conformance.test.ts`
- Update: `.github/workflows/ci.yml` only to add narrow guarded macOS-specific tests if needed, never to reduce existing gates.

**Interfaces:**
- Report per-gate results `PASS | FAIL | NOT_RUN | UNSUPPORTED`. MacOS real interactive acceptance on the user's own machine is external evidence and cannot be asserted by GitHub-hosted CI.

- [ ] **Step 1: RED compatibility matrix** covers v3.0.1 default/no-YAML configs, token/API key/OAuth, parent manual startup opt-in, linux unqualified behavior, Windows unsupported, existing saved Fleet instances/tunnels and default `requireInDanger: true`.
- [ ] **Step 2: Run targeted conformance tests** → FAIL until all behavior is wired; GREEN only after Task 10.
- [ ] **Step 3: Document one-time local operator flow, revoke, error/retry and downgrade/rollback**, and exact same-UID limitations; no implication of physical-presence verification.
- [ ] **Step 4: Execute `npm ci --ignore-scripts`, `npm --prefix packages/mission-control ci --ignore-scripts`, `npm run verify`, `npm run build`, `npm run smoke:http`, `npm run smoke:stdio`, `npm run docs:check`**; preserve machine-readable evidence and explain skipped platform gates.
- [ ] **Step 5: Require macOS real interactive acceptance and crash/power-loss compatibility evidence**; if unavailable, mark `MACOS_OPERATOR_ACCEPTANCE=NOT_RUN` and **DO NOT MERGE**.
- [ ] **Step 6: Submit independent security review on exact final product HEAD**, address blocking findings RED→GREEN and rerun GitHub 6-matrix CI. **Do not auto-merge/release**. Keep G59 worktrees and history unchanged.
- [ ] **Step 7: Only after separate maintainer approval**, merge product PR with expected HEAD SHA, verify exact-main CI, record docs closeout and carefully delete only fully merged worktree/branch.

## Review and execution hold

**Current state:** this is a **proposed written implementation plan**, not approval for code. PR #75 written spec was user-approved; the macOS primitive probe `38057786780` passed. The full macOS operator flow, same-UID assumptions, APFS crash durability and live Fleet integration remain unverified and are **merge-blocking external gates**, not false CI PASS claims. If any engineering task shows the approved OS/security invariant is infeasible, **STOP and return to a revised written spec**, not an improvised relaxation.

**Approval requested next:** explicitly approve **this exact written plan** and select **Native** or **Subagent-driven** execution. Merely choosing an execution label without explicitly approving the plan does **not** authorize product coding. Native is recommended for tightly coupled cross-file authorization changes, with mandatory independent security review before integration. No product code, merge or release is authorized by the spec approval or this document.
