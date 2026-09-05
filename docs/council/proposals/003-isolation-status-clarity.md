# Proposal 003: Separate isolation task delta from working-tree dirtiness

- Author role: Architect
- Date: 2026-09-05
- Status: implemented
- ADR link: docs/adr-0011-workspace-capsules-and-isolation.md

## Problem

Council #26 interpreted isolation_status.clean=false as uncommitted work.
The manager actually compares against isolation.baseCommit: a committed task
can have clean=false while Git status against HEAD is empty. The old task was
already an ancestor of main. An ambiguous diagnostic must not prompt cleanup
or patch replay. Apply/rollback responses additionally describe the source,
whereas isolation_status describes the task worktree.

## Proposal

Preserve existing clean, changed, untracked and conflicts fields and semantics.
Add two diagnostic fields to WorktreeStatus (including apply/rollback results):

- comparison: { target: 'worktree' | 'source', baseCommit: string }.
  Worktree uses isolation.baseCommit; source uses isolation.sourceHead.
- workingTree: { headCommit: string, clean: boolean, staged: string[],
  unstaged: string[], untracked: string[], conflicts: string[] }.
  Staged compares index with the observed HEAD; unstaged compares files with
  index. clean requires all four path lists to be empty. This must detect
  index/worktree changes that cancel out in a net diff against HEAD.

Read Git path inventories using NUL delimiters, disable optional locks for new
reads, and avoid external diff/textconv execution. Ignored paths are excluded.
This is an observational multi-command snapshot, not an atomic authorization
or merge-safety claim. Update tool descriptions and docs with a committed-only
example, the source/worktree distinction, and historical sourceDirty meaning.

No new tool or input; no risk/audience/mutates changes. Do not edit
src/tools/schema-lock.ts or persisted state schema. The frozen
name/mutates/risk contract remains intact; no major-version change is proposed.
Do not change clean to HEAD-relative: legacy consumers use it for task delta.
Do not implement lifecycle reconciliation, automatic cleanup, merge detection,
UI screens, merge/push/publish, or changes to apply/rollback safety gates.

## Threat surface (Security hat)

No new principal, authority, network exposure, credential access or file-content
output. Additional output contains commit ids and relative path inventories
already in the governed repository boundary. Use argument arrays, not a shell.
Status reads must not refresh the index or mutate lifecycle metadata. Errors
must propagate rather than defaulting to clean. Existing identity checks and
mutation revalidation remain unchanged. A clean diagnostic is never approval
to discard or apply. Production isolation and live MCP must not be restarted
or modified for proof; use a read-only built-manager inspection or disposable
fixture through the policy pipeline.

## Test plan (QA hat)

- Fresh task: legacy and HEAD-relative clean, correct target/base/head.
- Committed-only task: legacy clean=false, workingTree.clean=true; unchanged
  after its commit is fast-forwarded into a disposable source main.
- Staged edit plus worktree restored to HEAD: both lists populated even when
  net HEAD diff is empty; legacy behavior unchanged.
- Pure unstaged, untracked paths with spaces/non-ASCII and rename/delete paths.
- Real unresolved merge conflict in a disposable repo is explicitly reported.
- Apply/rollback source results have target=source and correct workingTree
  state; existing dirty-source, drift, symlink, journal and admin-only tests pass.
- Registry integration exposes additive fields and preserves denied agent apply.
- Targeted worktree-manager, isolation-tools, schema-lock and dashboard-admin
  tests, then project_verify typecheck/lint/test/build with full test suite.
- Built-code proof: inspect the existing committed-only isolation without
  modifying it; report both clean values and comparison refs; verify Git/index
  remain unchanged. This does not reload the connected MCP server.

## Rollback

Revert this bounded change on the council branch through policy-approved Git
operations. No migration, remote operation or runtime restart is required.
Keep existing worktrees and recovery journals intact. Merge/push/publish and
any destructive cleanup require explicit operator approval.

## Decision log

