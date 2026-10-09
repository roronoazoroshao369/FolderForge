# G58 Managed Isolation Health and Safe Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FolderForge report truthful managed-worktree health and refuse destructive isolation operations when the physical Git worktree identity or recovery state is missing, mismatched, or unverifiable, without touching either historical source-dirty isolation record.

**Architecture:** Preserve the v1 persisted `WorktreeIsolation` schema and the existing `ToolRegistry`/policy/approval/audit execution path. Add one read-only health inspector under `src/isolation/`; expose additive observations through `WorktreeManager`, existing MCP tools, Mission Control and operator diagnostics. Gate worktree-dependent and destructive actions with a *fresh* identity check, not with cached list data; no implicit restoration, cleanup or replay.

**Tech Stack:** TypeScript 6; Node.js 22/24; native `git` via bounded `spawnSync`; Vitest 4 and `fast-check` where useful; existing React/Vite Mission Control; MCP stdio and authenticated HTTP; GitHub Actions 6-job CI matrix.

**Spec:** `docs/superpowers/specs/2026-10-09-goal58-isolation-recovery-design.md`; see also `docs/superpowers/specs/2026-10-09-trusted-agent-workstation-design.md`.

## Global Constraints

- Design for **local-first** Git worktrees; no new external service, AI model, tool family, dependency or metadata storage schema.
- Source release: npm `3.0.1` is immutable. Do not publish a new package or create tags as part of G58.
- `WorktreeIsolation.state` stays `active | applying | applied | rolled_back | discarded`; `sourceDirty` always means *source dirty at creation*.
- `observedHealth` is ephemeral only: `present_consistent | missing_worktree | identity_mismatch | unverifiable | terminal_record`; `observedAt` must be an ISO UTC timestamp.
- Do not change persisted `.git/folderforge/isolations.json` as a side effect of inspection. Preserve existing `WorktreeManager.list()` semantics because `persist()` serializes its return value.
- Errors do not silently become `clean`, `discarded` or a verified recovery. Unknown/permission/timeout is `unverifiable`, not `missing_worktree`.
- Never run `git worktree prune`, `git branch -D`, `git reset`, `git stash` or `git checkout` against historical entries as a remediation shortcut.
- Preserve operator-only HIGH-risk apply/rollback/discard and fail-closed source fingerprint, Capsule, approval and audit checks. Browser/UI actions must not bypass `ToolRegistry`.
- Never auto-replay `outcome_uncertain` mutations after restart or transport loss.
- No artificial beta-user, Podman, soak, branch-protection or attestation claims. CI skips are `NOT_RUN`.
- Approved **spec** is not approval to implement this **plan**; execution starts only after a separate maintainer review of the plan and execution-mode choice.

## Read-only baseline of historical records (2026-10-09)

The actual main-workspace `.git/folderforge/isolations.json` was inspected **read-only**. Its SHA-256 was `47a189d85d05c4ef651886679cbf9e4e34be6d552f8a162a42e180441e0f4074`; mode `0600`, 1406 bytes. The two managed directories and refs `folderforge/task/mission-control-agent-loop-4eb8b283` and `folderforge/task/canonical-path-identity-4225a61f` were absent; `git worktree list --porcelain` showed only the currently checked-out repository worktree. The recorded base commits `54dfc1abb6c717c72d93446c1cc2c460ba8d5587` and `af1b5957a1dbce583e61501c4c9b686be7e5a430` were still readable Git commit objects. None of these facts proves that missing uncommitted/untracked task bytes are recoverable. The metadata and refs were not mutated. Re-observe at execution time; never use this historical snapshot as mutation authorization.

## Review Focus

Each of the five highest-risk inputs below is assigned an explicit RED/GREEN test in the owning task:

