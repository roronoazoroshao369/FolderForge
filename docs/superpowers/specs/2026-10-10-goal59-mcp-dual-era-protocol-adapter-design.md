# G59 — MCP Dual-Era Version-Aware Protocol Adapter Design

**Date:** 2026-10-10
**Status:** PROPOSED — maintainer approval of this **written spec** required
**Parent design:** [Trusted Agent Workstation](2026-10-09-trusted-agent-workstation-design.md)
**Source baseline:** `roronoazoroshao/FolderForge` `main@150552fd16c7ae9bbbcc0c9e5b69ac10a0ab83b0`
**Path:** Superpowers **architectural** design review. Proposal B (version-aware protocol adapter) is approved **as an approach**; this document and any subsequent implementation plan are **not yet approved**.

## 1. Intent and decision

Make FolderForge usable by MCP `2026-07-28` clients without regressing clients that currently rely on the `2025-11-25` handshake-based era and earlier versions actually supported by the installed SDK. A successful migration must preserve the existing single policy/approval/audit execution boundary, principal isolation and truthful outcomes.

**Selected approach B:** a dual-era protocol boundary at the existing stdio and authenticated Streamable HTTP entrypoints, with version-specific framing and capabilities over shared, version-neutral application services. Avoid a flag-day SDK replacement (A) and avoid a second public process/proxy as the primary architecture (C).

This is a design, not a claim of existing 2026 protocol support. Do not silently treat an older SDK's incidental sessionless HTTP handling as modern MCP conformance.

### Success criteria

1. A real legacy client can initialize, list, call, use existing Tasks, and preserve existing protected HTTP session behavior without change.
2. A real modern client can discover versions, make stateless core calls using required per-request metadata and HTTP headers, and get spec-shaped results/errors without `initialize` or `Mcp-Session-Id`.
3. Both eras invoke **the same** `ToolRegistry` / Policy / approvals / audit / Capsule and durable workflow/task storage; neither has a route to invoke a tool handler directly.
4. Unauthorized, mixed-era, cross-principal, stale-handle, header/body-mismatch, duplicate/uncertain mutation and disconnected requests fail closed, without undocumented side effects.
5. Independent interoperability evidence for the *actual* client/SDK versions and the precise features tested; unknown/skipped checks are never labeled PASS.

**Non-goals:** inventing a new agent/orchestrator, changing user-facing tool semantics or tool names, replacing the policy engine, shipping all MCP optional extensions, removing legacy support, modifying CI runner selection, publishing npm or certifying production/release readiness.

## 2. Verified baseline and protocol references

Observed on `main@150552fd`, **read-only code review**, not a conformance test of a modern client:

| Existing element | Observed source | Gap or migration constraint |
| --- | --- | --- |
| Server tool dispatch, prompts/resources, legacy Tasks | `src/server/mcp-server.ts` | `Server` from `@modelcontextprotocol/sdk`, `initialize`-era capabilities including core `tasks`; protocol/task semantics must be separated |
| stdio | `src/server/transports/stdio.ts` | Uses legacy `StdioServerTransport`; must dispatch by era without logging JSON-RPC to stdout |
| HTTP | `src/server/transports/http.ts` | Stateful `Mcp-Session-Id` sessions and legacy SDK non-initialize stateless handling; *not* modern per-request metadata/routing/validation |
| Child MCP outbound client | `src/adapters/child-mcp/client.ts` | Always sends legacy `initialize` then `notifications/initialized`, validates SDK-supported revisions |
| Principal construction and authorization | `src/core/principal.ts`, `src/server/auth/oauth.ts`, HTTP transport | Authenticated identity must come from server-verified credential, never clientInfo/_meta/handle |
| Mutation replay | `src/server/mcp-server.ts` | Bounded **per-Server instance** map + principal/session/request identifier; inadequate by itself for HTTP modern retry across independently created servers |
| Durable Tasks | `src/server/mcp-task-manager.ts` | Persisted owner-bound task model exists; modern Tasks extension is a separate wire contract, not an alias |
| Test surfaces | `tests/integration/http-session-lifecycle.test.ts`, `tests/integration/mcp-platform.test.ts`, `tests/integration/oauth-http.test.ts`, `tests/unit/http-hardening.test.ts`, `tests/unit/child-mcp-client.test.ts`, `scripts/smoke-stdio.mjs`, `scripts/smoke-http.mjs` | Existing test successes do not certify modern semantics |
| SDK | `package.json`: `@modelcontextprotocol/sdk: ^1.32.1`, Node `>=22` | Confirm **installed lockfile resolution**, current SDK API/packaging and security advisories *before* selecting an upgrade; do not infer 2026 support from a version string |

