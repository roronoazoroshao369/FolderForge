# Managed task isolation

FolderForge can create a task branch in a Git worktree without stashing,
resetting, or modifying the user's working tree.

## Lifecycle

```text
isolation_create
→ work in returned worktree root
→ isolation_status / isolation_diff
→ operator isolation_apply
→ operator isolation_rollback when needed
→ isolation_discard after rollback or before apply
```

Agent-visible tools:

- `isolation_list`
- `isolation_create`
- `isolation_status`
- `isolation_diff`

Admin-only tools:

- `isolation_apply`
- `isolation_rollback`
- `isolation_discard`

The dashboard exposes equivalent `/isolations` endpoints. HIGH-risk apply,
rollback, and discard calls are routed through the shared registry. In safe/dev modes, an
explicit dashboard action resolves the exact operator-action approval before the
retry executes.

## Reading status: task delta is not working-tree dirtiness

`isolation_status` preserves its legacy `clean`, `changed`, `untracked` and
`conflicts` fields. `changed` compares tracked files with the recorded task
base, not the current HEAD. Legacy `clean` means that this base-relative change
set, untracked paths and conflicts are empty. A committed task can therefore
have `clean: false` while its Git working tree is clean.

Use the additive fields to avoid ambiguity:

- `comparison.target`: `worktree` for `isolation_status`; `source` for the
  status returned by operator apply/rollback.
- `comparison.baseCommit`: the reference used for legacy `changed`/`clean`;
  task `baseCommit` for worktree, recorded `sourceHead` for source.
- `workingTree.headCommit`: the HEAD observed for that target.
- `workingTree.clean`: true only when staged, unstaged, untracked and conflict
  path inventories are all empty.
- `workingTree.staged`: index versus the observed HEAD.
- `workingTree.unstaged`: working files versus index.
- `workingTree.untracked` and `workingTree.conflicts`: current Git inventories.

For example, after committing `file.txt` on a task branch:

```json
{
  "clean": false,
  "changed": ["file.txt"],
  "untracked": [],
  "conflicts": [],
  "comparison": { "target": "worktree", "baseCommit": "<task-base>" },
  "workingTree": {
    "headCommit": "<task-head>",
    "clean": true,
    "staged": [],
    "unstaged": [],
    "untracked": [],
    "conflicts": []
  }
}
```

Conversely, a staged edit followed by restoring the working file to HEAD can
produce legacy `clean: true` with `workingTree.clean: false`: the staged and
unstaged changes cancel in the net diff but both still exist.

`isolation_diff` remains a binary patch against the task base, including
committed task changes. `isolation.sourceDirty` describes the source **at task
creation**, not current dirty state. Lifecycle `active` is independent of Git
cleanliness and does not prove that task commits are unmerged.

Paths are NUL-delimited when read from Git, so spaces and Unicode are retained;
ignored files are excluded. The response is an observational, multi-command
snapshot, not an atomic transaction or authorization to apply/discard. Errors
are reported rather than converted to a clean result. Mutation-time identity,
source-drift, journal and approval checks remain mandatory and unchanged.

## Physical health versus persisted lifecycle

`isolation_list`, `GET /isolations` and `GET /mission-control` include fresh read-only `observedHealth`, `observedAt`, `branchRef` and optional `diagnosticCode`. They do **not** rewrite the persisted v1 schema. A record may be `active` while its physical worktree is missing.

- `present_consistent`: worktree path, Git registration, branch and Git common-directory identity matched; fresh mutation-time authorization is still mandatory.
- `missing_worktree`: path and matching registration missing; keep task state and branches, no auto-recreation or prune.
- `identity_mismatch`: path, ref, ownership or registration disagrees; deny unsafe operations.
- `unverifiable`: I/O error, permission, timeout or malformed Git data; never infer missing/clean/safe.
- `terminal_record`: previously discarded lifecycle, displayed for historical context only.

`isolation_status` / `isolation_diff` and admin mutation tools fail closed with stable `ISOLATION_WORKTREE_MISSING`, `ISOLATION_IDENTITY_MISMATCH` and `ISOLATION_HEALTH_UNVERIFIABLE` error codes. Errors have human-readable text; governed ToolResults may include structured `data.code` and `data.observedHealth`. Prior policy, audit and approval denials may still take precedence.

`discard` no longer calls `git worktree prune` on a missing task and does not delete missing/foreign task refs. On a verified eligible worktree, task branch deletion uses atomic Git expected-SHA compare-and-delete, rejecting changed refs. External filesystem races cannot be ruled out atomically; failed operations retain visible recovery state. See the [G58 forensic inventory](project/GOAL58_ISOLATION_EVIDENCE.md).

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


## Apply journal and rollback

Before the first source mutation, FolderForge writes an integrity-checked binary
patch plus a journal of exact tracked paths and SHA-256 hashes for bounded
untracked files. The isolation enters `applying` before any file is changed. A
process restart never replays apply; the operator can inspect the uncertain state
and invoke `isolation_rollback`.

After apply, FolderForge fingerprints source HEAD, binary diff bytes, porcelain
status, and untracked file contents. Rollback succeeds only when the source still
exactly matches the recorded applied change set. It removes exact untracked
outputs and reverse-applies the checked patch. Before any deletion it holds
bounded, hash-verified copies of the source's untracked bytes (maximum 10 MiB)
in memory; if a later step fails, it attempts to restore those original bytes
using exclusive file creation, even if the task worktree disappears. A competing
external filesystem writer can still prevent a complete rollback; such a
failure must never be represented as an atomic success. If the original
source repository itself disappears or its HEAD identity changes during
recovery, FolderForge reports `ROLLBACK_RECOVERY_INCOMPLETE` and does
**not** recreate an untrusted source directory. The operator must investigate
the partially completed outcome using independent backups. Any user edit,
missing file, hash mismatch, extra path, or patch corruption causes a
fail-closed refusal.

Discard is rejected while an isolation is `applying` or `applied`, preserving the
recovery worktree and rollback journal. After rollback, discard removes the
worktree, task branch, and journal.

## Availability

Worktree isolation is available only when the activated default project is the
root of a Git repository. Non-Git folders and nested subproject activations remain
usable for existing FolderForge features, while isolation reports an explicit
unavailable reason. A filesystem checkpoint fallback is still a roadmap item.