1. **Dirty task changes followed by missing worktree:** Task 1 detects `missing_worktree` without reclassifying a historical `active` record as safe or merging/erasing its branch.
2. **Wrong repository, symlink or wrong branch occupying registered path:** Task 1 returns `identity_mismatch` and Task 3 rejects destructive operations before touching source or refs.
3. **Git process permission failure, timeout, malformed porcelain or transient I/O error:** Task 1 returns `unverifiable`; Task 2 preserves an explicit error code, not empty status/diff.
4. **Worktree/branch replacement after an earlier health snapshot:** Task 3 revalidates immediately before apply/rollback/discard; fault-injected fixture proves no branch deletion when identity changed.
5. **Old server reply lacks `observedHealth` or health changes during UI confirmation:** Task 4 renders an unknown state, hides unsafe discard controls and shows a safe server rejection; no client-side green assumption.

---

## File Structure and Explicit Interfaces

| File | Responsibility |
| --- | --- |
| Create `src/isolation/worktree-health.ts` | Read-only, bounded Git health probe and typed observation, separate from lifecycle persistence |
| Modify `src/isolation/worktree-manager.ts` | `inspect(id)` / `listObserved()`, mutation-time checks, stable health exception, no persistence migration |
| Modify `src/tools/isolation-tools.ts` | Additive `isolation_list` report; stable error data in `isolation_status` / `isolation_diff` |
| Modify `src/dashboard/server.ts` | Use observed list for `GET /isolations` and `GET /mission-control`; existing HIGH-risk mutations still use governed registry |
| Modify `packages/mission-control/src/screens/Overview.tsx` | Read-only health, human-readable recovery status, fail-closed discard affordance |
| Modify `src/doctor/index.ts` **only if existing diagnostics support an additive row without new side effects** | Optionally disclose aggregate health; Mission Control is the required operator surface |
| Tests `tests/unit/worktree-manager.test.ts` | Real Git fixtures: health, identity, unknown failures, restart/journal, mutation guards |
| Tests `tests/unit/worktree-health.test.ts` | Injected Git probe failures, classifications and result sanitization |
| Tests `tests/integration/isolation-tools.test.ts` | Existing MCP registry, stable errors, access controls, additive compatibility |
| Tests `tests/integration/dashboard-admin.test.ts` | HTTP operator snapshot, authorization and rejecting unsafe discard |
| Tests `tests/visual/spa-visual.test.ts` (existing fixture conventions) | Overview UI health/disabled-action screenshot and accessibility smoke |
| Docs `docs/task-isolation.md`, `docs/mission-control.md`, `docs/CURRENT_FRONTIER.md`, `docs/HANDOFF.md` | Semantics, recovery runbook, exact evidence and next handoff |

**Contracts planned for Task 1:**

```ts
export type ObservedWorktreeHealth =
  | 'present_consistent'
  | 'missing_worktree'
  | 'identity_mismatch'
  | 'unverifiable'
  | 'terminal_record';
export type ObservedBranchRef = 'present' | 'absent' | 'unverifiable';
export interface IsolationHealthObservation {
  observedHealth: ObservedWorktreeHealth;
  observedAt: string;
  branchRef: ObservedBranchRef;
  registeredWorktree: boolean | null;
  diagnosticCode: string;
}
export interface GitHealthProbe {
  // Default implementation executes bounded, read-only Git queries.
  // Injectable test adapter may raise typed permission/timeout errors.
  inspect(record: WorktreeIsolation): {
    pathKind: 'missing' | 'directory' | 'symlink' | 'other';
    registeredWorktree: boolean;
    branchRef: ObservedBranchRef;
    topLevel?: string;
    commonDir?: string;
    branch?: string;
  };
}
export function inspectWorktreeHealth(
  isolation: WorktreeIsolation,
  probe?: GitHealthProbe,
): IsolationHealthObservation;
```

The default probe must verify actual Git registration, canonical `--show-toplevel`, `--git-common-dir` and actual branch identity. Classify a registered-but-missing path, inaccessible Git, unsupported porcelain or inconsistent ownership as `unverifiable` / `identity_mismatch`, never as a confidently safe missing entry. Run `git` with argument arrays, no shell, bounded stdout/stderr and timeout. Do not read arbitrary file content.

**Contracts planned for Tasks 2–3:**

