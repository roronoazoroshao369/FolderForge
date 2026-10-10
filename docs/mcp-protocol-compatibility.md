# G59 MCP dual-era interoperability — opt-in and evidence

**Status:** G59 product branch **under review**, no merge/release authorization; exact-head GitHub CI and independent security review must verify the *final PR head*. This document describes the proposed implementation and scoped local results, not npm v3.0.1 or production certification.

Design: [G59 architectural spec](superpowers/specs/2026-10-10-goal59-mcp-dual-era-protocol-adapter-design.md). Approved plan: [G59 TDD plan](superpowers/plans/2026-10-10-goal59-version-aware-mcp-adapter.md). Official versions: [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) and [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).

## Actual SDK and protocol boundaries

| Surface | SDK version pinned in dependency lock | Feature status |
| --- | --- | --- |
| Existing server (legacy) | `@modelcontextprotocol/sdk@1.32.1` | Existing 2025-11-25 handshake, stdio and protected Streamable HTTP, `Mcp-Session-Id`, existing Task operations |
| Modern inbound server | `@modelcontextprotocol/server@2.3.1` | 2026-07-28 `server/discover`, stateless HTTP, stdio first-request routing, read-only core |
| Modern test client | `@modelcontextprotocol/client@2.3.1` (dev-only) | Real HTTP and stdio discovery/list/read conformance fixture |
| Legacy test client | `@modelcontextprotocol/sdk@1.32.1` | Real stdio and HTTP legacy init/list/read fixture |
| Child MCP client | Existing `src/adapters/child-mcp/client.ts` | Legacy negotiated versions ONLY; 2026 outbound client support **NOT_IMPLEMENTED** |

The default remains `server.mcpProtocol.mode: legacy`. Set `server.mcpProtocol.mode: dual` explicitly in FolderForge config to opt in to modern **read-only** core RPC without replacing the old protocol. Invalid mode values are refused by config validation. The existing HTTP authentication (token, OAuth, gateway guard) executes before the modern callback. Neither `_meta` nor `clientInfo` authorizes access.

Modern requests are served through the official v2 server; `server/discover` advertises tools/resources/prompts only, with no 2026 Tasks, MRTR, subscriptions or public cache claims. Existing legacy Tasks remain on the existing legacy SDK. Modern tool listings exclude statically mutating tools, and `tools/call` checks *effective per-argument mutation classification* before `ToolRegistry.callAgent`. Denied calls return a tool error and cannot invoke the handler. A modern successful read-only call still reaches the same policy/approval/audit pipeline as legacy.

## G59 security-remediation scope and compatibility boundaries (2026-10-10)

After independent AI review of candidate `56649d0`, the modern inbound read-only path has additional fail-closed restrictions:

- **No global route mutation:** `workspace_route` is omitted and forbidden from modern `tools/list` and `tools/call` despite its legacy `mutates: false` annotation. It can change a process-wide active tool set and is not a read-only operation. Legacy routing remains unchanged.
- **Frozen modern tool candidates:** startup captures the initial active tool names for the modern facade. A later legacy principal changing global routing cannot modify the modern catalog. Modern calls still check live tool definitions, effective mutation classification, OAuth read scopes and the existing registry/policy for each call. The modern catalog is intentionally not a real-time subscription.
- **OAuth resources:** when the modern principal uses OAuth, only owner-aware `folderforge://tasks` and `folderforge://workflows` are advertised or readable. Workspace, process, Git and artifact resource metadata have no principal-scoped owner index, so they are denied in modern OAuth mode rather than shared across principals. Legacy resource semantics and trusted local stdio resources remain unchanged.
- **Stdio era isolation:** a complete valid JSON-RPC request with a scalar request ID must select the initial era; legacy `initialize` also passes the official v1 `InitializeRequestSchema` before locking; malformed initial requests are rejected without locking it. Subsequent cross-era messages are rejected before either SDK executes tools. Requests with modern per-request metadata cannot silently enter the legacy handler. The official v2 client with pinned version may begin with `tools/list`, rather than mandatory `server/discover`, and this is supported when its metadata is valid.
- **HTTP route isolation:** Origin validation for dual mode is limited to MCP endpoints. Health, Responses `/v1/*`, OAuth metadata and unrelated routes retain their original routing, authentication and preflight behavior. Allowlisted origins may preflight modern `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`. The modern POST adapter also accepts id-less `notifications/*` messages and leaves their 202 Accepted response to the official SDK; notifications do not grant tool invocation.
- **Evidence distinction:** Native TDD tests, conformance and platform CI must be rerun against the final product HEAD after these changes. A separate read-only AI reviewer is a valuable adversarial check, but **not external human security approval**. No modern write/replay guarantee is claimed.

