# Architecture

FolderForge is an MCP-native control plane that sits between an AI
coding agent and a local development workspace. It exposes a single, curated set
of tools over the Model Context Protocol and wraps every call in a policy +
audit pipeline.

## High-level flow

```
agent (Claude Desktop / Codex / ...)
        |  JSON-RPC (MCP)
        v
 transport (stdio | streamable http)      src/server/transports/*
        |
        v
   MCP Server                              src/server/mcp-server.ts
        |  tools/list  -> registry.listActive()
        |  tools/call  -> registry.call()
        v
  ToolRegistry  --------------------------- src/tools/registry.ts
        |  classify risk -> PolicyEngine.evaluate()
        |  audit.record()
        v
  PolicyEngine  --------------------------- src/policy/policy-engine.ts
   (path / command / secret / approvals)
        |  allow | deny | approval-required
        v
  [approval-required path] ─────────────────────────────────────────
        |                                                            |
        | client.capabilities.elicitation == true                   | false / error
        v                                                            v
  elicitInput (Approve/Deny in chat)           dashboard fallback (appr_xxx)
   scope: once | session                       http://localhost:7332/
        |
        | approved → resolve inline
        | denied  → error returned
        v
  Tool handler / child adapter             src/tools/* + src/adapters/*
        |  may return ToolContentBlock[]
        |  (text | image | resource | resource_link)
        |  child isError -> ToolResult.ok=false
        v
  toCallToolResult → MCP content blocks    src/server/mcp-server.ts
   text block always first (back-compat)
   image blocks render directly in vision-capable clients
   embedded resource (e.g. text/x-diff for git_diff)
        v
  Runtime composition                       src/runtime/container.ts
   (workspace, processes, db, adapters, audit)
```

A second, independent HTTP server serves the local dashboard
(`src/dashboard/server.ts`), which reads the same `Container` to render status,
audit, processes, approvals, active calls, Workspace Capsules, durable tasks,
isolations, and Proof Pack references. The dashboard is the **fallback** approval
UI when the MCP client does not advertise the `elicitation` capability and the
local Mission Control surface for bounded containment actions.

## Modules

| Area | Path | Responsibility |
| --- | --- | --- |
| Entrypoint | `src/main.ts` | Parse args, `loadConfig`, build `Container` + registry, start server + dashboard |
| Config | `src/runtime/config.ts` | Defaults + YAML merge + path normalization |
| Runtime composition | `src/runtime/container.ts` | Concrete local services behind narrow contracts |
| Registry | `src/tools/registry.ts` | Tool catalog, active subset, policy + audit pipeline |
| Server | `src/server/mcp-server.ts` | MCP `tools/list` and `tools/call` handlers |
| Transports | `src/server/transports/*` | stdio and Streamable HTTP binding |
| Policy | `src/policy/*` | Path, command, secret policies; risk; approvals |
| Audit/evidence | `src/audit/*`, `src/evidence/*` | Governed event facade, durable hash chain, storage ports, verification |
| Managers | `src/managers/*` | Long-running processes, DB connections |
| Workspace | `src/workspace/*` | Project detection, activation, memory store |
| Capsules | `src/capsule/*` | Principal/session/workspace/profile/budget/expiry enforcement |
| Isolation | `src/isolation/*` | Managed Git worktree lifecycle, review, safe apply/discard |
| Task runtime | `src/workflows/*` | Durable owner-bound plans, pause/resume, handoff, bounded evidence |
| Proof packs | `src/proof/*` | Secret-redacted immutable task evidence and integrity verification |
| Adapters | `src/adapters/child-mcp/*` | Proxy child MCP servers (Serena, Playwright) |
| Operator state | `src/operator/*` | Persistent write-freeze and exact containment allowlist |
| Dashboard | `src/dashboard/*` | Local read/approve/Mission Control admin UI |

## Design principles