```ts
export type ObservedIsolation = WorktreeIsolation & IsolationHealthObservation;
export class WorktreeManager {
  inspect(id: string): IsolationHealthObservation;
  listObserved(): ObservedIsolation[];
}
export class IsolationHealthError extends Error {
  readonly code:
    | 'ISOLATION_WORKTREE_MISSING'
    | 'ISOLATION_IDENTITY_MISMATCH'
    | 'ISOLATION_HEALTH_UNVERIFIABLE';
}
```

`list()` and stored `WorktreeIsolation` must remain byte-for-byte compatible. `IsolationHealthError` can be placed alongside the health inspector and mapped into `ToolResult.data` as `{ code, observedHealth }` without adding a new tool.

### Task 1: Read-only Git health inspector and truthful classifications

**Files:**
- Create: `src/isolation/worktree-health.ts`
- Create: `tests/unit/worktree-health.test.ts`
- Test: `tests/unit/worktree-manager.test.ts` (real Git fixture verifies inspector behavior)

**Interfaces:**
- Consumes: existing `WorktreeIsolation` shape exported from `src/isolation/worktree-manager.ts`.
- Produces: `ObservedWorktreeHealth`, `ObservedBranchRef`, `IsolationHealthObservation`, `GitHealthProbe`, `inspectWorktreeHealth(record, probe?)` as above.

- [ ] **Step 1: Write failing classifier tests** named `classifies missing unregistered worktree without mutation`, `rejects symlink or foreign worktree`, `does not mislabel Git probe failures as missing`, and `keeps terminal records observational`, using real temporary repository plus fake `GitHealthProbe`. Include assertions `expect(result.observedHealth).toBe('missing_worktree')`, `expect(result.branchRef).toBe('present')`, `expect(result.diagnosticCode).toBe('ISOLATION_WORKTREE_MISSING')`, and `expect(afterMetadataBytes).toEqual(beforeMetadataBytes)`. Assert: valid registered root gives `present_consistent`, missing root plus absent registration gives `missing_worktree`, branch can independently be present/absent, symlink/wrong repo/wrong branch gives `identity_mismatch`, permission/timeout/invalid probe output gives `unverifiable`, and discarded record gives `terminal_record`.
- [ ] **Step 2: Run the focused test and confirm RED:** `npx vitest run tests/unit/worktree-health.test.ts`. Expected: failure due to missing implementation/import or missing expected classification, not due to fixture setup.
- [ ] **Step 3: Implement read-only probe** using `lstatSync` and Git `--no-optional-locks` process calls; parse worktree registration robustly for spaces/Unicode, cap execution time and output; normalize raw errors to non-secret diagnostic codes. Never mutate metadata, refs, journal or worktree.
- [ ] **Step 4: Verify GREEN:** `npx vitest run tests/unit/worktree-health.test.ts tests/unit/worktree-manager.test.ts`. Assert unchanged `isolations.json` bytes, Git refs, index and worktree list before/after repeated health observations.
- [ ] **Step 5: Commit:** `git add src/isolation/worktree-health.ts tests/unit/worktree-health.test.ts tests/unit/worktree-manager.test.ts && git commit -m "feat: observe managed worktree identity without mutation"`.

### Task 2: Preserve lifecycle schema; surface observed health through governed MCP