## Failure semantics and deferred capability gates

- Modern mutations, including dynamically classified mutating dispatcher arguments, **DENIED** until a future approved durable principal/workspace/canonical-argument operation ledger proves no unsafe double execution across independently handled requests. The old per-Server replay cache is not proof of exactly-once semantics. This is a deliberate G59 scope limit, not a partial implementation of safe writes.
- Modern `io.modelcontextprotocol/tasks`, `tasks/update`, MRTR `input_required`, `subscriptions/listen`, explicit cache TTL/scope and 2026 outbound child probing are **NOT_IMPLEMENTED / NOT_ADVERTISED**. Existing legacy task endpoints remain available only on legacy traffic.
- In dual HTTP mode, invalid `Origin`, missing/invalid token/OAuth, mixed protocol markers and mismatched `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` fail before tool execution. `Mcp-Param-*` is not in the advertised input schemas and is conservatively refused (no independent header-derived arguments).
- Modern stdio mode selects the era from the initial complete JSON-RPC message; the modern path uses SDK v2, while legacy opens the existing SDK v1 Server and all legacy handlers. New request-bound modern capabilities do not grant access to legacy sessions.
- Errors, disconnected streams or uncertain completion cannot be automatically retried as mutations. Existing legacy worktree/sourceDirty forensic records are unchanged and not reconstructed, discarded or pruned.

## Repeatable conformance evidence

Run after installing deps/building as appropriate:

```bash
npm ci --ignore-scripts
npm run verify
npm run build
npm run smoke:stdio
npm run smoke:http
node scripts/mcp-dual-era-conformance.mjs --output .folderforge-ci/g59-conformance.json
```

The G59 evidence runner executes pinned real v2/v1 client and negative regression suites, captures exit codes, OS/Node/SDK versions and SHA-256 checksums of output logs **without exporting credentials or raw tool payloads**. `PASS` means the named fixture tests actually finished with code 0; `FAIL`, `UNAVAILABLE`, `NOT_RUN` and `SKIP` are never silently converted to successes. It does **not** certify ChatGPT, Claude, VS Code, macOS/Windows or an external OAuth tenant merely because a pinned SDK fixture passes.

Local observed verification during preparation (2026-10-10): MCP v1.32.1 and v2.3.1 real stdio clients can each list and read a temporary file on the same dual-mode CLI config; v2.3.1 HTTP client lists and calls a read-only fixture tool, while fake mutating tools have zero handler invocations. Session lifecycle/OAuth legacy tests pass in focused regression runs. Exact-final-SHA full-suite and multi-platform results are independent, still required for approval.

## Operations and rollout

1. Keep dual mode **opt-in** on trusted local/test infrastructure. Default legacy is the rollback posture; rollback must not mutate task/audit/isolation state.
2. Conformance-test exact head via GitHub Actions Ubuntu/macOS/Windows and Node 22/24; document platform skips separately. Real client names/versions, disabled optional features and denied mutation must be visible in the review.
3. Require independent security review of OAuth scope, DNS rebinding, modern header validation, registry authorization, abort/cancel and replay risk. Blocking findings prohibit merge.
4. After PR approval **and separate maintainer permission to merge**, merge in prerequisite order (design, plan, product), verify exact new `main` and post-merge CI, then write closeout documentation. No npm publish/tag or release automation is permitted in this goal.

**Unchanged release gates:** npm `3.0.1` was manually published without verified exact-source 24-hour soak, protected OIDC/SBOM; R16 real rootless Podman acceptance and R17 branch protection/Danger Mode external beta remain open. CI steps that did not run remain `NOT_RUN`.