- 2026-09-05 — User — approve goal — selected isolation status clarity for council #27.
- 2026-09-05 — Architect — propose — additive comparison/workingTree diagnostics; preserve all legacy semantics.
- 2026-09-05 — Security Officer — amend — disable optional locks and external diff/textconv for new reads; no content output, lifecycle mutation or authorization claims.
- 2026-09-05 — QA/Verifier — amend — require cancelling staged/unstaged and source apply/rollback cases, committed-and-merged fixture, conflict case, and unchanged-state build proof.
- 2026-09-05 — Security Officer — approve implementation plan — constraints incorporated; not approval for merge/push/publish or cleanup.
- 2026-09-05 — QA/Verifier — approve implementation plan — tests/gates required; no implementation completion claim before evidence.
- 2026-09-05 — QA/Verifier — partial verification — targeted 4 files / 33 tests PASS (7 new regression tests); typecheck, lint and build PASS through project_verify. Both full-suite attempts were cancelled after MCP request timeouts; no full-suite PASS evidence.
- 2026-09-05 — Security Officer — hold — stop repeated full-suite execution after two timeouts. No commit, merge, push, publish, runtime restart or isolation cleanup. Keep changes on council/isolation-status-clarity for operator review.

## Historical verification checkpoint (before operator approval)

At this checkpoint implementation, tests, guide and CHANGELOG were present
locally, but the proposal remained approved pending full-suite evidence.

- Targeted: worktree-manager 16, isolation-tools 2, schema-lock 9,
  dashboard-admin 6; all 33 tests passed.
- project_verify: typecheck PASS, lint PASS; initial combined run was cancelled
  during test and skipped build. Separate build run PASS, including SPA build.
  Separate test-only run was also cancelled after request timeout. These are
  incomplete verification runs, not evidence of a test assertion failure or
  permission to bypass the required gate.
- Fresh built WorktreeManager inspected the existing canonical-path-identity
  isolation read-only: legacy clean=false with 17 changed paths; comparison
  target=worktree and recorded base; workingTree.clean=true with all four lists
  empty. Its HEAD remains an ancestor of main; active/sourceDirty-at-creation
  metadata remains unchanged. No connected MCP restart was performed.
- Before/after this bounded proof, all 17 file hashes, HEAD, branch and index
  bytes were equal. This is a measurement around the proof, not a claim that
  every index byte stayed fixed throughout the whole council session.
- Main and origin/main references remain aecd85f6; schema-lock and dependency
  manifests are unchanged. No commit was made because the full gate is missing.

Resume only with an operator-reviewed way to complete durable project_verify
full-suite evidence within the MCP execution limits. The existing run_test
async option may supply supplementary test evidence, but is not silently
substituted for the specifically required project_verify test gate. Do not
change tests, policy, timeouts or transport code as a hidden second goal.

## Resumed verification and operator decision

- 2026-09-05 02:39 PDT — User — explicitly approved commit, merge to main and
  push after reviewing the timeout blocker, then opening the next goal.
- QA/Verifier — PASS: the unchanged npm full suite completed through the existing
  governed run_test async path: 131 files / 1030 tests, duration 72.90 seconds.
  All source/test blobs matched the previously reviewed patch before this run.
- Typecheck, lint and build already passed through project_verify on the same
  source; targeted tests passed 33/33 and the built-manager live proof passed.
- Reporting exception is explicit: the two synchronous project_verify test
  runs remain cancelled/incomplete. They are not relabelled as PASS; the user
  authorized proceeding and complete full-suite evidence is now available from
  the asynchronous runner. No test script, timeout, transport or policy change.
- Security Officer + QA/Verifier — approve implementation handoff with that
  documented exception and the user's Git authorization. No new authority,
  lifecycle/schema-lock changes, runtime restart, npm publication or cleanup.
- Scribe — mark proposal implemented; retain the earlier blocker and decisions
  as history. Record actual commit/merge/push references in the Notion track log.