**Files:**
- Modify: `src/isolation/worktree-manager.ts`
- Modify: `src/tools/isolation-tools.ts`
- Test: `tests/unit/worktree-manager.test.ts`
- Test: `tests/integration/isolation-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 `inspectWorktreeHealth` / `IsolationHealthObservation`.
- Produces: `WorktreeManager.inspect(id): IsolationHealthObservation` and `listObserved(): ObservedIsolation[]`; existing `isolation_list` gains optional observed fields per entry, retaining all current top-level data and lifecycle fields.

- [ ] **Step 1: Add failing tests** named `listObserved preserves persisted lifecycle and marks missing worktree` and `isolation_list exposes health without write`. Assert `expect(manager.list()[0]?.state).toBe('active')`, `expect(manager.listObserved()[0]?.observedHealth).toBe('missing_worktree')`, `expect(result.data.isolations[0].observedAt).toMatch(/^\d{4}-/)`. Create an isolation, run `git worktree remove --force <fixture-worktree-root>` **only in the disposable fixture** (removes Git registration but retains branch/ref), and show that legacy `list()` remains `state:'active'` and identical serialized content while `listObserved()`/`isolation_list` expose `observedHealth:'missing_worktree'` with ISO timestamp and branch state. Assert repeat/restart does not rewrite `isolations.json`. Use a real `registry.callAgent('isolation_list', {})` for policy coverage.
- [ ] **Step 2: Verify RED:** `npx vitest run tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts`; new assertions must fail specifically because `inspect`/`listObserved`/observed response are missing.
- [ ] **Step 3: Implement the two manager methods** without changing `list()`, `persist()`, v1 digest format, create/apply semantics or tool registry classification. Wire `isolation_list` to `listObserved()`. If Git observations fail, expose `unverifiable` rather than omit the entry or claim clean.
- [ ] **Step 4: Verify GREEN and package types:** `npx vitest run tests/unit/worktree-health.test.ts tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts` and `npm run typecheck`. Check agent role still denied for `isolation_apply`.
- [ ] **Step 5: Commit:** `git add src/isolation/worktree-manager.ts src/tools/isolation-tools.ts tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts && git commit -m "feat: expose truthful isolation health through MCP"`.

### Task 3: Fail-closed mutation and stable missing-worktree errors

**Files:**
- Modify: `src/isolation/worktree-manager.ts`
- Modify: `src/tools/isolation-tools.ts`
- Modify: `src/isolation/worktree-health.ts`
- Test: `tests/unit/worktree-manager.test.ts`
- Test: `tests/integration/isolation-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 inspector; Task 2 manager observations.
- Produces: `IsolationHealthError.code` with stable values above; one private manager preflight for `status`, `diff`, `apply`, `rollback` and `discard`; task-local opt-in fault-injection hook for interleaving before the final mutation check.

- [ ] **Step 1: Write failing regressions** named `discard retains missing worktree branch and metadata`, `rollback denies missing journal`, `status returns stable missing code` and `refuses identity mismatches`. Assert `expect(() => manager.discard(id)).toThrow(/ISOLATION_WORKTREE_MISSING/)`, `expect(git(root, 'rev-parse', 'refs/heads/' + branch)).toBe(branchHeadBefore)`, and `expect(readFileSync(statePath)).toEqual(stateBytesBefore)`. Cover missing worktree with **live unmerged task commit** and absent Git registration after a fixture-only `git worktree remove --force` must make `discard()` refuse without `worktree prune` or `branch -D`, leaving branch HEAD and metadata intact; wrong repo and symlink fail closed; `rollback()` with missing/corrupt journal does not mutate source; sourceDirty/source-drift invariants preserved.
- [ ] **Step 2: Add TOCTOU and uncertain-outcome tests:** injected hook swaps/removes a temporary worktree/branch between initial observation and final preflight; assert no destructive command is invoked and error remains explicit; restart does not replay. Do not claim atomic protection against an external actor racing *after* the final preflight. Confirm `status` and `diff` return structured `ISOLATION_WORKTREE_MISSING` / `ISOLATION_IDENTITY_MISMATCH` / `ISOLATION_HEALTH_UNVERIFIABLE` codes through the existing tool pathway.
- [ ] **Step 3: Verify RED:** `npx vitest run tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts`. Ensure the missing-worktree discard regression fails on old `prune`/`branch -D` behavior, not because a fixture is invalid.
- [ ] **Step 4: Implement targeted mutation-time guards** immediately before any `worktree remove`, rollback reverse patch, `git apply`, or ref deletion. Remove the missing-directory `git worktree prune` branch from the task discard path. Keep operator-only HIGH risk approvals, audit and existing successful clean/dirty worktree discard contract; do not add a self-repair endpoint. Use a structured health error as `ToolResult` and keep legacy textual error for clients that only render `error`.
- [ ] **Step 5: Verify GREEN:** `npx vitest run tests/unit/worktree-health.test.ts tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts tests/unit/workspace-capsule-manager.test.ts`, then `npm run typecheck`. Explicitly document that Git filesystem TOCTOU cannot be guaranteed atomically across external actors; final fresh preflight is mitigation, not mathematical proof.
- [ ] **Step 6: Commit:** `git add src/isolation/worktree-health.ts src/isolation/worktree-manager.ts src/tools/isolation-tools.ts tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts && git commit -m "fix: refuse destructive isolation operations on unverified worktrees"`.

