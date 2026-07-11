# Governed Agent Workflows

Milestone 2.0 adds deterministic, persisted orchestration without hiding an LLM or
an ungoverned execution engine inside a mega-tool. An AI client still decides the
plan. FolderForge validates role/tool boundaries, executes every step through the
normal `ToolRegistry`, records bounded evidence, pauses at approval boundaries,
and resumes without replaying successful steps.

## Lifecycle tools

| Tool | Purpose | Risk |
| --- | --- | --- |
| `workflow_create` | Validate and persist a role-scoped definition | MEDIUM |
| `workflow_run` | Execute a newly created run | MEDIUM |
| `workflow_resume` | Continue a paused checkpoint | MEDIUM |
| `workflow_status` | Read one checkpoint | LOW |
| `workflow_list` | List recent runs | LOW |
| `workflow_cancel` | Cancel a non-terminal run | MEDIUM |
| `workflow_report` | Produce a reproducible evidence report | LOW |

Workflow tools cannot call other `workflow_*` tools recursively.

## Definition

```json
{
  "name": "frontend implementation council",
  "roles": {
    "planner": { "allowedTools": ["project_analyze", "code_context"] },
    "coder": { "allowedTools": ["patch_transaction"] },
    "tester": { "allowedTools": ["project_verify"] },
    "reviewer": { "allowedTools": ["browser_open", "browser_screenshot"] }
  },
  "steps": [
    {
      "id": "analyze",
      "role": "planner",
      "tool": "project_analyze"
    },
    {
      "id": "context",
      "role": "planner",
      "tool": "code_context",
      "dependsOn": ["analyze"],
      "args": { "query": "landing page implementation" }
    }
  ]
}
```

Validation enforces:

- 1–50 unique steps;
- valid roles with explicit `allowedTools`;
- every tool exists at creation time;
- each step is inside its role scope;
- no recursive workflow calls;
- dependency existence and acyclic graph;
- 256 KB total definition and 64 KB args per step;
- rejection of detected secrets in persisted definitions.

## Step references

A later step can consume bounded evidence from a successful earlier step:

```json
{
  "transactionId": {
    "$step": "preview",
    "path": "data.id"
  }
}
```

References are recursively resolved immediately before execution. Missing or
truncated evidence fails the step rather than inventing a value.

## Expectations and stop conditions

A step can assert one evidence path:

```json
{
  "expect": {
    "path": "data.passed",
    "equals": true
  }
}
```

`exists` assertions are also supported. A failed tool or expectation stops the
run unless that step declares `continueOnError: true`. Steps depending on a failed
or skipped step are skipped. Client cancellation pauses the run at the next safe
checkpoint; explicit `workflow_cancel` makes it terminal.

## Approval and resume

Every child step calls `registry.call`, so its native risk, policy, approval,
rate-limit, and audit semantics remain intact. When a child returns an
`approvalId`, the workflow becomes `paused` and the step becomes
`awaiting_approval`.

Approval scope `once` now has complete semantics: an approved request is matched
against the exact tool plus canonical args, consumed once, and persisted with a
`consumedAt` timestamp. `workflow_resume` retries only the waiting step. Already
successful steps keep their original attempt count and are never replayed.

Denied or expired approvals fail the waiting step and the run.

## Checkpoints and evidence

Runs are stored atomically under `.folderforge/workflows/runs/` with mode `0600`.
The store creates a local `.gitignore`. A run contains its immutable definition,
definition hash, role scopes, step states, attempts, timestamps, approval IDs,
redacted resolved args, and bounded tool evidence.

Evidence rules:

- data is secret-redacted and capped at 64 KB per step;
- text and diff previews are capped;
- image base64 is never persisted, only MIME type and approximate bytes;
- reports do not expose the raw unredacted definition args;
- completed, failed, and cancelled runs are terminal.

The definition hash is deterministic FNV-1a over canonical JSON. It is an
integrity/reproducibility identifier, not a cryptographic signature.

## Presets

The `workflow` group is included in `vibe`, `vibe-lite`, `readonly`, `full`, and
`godot`. Policy still denies mutating lifecycle calls in modes that do not allow
them. `vibe-lite` pins all seven workflow tools, all five agent tools, and all ten
browser wrappers while preserving process start/read/tail/stop/list in a 50-tool
surface.

## Live acceptance

A source-built HTTP MCP server in `safe` mode verified:

- 269 native tools and all seven workflow tools;
- multi-role definition validation and persistence;
- planner step completion followed by a `file_write` approval pause;
- one-shot approval, resume, and exact non-replay (`planner attempts=1`);
- a step reference passed `project_analyze.data.name` into file content;
- reviewer assertion and completed report;
- server restart preserved the completed checkpoint and list/report access;
- resume of a completed run returned an error and did not execute any step;
- workflow operations and child tool calls remained visible in audit.

## Boundaries

This is deterministic orchestration, not autonomous reasoning. FolderForge does
not generate plans, conceal chain-of-thought, or bypass a user's approval policy.
Parallel execution, cryptographic run signing, distributed workers, and artifact
blob storage remain future extensions.
