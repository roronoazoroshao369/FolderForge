# Managed task isolation

FolderForge can create a task branch in a Git worktree without stashing,
resetting, or modifying the user's working tree.

## Lifecycle

```text
isolation_create
→ work in returned worktree root
→ isolation_status / isolation_diff
→ operator isolation_apply or isolation_discard
```

Agent-visible tools:

- `isolation_list`
- `isolation_create`
- `isolation_status`
- `isolation_diff`

Admin-only tools:

- `isolation_apply`
- `isolation_discard`

The dashboard exposes equivalent `/isolations` endpoints. HIGH-risk apply and
discard calls are routed through the shared registry. In safe/dev modes, an
explicit dashboard action resolves the exact operator-action approval before the
retry executes.

## Storage and identity

Worktrees are placed below the repository's Git common directory:

```text
.git/folderforge/worktrees/<isolation-id>
```

Lifecycle metadata is atomically persisted with mode `0600` and a SHA-256
integrity digest at:

```text
.git/folderforge/isolations.json
```

The state file and temporary replacements are denied to native file tools.
Corrupt, duplicate, identity-inconsistent, or schema-invalid state fails closed.
Capsule path checks also prevent a source workspace session from entering a
different managed task worktree.
Each record captures task id, source root, branch, base commit, source HEAD,
source-status fingerprint, dirty-at-creation flag, timestamps, and lifecycle
state.

## Change safety

Creation records the source workspace but does not clean it. A dirty source can
still receive an isolated worktree, but apply is refused.

Apply succeeds only when all of these hold:

1. the source was clean at creation;
2. source HEAD and porcelain status still match the recorded fingerprint;
3. the worktree has no unresolved conflicts;
4. tracked outputs are regular files or deletions, never symlinks/submodules;
5. untracked outputs are regular non-symlink files, at most 100 files and 10 MiB;
6. every target remains inside the source root and no untracked target exists;
7. `git apply --check --binary` succeeds before mutation.

Tracked patch application and untracked copies are treated as one operation. On
a copy failure, copied files are removed and the tracked patch is reversed. If
that rollback also fails, FolderForge reports the outcome as unsafe instead of
claiming success.

Discard removes the worktree and its generated task branch. It never runs
`reset`, `stash`, `checkout`, or history rewrite in the source workspace.

## Availability

Worktree isolation is available only when the activated default project is the
root of a Git repository. Non-Git folders and nested subproject activations remain
usable for existing FolderForge features, while isolation reports an explicit
unavailable reason. A filesystem checkpoint fallback is still a roadmap item.
