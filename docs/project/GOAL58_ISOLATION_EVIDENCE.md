# G58 — Managed isolation recovery evidence

Observed 2026-10-09T11:13:47Z on real FolderForge repository. Read-only forensic inventory: **no historical isolation state, refs or files were modified**.

## Source and proof

- Main at inspection: `da736f0c84fa1f49fc53bf27654f398068a3aaa1`. Separate G58 feature worktree existed; it was *not* one of the historical records.
- Persisted state: `.git/folderforge/isolations.json`, 0600, 1406 bytes, SHA-256 `47a189d85d05c4ef651886679cbf9e4e34be6d552f8a162a42e180441e0f4074`.
- Live `isolation_list` reported exactly two `active` records with `sourceDirty: true` at task creation. That flag is historical, not proof of current source dirtiness.
- `git worktree list --porcelain` listed only real main and separately created G58 implementation worktrees; it did not list either historical isolation.

| Isolation | Task | Missing physical worktree | Missing branch | Readable recorded base object | Rollback journal |
| --- | --- | --- | --- | --- | --- |
| `iso_b158d434167e4eb8b283` | mission-control-agent-loop | yes | `folderforge/task/mission-control-agent-loop-4eb8b283` | `54dfc1abb6c717c72d93446c1cc2c460ba8d5587` is a commit | none found |
| `iso_0e1294c275b34225a61f` | canonical-path-identity | yes | `folderforge/task/canonical-path-identity-4225a61f` | `af1b5957a1dbce583e61501c4c9b686be7e5a430` is a commit | none found |

## Reproducible redacted observations (2026-10-09T14:13:27Z)

The source-relative paths for the recorded worktrees are
`.git/folderforge/worktrees/iso_b158d434167e4eb8b283` and
`.git/folderforge/worktrees/iso_0e1294c275b34225a61f`.
Both physical-directory `stat` calls returned `ENOENT`. These are
**not** the separate `.worktrees/g58-isolation-health` development workspace.
At the earlier pre-implementation checkpoint only source/main was registered;
at this later checkpoint the **source main plus G58 implementation worktree**
were registered. Neither historical isolation was registered at either observation.

The following are the relevant command results with local checkout prefix omitted:

```text
git rev-parse main => da736f0c84fa1f49fc53bf27654f398068a3aaa1
git worktree list --porcelain => main HEAD da736f0...; feat/g58-isolation-health HEAD 8f260ef...
stat .git/folderforge/isolations.json => mode=600, size=1406
sha256sum .git/folderforge/isolations.json => 47a189d85d05c4ef651886679cbf9e4e34be6d552f8a162a42e180441e0f4074
stat .git/folderforge/worktrees/<each-historical-id> => ENOENT (both)
git show-ref --verify --quiet refs/heads/<each-historical-branch> => absent (both)
git cat-file -t <recorded-base-commit> => commit (both)
stat .git/folderforge/rollbacks/<each-id>.patch => absent (both)
stat .git/folderforge/rollbacks/<each-id>.json => absent (both)
```

Recorded `baseCommit` and `sourceHead` are known and readable for each
historical record. An independently recorded historical *task-tip* SHA is
**UNAVAILABLE**: schema v1 does not store a task-tip commit, and the task
branch ref is absent; commit reachability beyond the base was **NOT
ESTABLISHED**. The rollback journal contents/hash were **NOT AVAILABLE**
because both checked journal paths are absent. Directory inode ownership,
permissions, and contents are **UNAVAILABLE**, not zero bytes.

The base commits are **not evidence** that missing uncommitted/untracked bytes are recoverable or that all task changes were merged. The records stay persisted; this goal is truthful classification and mutation refusal, **not** reconstruction of lost data.

## Verified local behavior

- `inspectWorktreeHealth` observes `present_consistent`, `missing_worktree`, `identity_mismatch`, `unverifiable` or `terminal_record` independently of persisted lifecycle. Observation does not rewrite metadata.
- Governing tools preserve policy, approvals and audit. Status/diff and admin mutation errors return stable codes in `error` and optional `data.code` / `data.observedHealth`.
- Missing/unverified worktrees are never auto-pruned. The destructive branch-ref removal uses Git expected-SHA compare-and-delete.
- Mission Control displays health and hides discard for missing/unknown/foreign worktrees. Both existing HTTP discard routes reject a missing worktree with 409 while preserving branch and metadata.
- Disposable fixture tests demonstrate TDD RED to GREEN for missing worktrees, Git identity mismatch, source drift, journal corruption and injected races. Visual fixture tests verify stale confirmation is denied.
- `npm run smoke:stdio` passed against the built stdio MCP server (53 advertised readonly tools, real file_read in a Unicode/space-containing disposable Git repository). **New explicit stdio MCP wire calls** tested `isolation_list` reporting `missing_worktree`, and `isolation_status`/`isolation_diff` returning `ISOLATION_WORKTREE_MISSING`. This test created and removed only a disposable Git worktree, not a historical one.
- `npm run smoke:http` passed against authenticated HTTP MCP (401 without API key, authorized tool calls, 50 advertised tools); the generic HTTP smoke does **not yet** assert isolation health through that transport. Governed registry integration tests separately validate both admin/agent permission boundaries.
- GitHub feature exact-head and post-merge CI remain **independent, pending gates**; published-package soak and external beta remain out of scope. Do not infer either from local tests.

## Operator response for unresolved historical records

Read-only inventory first: metadata digest, branch-ref reachability, Git registration, base/task commit reachability, worktree existence, journal path/hash and audit references. If any result is missing or unverifiable, keep data intact and forbid apply/discard/rollback attempts. An operator-approved restore/delete workflow would require a **separate** evidence-based plan, backup strategy and permission; Goal #58 does not authorize historical deletion.
