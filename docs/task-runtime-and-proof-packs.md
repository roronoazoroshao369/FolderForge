# Durable task runtime and Proof Packs

FolderForge uses the existing workflow engine as its durable task runtime. It
does not create a second execution engine with different policy or audit rules.
Every child step still enters the shared `ToolRegistry` and receives a server-
resolved `taskId` for approval and audit binding.

## Task contract

A persisted workflow task records:

- objective and acceptance criteria;
- deterministic role/step plan and dependency graph;
- exact project root and owner binding;
- creation client/session/capsule provenance;
- optional managed isolation identity;
- current phase, current step, attempts, bounded resolved arguments, and evidence;
- pause, failure, cancellation, completion, handoff, and Proof Pack state;
- known limitations;
- monotonic revision and SHA-256 state integrity digest.

Task state is stored mode `0600` below:

```text
.folderforge/workflows/runs/<workflow-id>.json
```

Native agent file tools deny the complete workflow state directory. Each write is
atomic and optimistic: a stale revision cannot overwrite a newer pause, cancel,
claim, or execution checkpoint.

## Ownership and reconnect

Ownership matches:

- principal identity;
- project identity when present;
- OAuth client identity when present.

The creation session and capsule are retained as provenance but are not used as
a permanent lock, so the same credential/client can resume after a reconnect or
server restart. Another principal cannot inspect, list, run, pause, cancel,
report, or package the task. Dashboard/admin authority remains an explicit
operator override.

Legacy schema-v1 workflows are migrated in memory as `legacy:unowned` and are
admin-only until an operator deliberately re-creates or hands off the task.

## Pause, cancellation, and concurrency

`workflow_pause` is persistent. A child already executing is allowed to return,
then its bounded evidence is merged into the newer paused state. The next step is
not started. `workflow_resume` continues from the unfinished graph and does not
replay a succeeded step.

Per-run lock files serialize ownership mutations and one-time token claims across
processes. Live or unreadable locks fail closed. A lock older than five minutes
is removed only when its recorded process no longer exists. Optimistic revisions
provide a second protection against stale writers.

Cancellation is terminal. Client transport cancellation pauses the task rather
than claiming the uncertain child call failed or replaying it automatically.

## Handoff

`workflow_handoff` is allowed only while a task is created or paused and no child
step is still running. It returns a short-lived claim token exactly once for an
exact target principal. Only the SHA-256 token hash is persisted.

`workflow_claim` requires both:

1. the exact target principal identity;
2. the exact unexpired token.

Claim runs under the per-task lock, removes the pending handoff, and changes the
owner atomically. Previous approvals waiting on the old owner are invalidated so
the new owner must request a fresh approval bound to the new task context.

## Proof Pack

A terminal task can create a Proof Pack through `workflow_proof_pack`. The pack
is stored below the control-plane-only directory:

```text
.folderforge/proof-packs/proof_<id>/
```

Each pack contains:

- `report.json` — machine-readable task report;
- `report.md` — human-readable objective, criteria, plan, and results;
- `changes.diff` — collected step diffs;
- `approvals.json` — task-bound approval snapshots;
- `audit-events.json` — task-bound child execution/security events;
- `manifest.json` — file lengths, SHA-256 hashes, audit head, and manifest hash.

The report includes plan, context provenance, commands/tool calls, tests and
verification steps, runtime/browser evidence, security events, known
limitations, and the managed isolation rollback checkpoint when one is attached.
All content is passed through the secret redactor before hashing and writing.

Creation requires a terminal task and a valid audit chain. If attachment or audit
recording fails, FolderForge removes the unattached pack and reverses the task
reference instead of leaving a successful-looking orphan. `workflow_proof_verify`
checks the manifest and every file byte-for-byte; tampering fails closed.

## Tools

Task lifecycle:

- `workflow_create`
- `workflow_run`
- `workflow_pause`
- `workflow_resume`
- `workflow_cancel`
- `workflow_status`
- `workflow_list`
- `workflow_report`
- `workflow_handoff`
- `workflow_claim`

Proof lifecycle:

- `workflow_proof_pack`
- `workflow_proof_verify`
- `workflow_proof_list`

## Known limitations

- Workflow execution remains process-local while a child tool is in flight. The
  durable checkpoint is written before and after the child call; uncertain
  mutation calls are not automatically replayed after a process crash.
- A Proof Pack proves repository-local evidence and integrity. It is not external
  reproduction, hosted-client acceptance, CI proof, or production observation.
- Automatic task creation from a natural-language objective and a full context
  compiler remain separate P1 work; this runtime executes explicit bounded plans.
