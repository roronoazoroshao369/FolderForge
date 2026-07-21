# Durable structured verification

FolderForge uses the existing `project_verify` tool as the verification control
plane. It does not introduce a second runner. Detected project commands still run
through the shared registry, policy, Workspace Capsule, rate-limit, audit, and
cancellation pipeline.

## Actions

`project_verify` accepts four actions:

| Action | Risk contract | Behavior |
| --- | --- | --- |
| `plan` | LOW, read-only | Detect commands and report whether each requested check is available. |
| `run` | MEDIUM, mutating | Execute checks and persist a durable verification run. |
| `status` | LOW, read-only | Read one owner-bound run by ID. |
| `list` | LOW, read-only | List bounded summaries visible to the current principal. |

`dryRun:true` remains a backward-compatible alias for `action:"plan"`.

Checks run in deterministic order:

1. `typecheck`
2. `lint`
3. `test`
4. `build`

Real checks remain classified as mutating because package scripts and compiler or
test hooks execute project code and may write generated files.

## Explicit result states

Every requested check always appears in the report with one authoritative
`status`:

- `passed` — command exited successfully;
- `failed` — command ran and failed, timed out, or could not be executed;
- `unavailable` — no command was detected or the executable/command was missing;
- `skipped` — the check did not run because an earlier gate stopped the pipeline,
  the caller cancelled, or a previous executor was interrupted; and
- `pending` — transient persisted state while a run is active.

Backward-compatible `passed` and `skipped` booleans remain in applicable result
objects, but `status` is authoritative.

Run-level `overall` is one of:

- `passed` — every requested check passed;
- `failed` — at least one check failed;
- `unavailable` — no check failed, but at least one requested check was
  unavailable; or
- `incomplete` — pending/skipped work remains without a failed or unavailable
  check.

With `stopOnFailure:true` (the default), all later checks are recorded as
`skipped`; they never disappear from the evidence.

## Durable evidence

Runs are stored under:

```text
.folderforge/verifications/runs/verify_<id>.json
```

Each run contains:

- owner principal, project, OAuth client, and optional task binding;
- package manager, requested checks, and resolved commands;
- revision, timestamps, executor PID, state, and overall outcome;
- bounded, secret-redacted stdout/stderr;
- parsed diagnostics, exit code, duration, and explicit status per check; and
- a SHA-256 integrity digest over the complete record.

Writes are atomic and mode `0600`. The entire verification state directory is
denied to native agent file tools. Reports are accessed through `project_verify
status/list`, which enforce the owner/project/client boundary while allowing a
new transport session for the same authenticated identity.

## Restart and cancellation

A new `VerificationManager` inspects persisted `running` records. If the recorded
executor process is no longer alive, FolderForge marks every remaining `pending`
check as `skipped`, closes the run as `interrupted`, and does **not** replay any
command.

An MCP cancellation signal is passed into `execa`, so an in-flight process is
terminated rather than allowed to run until timeout. The active check and all
remaining checks are persisted as `skipped`, and the run state becomes
`cancelled`.

## Evidence failure semantics

The evidence directory is preflighted before command execution:

- if the initial run cannot be persisted, no verification command runs;
- if a command ran but the next durable checkpoint fails, FolderForge returns
  `VERIFICATION_OUTCOME_UNCERTAIN` and explicitly says not to retry
  automatically.

This mirrors the audit durability rule: the system never converts missing
terminal evidence into a confident success or safe retry.

## Task, Proof Pack, and Mission Control integration

Workflow child calls receive the durable workflow ID as `taskId`. A
`project_verify` step therefore persists a task-bound verification ID and returns
that structured report as workflow evidence. Proof Packs already classify
`project_verify` as test evidence, so the complete verification report is copied
into `report.json` under `testResults`.

Mission Control lists recent verification summaries and counts failed or
unavailable runs without reading the denied state files directly.

## Security boundary

- Outputs are bounded and passed through `SecretPolicy` before persistence.
- State files use atomic writes and integrity validation.
- Cross-principal, cross-project, and cross-OAuth-client reads are denied.
- `plan`, `status`, and `list` remain usable in readonly mode; `run` is denied.
- Verification scripts are **not sandboxed** by this feature. They execute with
  the same local process boundary as the existing command runner. Workspace
  Capsule command-backed tools continue to fail closed when a usable sandbox is
  unavailable.

## Reproducible verification

```bash
npx vitest run tests/unit/verification-manager.test.ts
npx vitest run tests/integration/agent-tools.test.ts
npx vitest run tests/unit/proof-pack-manager.test.ts
npx vitest run tests/integration/dashboard-admin.test.ts
npm run verify
```

The tests cover success, failure, unavailable commands, explicit downstream
skips, cancellation, restart interruption without replay, tamper detection,
owner boundaries, readonly classification, state-file denial, pre-execution
storage failure, uncertain post-execution persistence, Proof Pack propagation,
and Mission Control visibility.