### Task 4: Truthful operator Mission Control and read-only HTTP diagnostics

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `packages/mission-control/src/screens/Overview.tsx`
- Test: `tests/integration/dashboard-admin.test.ts`
- Test: `tests/visual/spa-visual.test.ts`

**Interfaces:**
- Consumes: `WorktreeManager.listObserved()` and `IsolationHealthObservation` from Task 2.
- Produces: additive `observedHealth`/`observedAt` on existing `GET /mission-control` and `GET /isolations`; UI reports separate lifecycle and observed health, with no new dangerous endpoint.

- [ ] **Step 1: Write failing HTTP tests** named `reports missing isolation health in both snapshots` and `rejects unsafe operator discard`. Assert `expect((await response.json()).isolations[0].observedHealth).toBe('missing_worktree')`, `expect(unsafeDiscard.status).toBe(409)`, and identical metadata/refs after rejection. Using existing dashboard fixture: `GET /mission-control` and `GET /isolations` include `observedHealth:'missing_worktree'` for a missing path; operator POST `/mission-control/isolations/:id/discard` and POST `/isolations/:id/discard` both fail safely and preserve metadata/refs. Assert admin/auth separation and no response leaks raw tool arguments.
- [ ] **Step 2: Verify RED:** `npx vitest run tests/integration/dashboard-admin.test.ts`. The response schema and missing-worktree safeguards must fail on baseline code.
- [ ] **Step 3: Wire HTTP snapshots** to observed results, then update `OverviewScreen` `ManagedIsolation` type to include optional observation fields. Show localized labels `Available`, `Worktree missing`, `Identity mismatch`, `Unable to verify`; if health is absent/unknown, display `Health unavailable` and hide destructive controls. Keep `state` pill to avoid confusing lifecycle with health.
- [ ] **Step 4: Add UI regression test** in `tests/visual/spa-visual.test.ts` following its established deterministic fixtures: missing-worktree card must show an accurate health label with no enabled `Discard` control, and confirmation already open must still show a safe server error if health changes after click. Include accessible text and keyboard focus assertions where the harness supports them. Review new screenshot baseline diffs rather than blindly updating them.
- [ ] **Step 5: Verify GREEN:** `npx vitest run tests/integration/dashboard-admin.test.ts tests/visual/spa-visual.test.ts` and `npm run build:mission-control`. Existing success-path approved discard remains governed.
- [ ] **Step 6: Commit:** `git add src/dashboard/server.ts packages/mission-control/src/screens/Overview.tsx tests/integration/dashboard-admin.test.ts tests/visual/spa-visual.test.ts && git commit -m "fix: report isolation health and disable unsafe dashboard discard"`.

### Task 5: Forensic classification, public MCP checks, documentation and release gates

**Files:**
- Modify: `docs/task-isolation.md`
- Modify: `docs/mission-control.md`
- Modify: `docs/CURRENT_FRONTIER.md`
- Modify: `docs/HANDOFF.md`
- Create: `docs/project/GOAL58_ISOLATION_EVIDENCE.md`
- Test: `tests/integration/isolation-tools.test.ts` (public contract smoke), existing `scripts/smoke-stdio.mjs` and `scripts/smoke-http.mjs`

**Interfaces:**
- Consumes: Task 1–4 final health responses and structured errors.
- Produces: reproducible read-only operator forensic runbook and evidence table; no mutation endpoint or automatic cleanup.

