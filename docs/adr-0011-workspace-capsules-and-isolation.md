# ADR-0011: Server-enforced Workspace Capsules and managed Git worktrees

- Status: Accepted, locally implemented
- Date: 2026-07-21

## Context

FolderForge already had path policy, approvals, workflows, HTTP identity, and
checkpoint artifacts, but no single server-owned object bound workspace,
principal/session, permission profile, budgets, expiry, revocation, isolation,
and task evidence. A profile label without runtime worktree proof would be easy
to bypass, and applying task output directly onto a dirty workspace could destroy
user work.

## Decision

1. Add a persisted Workspace Capsule manager and evaluate it in the shared tool
   registry before policy/approval handling.
2. Bind approval reuse to the complete execution context while retaining the raw
   principal id for self-approval prevention and operator display.
3. Treat non-empty capsule scopes as an allowlist for read/write, groups, or exact
   tools, and prevent source capsules from entering another managed worktree.
4. Add a Git worktree manager whose state lives in the Git common directory and
   whose apply operation requires a clean, unchanged byte-level source fingerprint.
   Journal the binary patch and untracked hashes before mutation, never replay an
   uncertain apply, and require exact-source rollback before discard.
5. Make Propose/Autopilot mutations require a worktree identity known to the
   manager.
6. Deny generic command execution in every capsule in worktree capsules until an OS process
   sandbox can enforce filesystem and network boundaries.
7. Keep capsule enforcement `optional` by default for backward compatibility;
   remote deployments can select `remote` or `all`.

## Consequences

- Dirty user state is never stashed or reset by isolation creation.
- Worktree changes receive an explicit review/apply/rollback/discard boundary.
- Session, workspace, client, capsule, and task changes invalidate approvals.
- The current worktree path is Git-only; checkpoint fallback remains incomplete.
- Propose/Autopilot cannot yet run project commands, so the repository does not
  claim a complete autonomous verification loop inside the sandbox.

## Rollback

The feature can be disabled by keeping `capsule.enforcement: optional` and not
creating capsules. Managed task worktrees can be discarded individually. No
source Git history is rewritten, and no remote operation is performed.
