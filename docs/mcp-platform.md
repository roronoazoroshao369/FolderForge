# MCP platform capabilities

FolderForge exposes more than a tool catalog. A normal runtime instance advertises
MCP tools, resources, prompts, progress notifications, cancellation, elicitation,
and the SDK task protocol through the same authenticated policy and audit boundary.

## Resources

The following bounded JSON resources are available:

| URI | Contents |
| --- | --- |
| `folderforge://workspace/status` | Active workspace, allowed roots, policy mode, and visible tool counts. |
| `folderforge://git/status` | Branch, tracking state, bounded changed-file lists, and conflicts. |
| `folderforge://processes` | Managed process metadata without stdout/stderr buffers. |
| `folderforge://workflows` | Recent governed workflow state and bounded evidence metadata. |
| `folderforge://tasks` | MCP tasks owned by the authenticated principal. |
| `folderforge://artifacts` | Bounded content-addressed artifact metadata and store statistics. |

`resources/subscribe` is supported for these exact URIs. FolderForge fingerprints
the redacted resource representation and emits `notifications/resources/updated`
only after the representation changes. Each connection may subscribe to at most
32 resources. Polling is single-flight and is stopped when the connection closes
or the final subscription is removed.

Resource content is recursively secret-redacted. FolderForge preserves only a
narrow set of its own opaque identifiers, such as `taskId`, `sessionId`, and
artifact SHA-256 values, because callers need those values to address the
corresponding protocol objects. Resources do not expose process output, task
arguments, artifact bytes, credentials, or approval secrets.

OAuth connections require the configured read scope for listing, reading, and
subscribing to resources.

## Prompts

`prompts/list` and `prompts/get` expose maintained FolderForge workflow prompts:

- `folderforge/deep-implementation-cycle` — Discover → Analyze → Plan → Implement
  → Review → Test → Fix → Release Check;
- `folderforge/security-review` — trust-boundary, policy, secret, sandbox,
  replay, audit, and supply-chain review;
- `folderforge/release-check` — exact release-candidate verification without
  public release actions.

Prompts contain instructions only. They do not execute tools, change policy, or
approve pending operations. Required prompt arguments are validated before a
prompt is returned. OAuth connections require the configured read scope.

## Progress, cancellation, and elicitation

A direct `tools/call` may carry a progress token. When a handler reports progress,
FolderForge forwards standard `notifications/progress` messages only to that
request. The SDK request `AbortSignal` is propagated into the tool control object,
so cancellation can wake bounded waits and terminate supported operations. When
the client advertises elicitation, supported governed tools can request structured
operator input; elicitation is not an approval bypass.

## Task-augmented tool calls

Every advertised agent tool declares optional task support when the full runtime
container is available. A client can request task execution through task-augmented
`tools/call`, then use:

- `tasks/get`;
- `tasks/list`;
- `tasks/cancel`;
- `tasks/result`;
- `notifications/tasks/status`.

The task layer does **not** execute handlers directly. It invokes
`ToolRegistry.callAgent` with the creating principal, original arguments,
cancellation signal, and progress callback. OAuth scope checks occur before task
creation, and the ordinary risk, policy, approval, rate-limit, path, command,
secret, and audit pipeline still applies.

### Persistence and bounds

Task records are stored under `.folderforge/mcp-tasks/`, which is ignored by Git.
On supported POSIX hosts the directory is mode `0700` and files are mode `0600`.
Records contain:

- task protocol state and timestamps;
- owner principal ID;
- tool name;
- a SHA-256 fingerprint of the **redacted** argument summary;
- bounded, redacted result evidence.

Raw arguments are never persisted. Results larger than 1 MiB after redaction are
replaced with a structured failure instead of being written. At most 1,000 tasks
are retained; listing is paginated in groups of 50. TTL is bounded from one minute
to 24 hours, expired records are removed, and status messages are capped.

A non-admin principal can read, list, cancel, or retrieve results only for its own
tasks. Task cancellation additionally requires the configured OAuth write scope.

### Restart and replay semantics

FolderForge never automatically replays a task that was active when the server
stopped. On restart, persisted `working` or `input_required` records become
`failed` with explicit no-replay evidence. This avoids duplicating a side effect
whose completion state is uncertain. A caller may inspect the failure and create a
new operation deliberately.

## Compatibility and conformance

Tools-only server construction remains supported for internal tests and embedders
that do not provide a shared runtime container. Normal CLI stdio and HTTP runtimes
provide the complete capability set.

The release gate verifies tools, resources, and prompts with MCP Inspector over
stdio. SDK integration tests use an in-memory client/server transport to verify
capability negotiation and the complete task stream, status, list, result, and
resource lifecycle. Tasks follow the experimental API supplied by the pinned MCP
SDK; task compatibility must therefore be revalidated whenever the SDK is updated.