- [ ] **Step 1: Run read-only forensic inventory against actual FolderForge workspace**, before making any repair claim. Record current source HEAD, `git worktree list --porcelain`, `show-ref --verify` for each historical branch, `git cat-file -t` for recorded commits, journal existence/hash (not contents), isolation state digest/hash, directory lstat, and `isolation_list` response. Write only a **redacted diagnostic report** to project documentation *after* the read-only observations. Never touch the historical state/refs/worktree paths with modifying operations.
- [ ] **Step 2: Add public transport acceptance tests** in `tests/integration/isolation-tools.test.ts` and existing stdio/HTTP smoke harness: missing path yields `missing_worktree` in list and explicit errors in status/diff, preserving policy/admin guards. If a transport behavior is absent, capture RED before fixing it; if functionality already passes via Tasks 1–4, record GREEN without fabricating a prior failing test.
- [ ] **Step 3: Verify the public acceptance fixture** (`npx vitest run tests/integration/isolation-tools.test.ts`); repair only observed RED failures via a separate focused RED→GREEN cycle, then document diagnostic codes, UI labels, operator action guidance, backup evidence procedure and safe rollback. Do not label historical data repaired unless operator independently signs off.
- [ ] **Step 4: Run full repo gates:** `npm run verify`, `npm run docs:check`, `npm run smoke:stdio`, `npm run smoke:http`, `npm run architecture:check`, `git diff --check`. For HIGH-risk behavior also run `npx vitest run tests/unit/worktree-health.test.ts tests/unit/worktree-manager.test.ts tests/integration/isolation-tools.test.ts tests/integration/dashboard-admin.test.ts`; check full visual, coverage/fuzz and fail-injection gates per `.github/workflows/ci.yml`.
- [ ] **Step 5: Commit:** `git add docs/task-isolation.md docs/mission-control.md docs/CURRENT_FRONTIER.md docs/HANDOFF.md docs/project/GOAL58_ISOLATION_EVIDENCE.md tests/integration/isolation-tools.test.ts && git commit -m "docs: preserve forensic isolation evidence and recovery runbook"`.
- [ ] **Step 6: Create and review implementation PR** (after explicit plan and execution-mode approval) and require exact-head CI success for all six platform/Node jobs; log every skipped step as `NOT_RUN`, never `PASS`. Review branch diff and contents, then merge only if user has approved the integration under their chosen workflow.
- [ ] **Step 7: Verify post-merge** run against the actual merge SHA; compare source tree state, local and GitHub branches, test results, public MCP health and historical records. Clean *only* completed temporary branches after verifying merged tree. **Do not** prune or delete the historical isolation records in this goal without separate operator authorization.
- [ ] **Step 8: Handoff next goal** with IDs, exact commits/CI links, residual risk, unresolved forensic evidence and the next prompt for G59 protocol compatibility discovery.

## Plan Self-Review & Explicit Boundaries

- Spec sections 1–5 covered by Tasks 1–3 and Task 5; proposed health model, metadata preservation and recovery decision tree are implemented without auto-prune.
- Section 6 mapping covered by Tasks 2–4; `doctor` is optional because MCP and Mission Control are the required surfaces; if a doctor row is added, cover it with `tests/unit/doctor.test.ts` in Task 4's RED/GREEN.
- Section 7 acceptance matrix covered by Tasks 1–4, including branch missing, sourceDirty, journal damage, restart, concurrent changes, non-Git and corrupt digests.
- Sections 8–10 covered by Task 5; **no automatic repair**, new tag, or publish.
- Residual risks to report: Git external TOCTOU, lost untracked bytes cannot be reconstructed, unknown historical branch reachability, incomplete platform steps and external beta gap.
- Definition of success is **truthful observed health and fail-closed operations**, not silent removal of old entries; operator review is a separate action and authority.

## Execution Handoff

Plan written after maintainer approval of PR #58 **design only**. Wait for explicit human approval of this plan and selection of **Subagent-driven** or **Native** mode before implementing Task 1. Recommend **Subagent-driven** because task boundaries cross persisted Git state, high-risk destructive paths, MCP clients and operator UX, where fresh independent reviews after each task reduce data-loss risk.