Normative sources (consulted 2026-10-10):

- [2026-07-28 MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [versioning and dual-era compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
- [2026 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [2026 stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [2026 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [2026 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
- [Official 2026 release explainer](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [Tasks extension source](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md).
- [2025-11-25 legacy specification](https://modelcontextprotocol.io/specification/2025-11-25) and existing [FolderForge program design](2026-10-09-trusted-agent-workstation-design.md).

Normative protocol details, not project invention: modern requests convey version, clientInfo and clientCapabilities via `params._meta["io.modelcontextprotocol/*"]`; `server/discover` is mandatory for modern servers but optional for clients; unsupported versions return `UnsupportedProtocolVersionError` code `-32022` with `supported` and `requested`; modern HTTP requires `MCP-Protocol-Version`, `Mcp-Method`, conditional `Mcp-Name` and body/header agreement. Modern protocol has no handshake or protocol-level sessions. Tasks moved to the `io.modelcontextprotocol/tasks` extension. Modern tool results include `resultType`; list caching and MRTR use the new schemas. **Not every modern feature is mandatory:** feature advertisement must accurately match implementation.

## 3. Architecture and ownership

```text
stdio client                       authenticated HTTP client
       |                                      |
       v                                      v
stdio era detector                    gateway guard / Origin / auth
       |                                      |
       |                              HTTP era + header/body validator
       |                                      |
       +------------+-------------------------+
                    |
       +------------+-------------+
       |                          |
  LegacyBinding              ModernBinding (opt-in)
  initialize / session       per-request _meta
  2025-11-25 + existing      2026-07-28
  negotiated older versions  server/discover, modern results
       |                          |
       +------------+-------------+
                    |
          Authenticated Principal
          + version/capability context
                    |
           shared ToolDispatcher
          /        |          \
    Registry     Policy       Audit
    approvals    Capsule      Durable state
```

**Boundary rules:**

- The adapter owns JSON-RPC wire compatibility: framing, era selection, response envelope, error mapping, capabilities, notifications, cancellation and modern metadata/HTTP validation. It may not own mutation or business authorization rules.
- An authenticated `RequestContext` is produced per request by trusted transport/auth code, conceptually `{era, protocolVersion, principal, clientCapabilities, transport, requestId, abortSignal}`. Its `principal` and effective scopes MUST be server-derived; `clientInfo` is descriptive, never privileged identity. `requestId` is a correlation identifier, **not** an idempotency guarantee.
- `CoreMcpFacade` (conceptual boundary) exposes tools/list/call, resources/read/list, prompts/list/get and approved task operations through existing services. It is not a second registry, workflow engine, policy pipeline or container.
- Shared mutable registry routing (e.g. adaptive `workspace_route`) must not accidentally change other principals' modern catalogs. For modern requests, derive a stable view from explicit principal/project/preset and underlying authorized state; never use arbitrary previous connection side effects as catalog identity.
- Use existing durable workflow/Task and audit storage; no new on-disk schema or migration without a separate compatibility and recovery gate.
- Proposed implementation modules (file boundaries are **design targets**, not committed code): `src/server/protocol/era-router.ts` (classification/negotiation), `src/server/protocol/request-context.ts` (trusted context), `src/server/protocol/modern-adapter.ts` (modern RPC/schema), `src/server/protocol/legacy-adapter.ts` (wrap retained behavior), `src/server/protocol/modern-result.ts` (mapping); localized changes to `src/server/transports/{stdio,http}.ts`, `src/server/mcp-server.ts`, and `src/adapters/child-mcp/client.ts` only when owned by subsequent approved implementation tasks.
- Upgrade/split the official TypeScript MCP SDK only after validating its actual API, exports, transitive dependencies, Node 22/24 support and lockfile compatibility. Prefer officially supported v2 components where practical; do **not** hand-roll the entire modern protocol if current official SDK supports the needed paths.

## 4. Era selection, version negotiation and rollback

### HTTP on existing `/mcp`

1. Enforce gateway guard, origin restrictions, request-size/timeout limits and configured bearer/API-key/OAuth authentication *before dispatch*. Existing `/v1`, health and OAuth metadata routes stay behaviorally isolated.
2. **Modern classification:** a request with modern `params._meta`/version or required modern HTTP headers enters modern validation. Validate JSON-RPC shape, body metadata and header versions, `Mcp-Method`/`Mcp-Name` (including Base64 sentinel decoding) and any opted-in `x-mcp-header` fields **against body values**. Reject missing/mismatched headers with the spec's 400 `HeaderMismatch` or schema error. Never silently downgrade a failed modern request to legacy. An unsupported but well-formed modern version returns HTTP 400 / JSON-RPC `-32022` with advertised supported versions. Unknown modern method uses HTTP 404 / `-32601` as specified.
3. **Legacy classification:** legacy `initialize` and subsequent authenticated `Mcp-Session-Id` requests continue through the old binding with existing session ownership/TTL. Preserve observed legacy stateless non-init behavior only insofar as existing supported clients rely on it; record the actual compatibility matrix rather than invent guarantees.
4. When a request is ambiguous or carries mixed legacy/modern markers, **reject before invoking tools**, with a documented, deterministic error. No content-based auto fallback on the server. HTTP client-side downgrade, if later added to the outbound client, must follow the official 400-body detection rules and never discard an authenticated security failure.
5. Modern requests are stateless at the protocol layer; do not create `Mcp-Session-Id` or a hidden mutable session per request. Each RPC carries enough authenticated/request metadata; application state is referenced by explicit, opaque, owner-checked handles where required.
6. Preserve GET/DELETE and long-lived legacy session behavior on **legacy** traffic only. Modern HTTP POST accepts a single request/notification and responds with JSON or request-scoped SSE, except `subscriptions/listen` when advertised. Enforce Origin checking on browser-reachable MCP requests; CORS *response* configuration alone is not an Origin authorization gate.

### stdio

- Modern dual-era client detects server support using `server/discover`. A legacy client selects `initialize`; use the official compatibility matrix.
- FolderForge's server selects one era per **stdio process** on the first valid request, retains it for that process and rejects cross-era mixing (an intentional simplification: concurrent mixed eras are not required). Prevent a malformed unauthenticated probe from permanently locking the process into the wrong era.
- No new stdout logging; modern metadata validation and JSON-RPC cancellation/stream rules apply; legacy notifications/initialized remain on the old path.

### Config and deployment

- Proposed operator config: `server.mcpProtocol.mode = "legacy" | "dual"`, default `"legacy"` until conformance gates pass. No implicit environment-only enablement or hard-coded protocol version substitution; configuration parsing and compatibility documented before use.
- Enable dual mode explicitly for trusted local/integration clients first, then authorized HTTP clients, then consider default change **under a separately reviewed release decision**.
- Rollback is configuration-only to legacy; no feature may require deleting durable tasks, audit records or historical isolation metadata. A rollback must leave existing legacy clients functional and modern clients with a clear unsupported/disabled response; never relabel failed modern behavior as legacy success.
- No promise that every third-party host supports 2026 yet. Client names and versions in conformance evidence are pinned exact, not inferred.

## 5. Feature-specific wire contracts

| Capability | Legacy behavior preserved | Modern 2026 behavior / acceptance |
| --- | --- | --- |
| Init/discovery | `initialize` → `notifications/initialized` | **No** initialize; `server/discover` returns truthful supported versions/capabilities/identity; no impersonation through clientInfo |
| Tools | Existing `tools/list` and `tools/call`, governed execution | Modern resultType/schema, deterministic catalog; tool call routes to same registry, no bypass |
| Resources/prompts | Existing list/read/get with scope enforcement | Modern result envelope and cache hints consistent with principal and mutable resource lifetime |
| Lists and caching | No new guarantees imposed on legacy responses | Stable ordering for fixed underlying state; `ttlMs`/ `cacheScope` only if correct. No public caching of OAuth-filtered, project/capsule-dependent or dynamically routed inventories. Use private/short-lived or no cache where safety cannot be proved |
| Change notifications | Legacy `listChanged`, resource subscriptions under session model | Advertise modern `listChanged` only if `subscriptions/listen` and subscription ownership/backpressure/cancellation are implemented; otherwise advertise no change notification capability |
| MRTR | Existing elicitation/sampling expectations retained on legacy | If modern tool needs another round trip, return spec-shaped `input_required` with `inputRequests`/`requestState`, verify owned, expiring continuation on retry; never emit legacy server-initiated RPC. If unavailable, reject capability-dependent requests safely, do not fabricate a complete result |
| Tasks | Existing core `tasks/get`, `tasks/list`, `tasks/cancel`, task-result behavior | `io.modelcontextprotocol/tasks` extension **only when implemented/tested**, including new `tasks/update`/poll semantics. Map to persisted owner-bound Task model with explicit state transitions; don't silently alias modern Tasks to old core API or announce unsupported extension |
| Cancellation/stream | Existing stdio and legacy HTTP session rules | Modern HTTP close aborts request scoped work; cancellation doesn't imply a mutation never committed. Modern stdio cancellation supported; avoid unsafe replay |
| Child MCP (outbound) | Existing handshake and negotiated older SDK versions remain | Dual-era probing per official stdio rules is independently gated; maintain legacy-only outbound if modern probe and downgrade checks cannot be proven. Do not claim outbound 2026 support based on inbound server tests |
| Error mapping | Legacy errors stable | `UnsupportedProtocolVersionError` with supported versions, header mismatch, unknown method, scope failure, invalid continuation, backpressure and task errors all preserve JSON-RPC/http semantics with **zero unauthorized tool executions** |

### Protocol/API cautions

- The modern protocol's per-request `_meta` fields are mandatory even if a client first called `server/discover`.
- `resultType = "input_required"` is a distinct state from `complete`; the retry uses a fresh JSON-RPC request ID. Do not treat a retry as permission to re-execute the pre-input mutation.
- `x-mcp-header` is an optional mechanism for schema-annotated **primitive** parameters; when used it must apply official name/ASCII/Base64 rules and compare decoded headers to authoritative arguments. Do not accept headers as standalone tool arguments.
- `cacheScope="public"` is forbidden for any result influenced by credentials, workspace, policy, user preference or client-specific routing; no cross-principal cache keys.
- Legacy `tasks` implementation may remain behind the legacy binding even when modern Tasks extension is disabled. A modern failure to support the optional extension is **not** proof of baseline core failure.

## 6. Security, failure semantics and evidence

### Mandatory invariants

1. **Single execution gateway:** all legacy/modern and child tool calls go through the same registry→policy→approval→audit path; tool hints, `serverInfo`, `_meta`, forwarded headers, task IDs or filesystem handles are not authorization.
2. **Trust identity:** derive principal/scopes from verified HTTP credential or current local stdio trust policy. Reject credential audience/issuer mismatches, absent auth on protected routes, cross-user access, cross-workspace handles and replay of stale authorization.
3. **Replay and retries:** the current per-Server in-memory `mutationReplay` map is *not* a cross-request or durable exactly-once mechanism. Before allowing modern potentially mutating `tools/call`, define stable server-enforced operation identity tied to principal + workspace + canonical args + explicit operation handle + approval state, with persisted deduplication/outcome-uncertain state or **reject** unsafe retries. Duplicate request IDs, JSON-RPC IDs or self-asserted client idempotency strings alone are insufficient. No automatic replay after crash/timeouts.
4. **MRTR/approval:** an input-required continuation never grants permission merely because the caller possesses `requestState`; bind it to authenticated principal, original operation digest, scope, workspace and expiry; at most one committed execution per approved action. Race tests include approval revocation, stale/modified inputResponses, repeated continuation and disconnect.
5. **HTTP hardening:** validate Origin, HTTP method, content type/accept, size limits, modern header/body match, invalid/multiple header values, Base64 sentinel, tool name/URI, proxy normalization and truncated JSON before dispatch. Do not let the new route bypass legacy gateway guard or OAuth scope filtering.
6. **State/caching:** explicit handles are opaque/unguessable, TTL-bound and owner-checked server-side. Response caches cannot expose another principal's catalog or resources; invalidate/avoid caching after policy, scopes or workspace changes.
7. **Task/subscription ownership:** enforce authorization on create/poll/update/cancel/stream; bound concurrent streams, server storage, queues and payload size. Cancellation and lost connection must preserve truthful `executed`, `not_executed`, `outcome_uncertain` distinctions in audit/proof.
8. **Auditability:** record era, negotiated protocol, authenticated principal ID, request/operation ID, *redacted* outcome/failure category; do not log raw credentials, user elicitation responses, Authorization or full sensitive tool payloads.

### Threat-focused negative suite

- HTTP version mismatch; method/name header conflicts; missing modern `_meta`; duplicate/ambiguous headers; Base64 lookalikes and Unicode; `x-mcp-header` spoofing; cross-era traffic.
- Anonymous/cross-principal `tools/list`/resource/task access; token issuer/audience mismatch; Origin/DNS rebinding attack; an authenticated low-scope client trying a high-risk mutation.
- Two concurrent duplicate mutations from separate HTTP connections; crash after side effect before reply; retry with changed args; old approval reused after principal/scope/task changes; lost MRTR continuation.
- Broken/unbounded SSE; cancellation after commit; `subscriptions/listen` reconnect with revoked permissions; escaped or expired task handle.
- Child version probe timeout, modern server returning a recognized protocol error vs a legacy server returning unknown method, downgrading an *auth error* (must fail, not fallback).

## 7. Conformance and rollout verification contract

### Tests and required evidence (to be planned **after written spec approval**)

| Gate | Test layer and required assertion |
| --- | --- |
| Legacy regression | Real stdio `initialize` + `notifications/initialized` + list/call; token and OAuth HTTP sessions; 2025-era Tasks; prior error/close semantics unchanged |
| Modern core | Raw JSON-RPC fixtures + a pinned real modern TypeScript client: `server/discover`, version mismatch, tools list/read/call, prompts/resources; exact `resultType`/header rules and modern stdio |
| Modern HTTP | Per-request authenticated POST without `Mcp-Session-Id`; correct `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; 400/404/401/403 negative cases; optional SSE output |
| Identity/security | Read-only/low-scope denial; cross-user/cache/workspace isolation; no bypass via JSON-RPC metadata; persisted audit evidence after failure |
| Mutation reliability | RED→GREEN duplicate/retry/timeouts/restart/revocation corpus; prove no double side effect and honest `outcome_uncertain` after ambiguous completion |
| Modern optional features | MRTR input-required + continuation if advertised; modern Tasks extension `tasks/get`/`tasks/update` and ownership if advertised; subscriptions/listen only when implemented; otherwise verify **not advertised** |
| Outbound child adapter | Explicit modern/legacy probe matrix using real official server fixtures and existing pinned child third-party corpus; report unsupported separately |
| Platforms / lifecycle | Node 22 and 24 on Linux/macOS/Windows where workflow executes relevant steps; `npm run verify`, stdio/HTTP/auth smokes, `npm run docs:check`, architecture check, exact-head multi-OS CI, reviewed PR, post-merge main CI |

For each real client probe capture **client name, pinned version, transport, requested version, feature, command, exit/HTTP outcome, raw redacted evidence, and PASS/FAIL/SKIP/NOT_RUN/UNAVAILABLE**. A pinned official SDK fixture proves that SDK/feature only; it does not certify ChatGPT, Claude, VS Code, or every plugin. Existing CI matrix jobs with skipped OS-specific steps do not count as full platform certification.

### Rollout, operational gates and failure strategy

- **Gate 0 (design):** reviewer approves this focused written spec. No product modification before plan approval.
- **Gate 1 (plan):** separate written implementation plan reviewed and approved; exact file ownership, order of tasks, TDD tests and implementation method specified then.
- **Gate 2 (legacy foundation):** immutable compatibility snapshot and server-side decision boundary; no default changes; private test fixture must reproduce old semantics.
- **Gate 3 (modern core):** opt-in dual mode, official-client conformance and 0 security policy bypasses; support is reported per feature. Unimplemented modern extensions stay unadvertised.
- **Gate 4 (modern optional features/outbound):** independently test MRTR/Tasks/subscriptions and child client against official schema; if not complete, explicitly retain the feature disabled and the relevant gate OPEN.
- **Gate 5 (merge):** exact-head CI, human/independent security review of auth/replay, merge only by later explicit permission, post-merge CI and docs closeout. `main` must remain authoritative. Clean up only safe task branches after preserving evidence.

**Rollback trigger:** loss of legacy conformance, any unauthorized side effect, double mutation, cross-principal disclosure, invalid auth downgrade or misleading success reporting. Roll back opt-in dual mode; do not delete data or auto-retry uncertain operations.

## 8. Rejected alternatives, trade-offs and residual risks

| Option | Benefit | Why not selected |
| --- | --- | --- |
| A. Replace legacy SDK/server in place | Smaller apparent diff | Modern protocol breaks handshake/session semantics; high risk of legacy and Task regression |
| **B. Dual-era adapters (chosen)** | One authorization gateway, incremental migration, explicit rollback | More protocol validation and fixture surface; requires careful separation of request context from session state |
| C. Standalone modern reverse proxy | Strong process separation | Adds another deploy/auth boundary, operational drift and proxy-level confusion; may be considered later for a measured deployment requirement |

Risks to record, not hide: SDK version/API drift; old Task persistence cannot express modern transitions without migration; existing registry surface mutability; current replay cache per server; HTTP Origin validation and CORS interplay; mixed-era upgrades; real-client availability; hosted CI queue and unverified organization runner access.

**Release conditions unchanged:** `@musashishao/folderforge@3.0.1` remains a manually published historical release without verified exact-release 24h soak, OIDC trusted publishing/SBOM provenance; R16 real Podman and R17 independent release-security/operator gates stay open. G59 design/green tests cannot retroactively certify 3.0.1. No auto-tag, npm publish, CI runner modification or branch cleanup of unrelated work is authorized here.

## 9. Design review checklist

- [x] The intended outcome and approved B architecture are explicit; original legacy semantics are preserved rather than assumed replaceable.
- [x] The modern version/headers/discovery/MRTR/Tasks/caching requirements are mapped to official references and exact source boundaries.
- [x] The principal, authorization, mutation-replay, continuation, error and rollback trust boundaries have concrete failure cases.
- [x] Work is scoped to **one protocol modernization epic** with optional feature gates; no second orchestration engine or unapproved deployment.
- [x] Acceptance and non-claims are stated in observable terms, including cross-OS/client evidence limits.
- [x] This document contains **no implementation plan and no product code**. Written spec approval is the next human gate.

**Decision requested from maintainer:** approve/revise this **written G59 spec**. Approval allows a separate implementation plan via Superpowers `writing-plans`; it does **not** authorize coding, merging product changes or a release.