- **stdout is sacred.** On the stdio transport, stdout carries the JSON-RPC
  channel only. All logs go to stderr (`src/core/logger.ts`).
- **One decision point.** Every mutation flows through `PolicyEngine.evaluate`.
  Tools never bypass it.
- **Curated surface.** The registry can expose a routed subset
  (`TASK_PRESETS`) so agents see a focused tool list instead of everything.
- **Fail safe.** Unknown tools, denied paths, and CRITICAL commands return a
  structured error rather than throwing across the protocol boundary.

## Workflow control plane

Persisted workflows are deterministic orchestration over `ToolRegistry.call`; they never invoke handlers directly. This preserves per-step policy, approval, rate limits, audit, adapter risk, and rich results. Checkpoints store bounded/redacted evidence and resume only unfinished steps. See [`workflows.md`](./workflows.md).


## Workspace Capsule and isolation boundary

A remote or explicitly capsule-bound call is checked by
`WorkspaceCapsuleManager` before ordinary policy evaluation. The decision binds
the active project root to principal, optional client/session, expiry/revocation,
profile, budgets, and optional task identity. Approval matching then includes the
resolved capsule/task context. See [`workspace-capsules.md`](./workspace-capsules.md).

`WorktreeManager` creates task branches without changing the source worktree.
Agent calls may create and inspect isolation, while apply/discard are admin-only.
Apply requires a clean unchanged source fingerprint and preflights tracked,
untracked, conflict, path, symlink, size, and patch conditions. See
[`task-isolation.md`](./task-isolation.md) and
[ADR-0011](./adr-0011-workspace-capsules-and-isolation.md).


## Durable task and Proof Pack boundary

`WorkflowManager` is the durable task runtime. Each task is bound to its owner,
project and optional OAuth client, protected by an integrity digest, optimistic
revision, and per-run mutation lock. Child calls receive the workflow id as the
server-owned task id before entering the shared registry, so approvals and audit
events cannot be reused across tasks. Pause checkpoints a completed in-flight
step without replay; targeted handoff transfers ownership with a one-time token.

`ProofPackManager` packages terminal workflow evidence only after audit-chain
verification. It writes redacted JSON, Markdown, diffs, approvals, task audit
events, and an integrity manifest beneath the denied control-plane directory.
See [`task-runtime-and-proof-packs.md`](./task-runtime-and-proof-packs.md).


## Mission Control boundary

`MissionControlState` persists an integrity-checked write-freeze decision beneath
the denied `.folderforge` control-plane directory. A frozen runtime restores
`readonly` on restart. Normal agent calls cannot bypass it. The dashboard creates
a server-owned operator role that can bypass only the baseline readonly check for
an exact allowlist of pause, cancel, stop, kill, rollback, and discard actions;
all remaining policy, approval, audit, capsule, rate-limit, and handler checks
still run through `ToolRegistry`.

The registry also exposes a process-local active-call inventory containing tool,
risk, principal/session/task metadata, start time, and argument keys only. Raw
argument values are never retained by Mission Control. See
[`mission-control.md`](./mission-control.md).


## Durable verification boundary

`VerificationManager` persists each `project_verify run` before executing project
code, checkpoints every terminal check result, and marks dead executors
`interrupted` without replay. Reports are bound to principal, project, OAuth
client, and optional task ID. The existing `project_verify` tool exposes
`plan/run/status/list`; only `run` is mutating. Per-check status is one of
`passed`, `failed`, `skipped`, or `unavailable` after completion, with `pending`
reserved for active state.

The store lives under denied `.folderforge/verifications`, uses atomic mode-0600
writes plus a complete-record SHA-256 digest, and fails before execution if the
initial evidence record cannot be written. A failed checkpoint after command
execution returns `VERIFICATION_OUTCOME_UNCERTAIN` rather than implying a safe
retry. Workflow evidence and Proof Packs reuse the same report. See
[`structured-verification.md`](./structured-verification.md).
