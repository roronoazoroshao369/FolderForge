# G59 — Version-Aware MCP Protocol Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in, fail-closed MCP `2026-07-28` **core inbound** protocol adapter while preserving the legacy `2025-11-25`/currently supported client path and the single existing policy/approval/audit enforcement boundary.

**Architecture:** Keep the existing `createMcpServer` legacy SDK server intact, route modern stdio and authenticated HTTP into a version-aware wire adapter, and delegate modern read-only operations to the existing authorized application services. Use explicit, per-request, server-verified principal context. Modern mutation is denied until a separately approved durable idempotency/uncertain-outcome design and tests exist; never suggest exactly-once execution from the existing per-Server replay map. Modern MRTR, Tasks extension, outbound modern children, change-subscription streaming and cross-principal catalog caching remain unadvertised unless separately proven.

**Tech Stack:** TypeScript, Node.js `>=22`, existing `@modelcontextprotocol/sdk` dependency baseline `^1.32.1`, Vitest, Streamable HTTP, stdio, OAuth and `ToolRegistry`. First research the official SDK's actual 2026 exports; use supported library code for protocol framing where available.

**Spec:** `docs/superpowers/specs/2026-10-10-goal59-mcp-dual-era-protocol-adapter-design.md` at `abfcbc987437657c5b7ac5fef3cd834e15e7a5a2`. This is a **proposed implementation plan for review**, not authorization to write product code or merge.

## Global Constraints

- The design's **dual-era adapter (B)** is selected; `server.mcpProtocol.mode: legacy | dual`, default **legacy**. No protocol change to existing clients by default.
- Existing `initialize`, `notifications/initialized`, `Mcp-Session-Id`, legacy Tasks, session TTL, protected HTTP auth and stdio remain functional.
- Modern `2026-07-28` core uses `server/discover`, required per-request `params._meta`, `MCP-Protocol-Version`, `Mcp-Method` and conditional `Mcp-Name`; no modern protocol-level session.
- **One** `ToolRegistry.callAgent`/policy/approval/audit/Capsule gateway. No independent tool execution path or principal taken from `clientInfo`/`_meta`/headers.
- Modern read-only calls may execute after authorization. Mutating calls **fail closed** without durable, owner/operation-bound deduplication; do not add an undocumented new persistence format.
- Modern optional MRTR, Tasks extension, subscriptions, advertised cache lifetime and modern outbound child support are **not** claimed by the core adapter. Advertise each only after its own independently tested feature gate; the legacy equivalents remain.
- Keep Origin validation, bounded JSON size, no stdout logging, header/body consistency, OAuth scope filtering and redacted audit evidence.
- No runner rewrite, published release, npm tag, historical isolation deletion, unrelated dependency PR merge, branch cleanup or alteration to G58 forensic records.
- All planned edits use exact-head source and narrow file ownership; execute RED→GREEN→commit per task, then security review, full verify, exact-head CI and **separately authorized** product merge.

## Review Focus

Before green-lighting any implementation, pin these five easily missed user-visible failure cases in the owning tasks:

1. **Trust-first HTTP:** invalid Origin/credential is denied before parsing, discovery or tool dispatch, including legacy-vs-modern ambiguous traffic (Task 4: `denies_dns_rebinding_and_auth_before_dispatch`).
2. **Header ambiguity:** conflicting case-insensitive duplicate headers, malformed Base64 sentinel, non-ASCII name and request/body mismatch cannot select a different resource or tool (Task 3: `rejects_duplicate_and_encoded_header_spoof`).
3. **No exactly-once fiction:** two connections or JSON-RPC request IDs cannot replay a modern mutation after lost response/restart (Task 7: `rejects_modern_mutations_before_side_effect_even_across_requests`).
4. **No cross-principal cache or handle:** an OAuth low-scope client must not receive another principal's tool list/resource/task data via a server-level cache (Task 6: `catalog_is_principal_scoped_and_not_public_cached`).
5. **False capability success:** a 2026 client requesting MRTR, modern Tasks or change streams receives truthful unsupported results, not legacy semantics or fake success (Task 8: `does_not_advertise_unimplemented_modern_extensions`).

---

## Scope/ownership map

| Unit | Responsibility | Primary files |
| --- | --- | --- |
| Config mode | Explicitly opt in to dual-era routing | `src/core/types.ts`, `src/runtime/config.ts`, `src/main.ts` |
| Request model / classifier | Validate protocol shape and choose era, without authorization | `src/server/protocol/request-context.ts`, `src/server/protocol/era-router.ts` |
| HTTP validation | Trust-first origin and mirrored headers, method/name binding | `src/server/protocol/http-headers.ts`, `src/server/transports/http.ts` |
| Modern result encoding | Modern envelopes without modifying legacy `toCallToolResult` | `src/server/protocol/modern-result.ts` |
| Authorized facade | Modern read-only registry dispatch + existing resource/prompt catalogs | `src/server/protocol/core-facade.ts`, `src/server/mcp-server.ts` |
| Modern binding | Discovery and stateless core RPC over HTTP and stdio | `src/server/protocol/modern-adapter.ts`, `src/server/transports/stdio.ts`, `src/main.ts` |
| Negative security/gates | Fail-closed mutating/extension requests; no unsafe retries | `src/server/protocol/modern-adapter.ts`, new Vitest suites |
| Interop evidence/docs | Pin exact clients and truthfully report feature/matrix status | `scripts/mcp-dual-era-conformance.mjs`, `docs/mcp-protocol-compatibility.md` |

Do **not** centralize all code in one oversized `http.ts`/adapter file. Reuse existing `McpResourceCatalog`, `McpPromptCatalog` and `ToolRegistry` from the same container/authorization context. Client-specific mutable `workspace_route` state cannot be assumed isolated by creating a new `Server`; test that limitation before advertising a dynamic modern catalog.

### Task 1: Capture legacy baseline and resolve official SDK compatibility

**Files:**
- Create: `tests/integration/mcp-legacy-contract.test.ts`
- Create: `docs/mcp-protocol-compatibility.md`
- Modify: `package.json`, `package-lock.json` **only if** an official supported SDK is essential; no speculative major bump.

**Interfaces:** Consumes current `createMcpServer`, `startHttpTransport`, `startStdioTransport` and `src/adapters/child-mcp/client.ts`. Produces frozen legacy fixtures, a verified SDK compatibility decision and pinned real-client versions. No production protocol change.

- [ ] Step 1 — Write `preserves_legacy_initialize_tools_and_tasks`: record 2025-11-25 `initialize`, `notifications/initialized`, HTTP `Mcp-Session-Id` ownership/TTL, stdio tools, OAuth/token deny cases and existing legacy Tasks via public transport. Include a 2025-06-18 fixture as existing smoke coverage, reporting support only where proven.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-legacy-contract.test.ts` and capture RED for the missing fixture assertion; verify `npm run smoke:stdio` and `npm run smoke:http` independently on the untouched baseline.
- [ ] Step 3 — Add the fixture plus `docs/mcp-protocol-compatibility.md`: capture locked SDK version, `npm view`/official SDK 2026 support evidence, package exports and Node 22/24 constraints. **Stop with a blocking finding instead of implementing an unreviewed protocol stack** if official conformance/API cannot be established. Lock the SDK only if needed and the dependency-change risk is reviewed.
- [ ] Step 4 — Re-run the legacy suite and smokes; expected GREEN, and exact pinned SDK/tool versions recorded; no legacy protocol changes.
- [ ] Step 5 — Commit fixtures/docs/optional reviewed lockfile only: `git commit -m "test: freeze legacy MCP contract and SDK evidence"`.

### Task 2: Config mode and request context

**Files:**
- Modify: `src/core/types.ts`, `src/runtime/config.ts`, `src/main.ts`
- Create: `src/server/protocol/request-context.ts`, `tests/unit/protocol-mode.test.ts`

**Interfaces:**
- `export type ProtocolMode = 'legacy' | 'dual'`.
- `export type McpEra = 'legacy' | 'modern'`.
- `export interface ModernRequestContext { era: 'modern'; protocolVersion: '2026-07-28'; transport: 'http' | 'stdio'; principal: ToolPrincipal; clientCapabilities: Record<string, unknown>; requestId: string | number; signal: AbortSignal; }`
- Produces `config.server.mcpProtocol.mode` and trusted context; never accepts principal/scopes from JSON-RPC body.

- [ ] Step 1 — Test `defaults_to_legacy`, `validates_dual_only`, `ignores_client_supplied_principal` and `rejects_unknown_mode`. Assert a default config preserves legacy behavior and `server.mcpProtocol.mode: "dual"` is the sole opt-in.
- [ ] Step 2 — Run `npx vitest run tests/unit/protocol-mode.test.ts`; expected RED because new mode/context do not exist.
- [ ] Step 3 — Add the enum/config default/validation and immutable trusted context factory; thread mode through `main.ts` without changing `startHttpTransport`/stdio's legacy default path.
- [ ] Step 4 — Re-run focused tests and `npm run typecheck`; expected GREEN.
- [ ] Step 5 — Commit `git commit -m "feat: add opt-in dual MCP mode and trusted request context"`.

### Task 3: Era selection and strict modern HTTP header validation

**Files:**
- Create: `src/server/protocol/era-router.ts`, `src/server/protocol/http-headers.ts`
- Test: `tests/unit/mcp-era-router.test.ts`, `tests/unit/mcp-modern-http-headers.test.ts`

**Interfaces:**
- `export type EraDecision = { era: McpEra; protocolVersion: string } | { error: 'mixed_era' | 'missing_version' | 'unsupported_version' | 'malformed_request' }`.
- `export function classifyMcpEra(input: { mode: ProtocolMode; transport: 'stdio' | 'http'; method: unknown; params: unknown; headers?: IncomingHttpHeaders; lockedEra?: McpEra }): EraDecision`.
- `export function decodeMirroredHeader(value: string): string` (throws on malformed Base64 sentinel and non-canonical encoding).
- `export function validateModernHttpEnvelope(body: unknown, headers: IncomingHttpHeaders): { ok: true; method: string; name?: string; protocolVersion: '2026-07-28' } | { ok: false; status: 400 | 404; code: number; error: string }`.
- Header-body parity checks operate only on existing, schema-validated `x-mcp-header` annotations; do not invent tool parameters from headers.

- [ ] Step 1 — Add tests for `classifies_legacy_initialize_and_modern_discover`, `rejects_mixed_era_without_fallback`, `rejects_missing_or_unsupported_version`, `rejects_duplicate_and_encoded_header_spoof`, `supports_non_ascii_mcp_name_via_sentinel` and `rejects_invalid_custom_param_header`. Assert modern mismatch gives HTTP 400, unsupported version gives `-32022` with `supported`/`requested`, unknown method maps 404/`-32601`.
- [ ] Step 2 — Run `npx vitest run tests/unit/mcp-era-router.test.ts tests/unit/mcp-modern-http-headers.test.ts`; expect RED for missing exports.
- [ ] Step 3 — Implement routing/strict mirror validation using official 2026 schema constants; reject a modern-shaped request in `legacy` mode without an unsafe downgrade; never rely on header values as authorization.
- [ ] Step 4 — Re-run these tests plus `npm run typecheck`; expected GREEN including Unicode and invalid duplicate raw headers.
- [ ] Step 5 — Commit `git commit -m "feat: validate modern MCP era and HTTP wire metadata"`.

### Task 4: Trusted HTTP dual routing (without legacy regression)

**Files:**
- Modify: `src/server/transports/http.ts`, `src/main.ts`
- Test: `tests/integration/mcp-modern-http.test.ts`, `tests/unit/http-hardening.test.ts`, `tests/integration/http-session-lifecycle.test.ts`

**Interfaces:** `startHttpTransport(makeMcpServer, opts)` remains compatible; extend `HttpTransportOptions` with `protocolMode?: ProtocolMode` and optional `handleModernRequest(req, res, body, principal): Promise<void>` supplied by the same server runtime. Authenticated principal is derived **before** modern handler dispatch.

- [ ] Step 1 — Test `denies_dns_rebinding_and_auth_before_dispatch`, `modern_post_without_session_id`, `legacy_init_session_ttl_unchanged`, `rejects_cross_principal_session`, `rejects_mixed_legacy_session_and_modern_headers`, `enforces_json_size_and_accept`. Use real token/OAuth HTTP ports, not helper-only mocks.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-modern-http.test.ts tests/integration/http-session-lifecycle.test.ts`; new 2026 tests RED; existing legacy tests GREEN.
- [ ] Step 3 — Route authenticated `/mcp` POST by Task 3's classifier **after** mandatory gateway guard/Origin checks and auth. Modern callback only receives trusted principal + parsed JSON. Keep legacy `StreamableHTTPServerTransport` session path unchanged. Treat preflight CORS separately from required Origin validation and never disable existing OAuth metadata authorization.
- [ ] Step 4 — Re-run tests, `npx vitest run tests/integration/oauth-http.test.ts tests/unit/http-hardening.test.ts`, and `npm run smoke:http`; expected GREEN with no modern `Mcp-Session-Id`.
- [ ] Step 5 — Commit `git commit -m "feat: route authenticated modern MCP HTTP requests safely"`.

### Task 5: Modern discovery, stdio routing and result envelopes

**Files:**
- Create: `src/server/protocol/modern-adapter.ts`, `src/server/protocol/modern-result.ts`
- Modify: `src/server/transports/stdio.ts`, `src/main.ts`
- Test: `tests/integration/mcp-modern-stdio.test.ts`, `tests/unit/mcp-modern-result.test.ts`, `tests/integration/mcp-modern-http.test.ts`

**Interfaces:**
- `export function createModernAdapter(facade: CoreMcpFacade): { handleRpc(body: unknown, context: ModernRequestContext): Promise<Record<string, unknown>> }`.
- `export function toModernToolResult(result: ToolResult): Record<string, unknown>` (2026 `resultType: 'complete'` on successful supported tool results, spec-shaped error for failures).
- `server/discover` is the mandatory stateless modern capability/version response; no legacy initialization side effect.

- [ ] Step 1 — Test `discovers_2026_exact_supported_versions`, `modern_stdio_first_request_locks_era`, `legacy_initialize_first_request_still_works`, `unknown_modern_method_is_404` and `modern_result_has_result_type_and_no_legacy_task_advertisement`. Validate official schema, not merely `response.ok`.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-modern-stdio.test.ts tests/unit/mcp-modern-result.test.ts`; expect RED.
- [ ] Step 3 — Implement schema-compliant modern core framing/discovery/results, reusing verified official SDK primitives; stdio locks era after the first **valid** RPC and leaves legacy `StdioServerTransport` behavior unchanged when default/legacy chosen. Mixed traffic fails before dispatch; no stdout logs.
- [ ] Step 4 — Re-run modern tests, `npm run smoke:stdio` and `npm run smoke:http`; expect GREEN for explicitly supported features.
- [ ] Step 5 — Commit `git commit -m "feat: add modern MCP discovery and stdio framing"`.

### Task 6: Shared authorized core facade and principal-scoped catalogs

**Files:**
- Create: `src/server/protocol/core-facade.ts`
- Modify: `src/server/mcp-server.ts` only to extract/reuse **existing** guarded services; `src/server/protocol/modern-adapter.ts`
- Test: `tests/integration/mcp-modern-core.test.ts`, `tests/unit/mcp-principal-catalog.test.ts`

**Interfaces:**
- `export interface CoreMcpFacade { listTools(ctx: ModernRequestContext): Promise<unknown>; callToolReadOnly(name: string, args: Record<string, unknown>, ctx: ModernRequestContext): Promise<ToolResult>; listResources(ctx: ModernRequestContext): Promise<unknown>; readResource(uri: string, ctx: ModernRequestContext): Promise<unknown>; listPrompts(ctx: ModernRequestContext): Promise<unknown>; getPrompt(name: string, args: Record<string,string>, ctx: ModernRequestContext): Promise<unknown>; }`
- Reuse `ToolRegistry.classifyCall` and `ToolRegistry.callAgent` with server-derived `ToolCallControl.principal`, the same `McpResourceCatalog`, `McpPromptCatalog` and OAuth-scope checks already used by legacy paths.

- [ ] Step 1 — Write `modern_tools_list_and_read_only_call_use_registry`, `modern_resources_and_prompts_work_through_public_rpc`, `catalog_is_principal_scoped_and_not_public_cached`, `denies_cross_user_task_resource`, `no_bypass_for_oauth_write_tool`. Instrument a fixture registry to assert **exactly one** authorized call and zero direct handler calls.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-modern-core.test.ts tests/unit/mcp-principal-catalog.test.ts`; expect RED.
- [ ] Step 3 — Extract only narrow reusable services, retain legacy wire handlers and authorizations; modern facade enforces scope before catalog/resource access. Do not enable shared public cache for principal/project-dependent lists, even if the protocol allows cache hints.
- [ ] Step 4 — Re-run focused tests, existing `tests/integration/mcp-platform.test.ts`, `npm run architecture:check`; expected GREEN with stable tool definitions.
- [ ] Step 5 — Commit `git commit -m "feat: share governed MCP core across legacy and modern bindings"`.

### Task 7: Fail-closed modern mutations, replay and cancellation

**Files:**
- Modify: `src/server/protocol/modern-adapter.ts`, `src/server/protocol/core-facade.ts`
- Test: `tests/integration/mcp-modern-mutation-gate.test.ts`, `tests/integration/mcp-modern-http.test.ts`

**Interfaces:** `CoreMcpFacade.callToolReadOnly` checks **dynamic** classification (`registry.classifyCall(name, args)`) and rejects if `classification?.mutates ?? tool?.mutates ?? true` before execution. No modern operation key or persistence format is introduced in this milestone. Return spec-shaped denial and audit `not_executed` only when the durable existing audit path can record it truthfully.

- [ ] Step 1 — Test `rejects_modern_mutations_before_side_effect_even_across_requests`, `rejects_repeated_request_id_after_timeout`, `denies_dynamic_mutations_with_readonly_annotation`, `cancellation_after_commit_does_not_claim_not_executed`. Reuse a fixture with a mutation counter; two independent authenticated connections must leave counter unchanged.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-modern-mutation-gate.test.ts`; expect RED.
- [ ] Step 3 — Add a **fail-closed modern mutation guard** before `registry.callAgent` (including unknown/dynamically mutating tools). Ensure cancellation abort signals cover read-only work and no client-supplied request ID bypasses the guard. Retain legacy replay semantics, including their explicitly documented limitations.
- [ ] Step 4 — Re-run mutation, OAuth and existing `tests/integration/http-session-lifecycle.test.ts`; expected GREEN and zero unauthorized side effects. Prove ambiguous outcomes are never reported as confirmed not-executed if an operation may have committed.
- [ ] Step 5 — Commit `git commit -m "security: fail closed modern MCP mutations pending durable replay gate"`.

### Task 8: Hide unsupported modern features and preserve child compatibility

**Files:**
- Modify: `src/server/protocol/modern-adapter.ts`
- Test: `tests/integration/mcp-modern-capabilities.test.ts`, `tests/unit/child-mcp-client.test.ts`
- Modify: `docs/mcp-protocol-compatibility.md`

**Interfaces:** `server/discover` accurately advertises only proven core `tools`, `resources`, `prompts`. Legacy core `tasks` remains behind legacy binding. Modern `io.modelcontextprotocol/tasks`, `subscriptions/listen`, MRTR `input_required`, `cacheScope` hints and 2026 outbound child probing stay absent unless separate tests establish full semantics.

- [ ] Step 1 — Test `does_not_advertise_unimplemented_modern_extensions`, `rejects_unimplemented_tasks_update`, `does_not_emit_legacy_server_initiated_rpc_to_modern_client`, `legacy_child_initialize_still_negotiates`, `modern_request_state_cannot_be_replayed_as_approval`.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-modern-capabilities.test.ts tests/unit/child-mcp-client.test.ts`; expect RED for missing modern capability assertions.
- [ ] Step 3 — Advertise only implemented core methods; explicit unsupported error for optional requests. Keep child outbound on its proven legacy path and record unsupported 2026 outbound capability as `NOT_IMPLEMENTED`, rather than changing `src/adapters/child-mcp/client.ts` without separate review.
- [ ] Step 4 — Re-run tests and `node scripts/child-mcp-compatibility.mjs` after build; expected GREEN where existing fixture support exists and honest `NOT_RUN/UNAVAILABLE` for missing modern clients.
- [ ] Step 5 — Commit `git commit -m "test: gate optional MCP features and protect legacy child clients"`.

### Task 9: Real-client conformance, release-neutral handoff and exact-head verification

**Files:**
- Create: `scripts/mcp-dual-era-conformance.mjs`, `tests/integration/mcp-dual-era-client.test.ts`
- Modify: `docs/mcp-protocol-compatibility.md`, `docs/CURRENT_FRONTIER.md`, `docs/HANDOFF.md`

**Interfaces:** CLI `node scripts/mcp-dual-era-conformance.mjs --output <path>` emits a bounded redacted JSON report with `{client, clientVersion, transport, protocolVersion, feature, status, evidence}`; each status is `PASS | FAIL | SKIP | NOT_RUN | UNAVAILABLE`. Pin official-client package version from Task 1; do not infer a third-party product integration from a fixture.

- [ ] Step 1 — Write tests `reports_exact_client_and_version`, `marks_unexecuted_feature_not_run`, `rejects_false_pass_without_evidence`, `legacy_and_modern_public_transport_smokes`, `untrusted_origin_never_executes`.
- [ ] Step 2 — Run `npx vitest run tests/integration/mcp-dual-era-client.test.ts`; expect RED.
- [ ] Step 3 — Implement pinned real-client harness with temp fixture workspace, CLI output, timeouts and explicit raw redacted evidence. Document matrix outcomes and separately name gates still open (modern mutations/Tasks/MRTR/outbound, R16/R17, 24h soak/OIDC/SBOM), plus no npm publish.
- [ ] Step 4 — Run `npm run verify`, `npm run docs:check`, `npm run smoke:stdio`, `npm run smoke:http`, `npm run architecture:check`, `npm run build`, `node scripts/mcp-dual-era-conformance.mjs --output .folderforge-ci/g59-conformance.json`, and repo CI on the exact final PR head. The six-job platform matrix requires **actual** job results; skipped platform steps are `NOT_RUN`. Ask an independent reviewer to inspect auth/replay and wire semantics on that exact head. Do not declare G59 delivered if any mandatory gate fails.
- [ ] Step 5 — Commit `git commit -m "test: record real-client dual-era conformance evidence and handoff"`; after reviewed PR and separately authorized product merge, require post-merge main CI on the merge SHA and documentation closeout before claiming G59 closed.

## Spec coverage and explicit deferred items

| Written spec requirement | Planned owner | Required disposition |
| --- | --- | --- |
| Versions, opt-in legacy default, rollback | Tasks 1–3 | Implement and prove |
| 2026 metadata, HTTP header parity, unknown versions | Tasks 3–5 | Implement and prove |
| Trust-first HTTP auth, Origin, principal | Tasks 2, 4, 6 | Implement and prove |
| Shared policy/approval/audit, resources/prompts/tools | Tasks 5–7 | Implement and prove for read-only; deny modern mutations |
| Modern replay/mutation safety | Task 7 | **Fail-closed denial** until a separate durable-idempotency gate is approved; do not claim mutating parity |
| Modern MRTR, Tasks extension and change streams | Task 8 | **Not advertised**, return explicit unsupported; separately spec/plan if enabled later |
| Modern outbound child-client compatibility | Tasks 1, 8–9 | Keep legacy outbound; explicitly `NOT_IMPLEMENTED` for modern |
| Modern caching | Tasks 6, 8 | Do not advertise positive TTL/public caching |
| Real client, negative security and multi-OS CI | Task 9 | Measured evidence only; no transitive certification |
| Production publish, Podman, beta, soak, OIDC/SBOM | Task 9 docs | Remain open; outside G59 |

**Scope warning for maintainer:** this plan delivers a **core inbound, read-only modern compatibility milestone**, not full 2026 extension coverage or modern write parity. It intentionally makes unsafe capabilities unavailable instead of loosening legacy security. If full modern mutations or extensions are required in G59, a separate reviewed design and revised plan must precede those changes.

## Plan self-review and execution handoff

- [x] Every written-spec requirement is assigned a task or an explicit fail-closed/non-advertised gate; none is silently claimed complete.
- [x] Files are split by owner; no new execution engine, model backend, unreviewed durable mutation database or release action.
- [x] Function signatures and status enums are consistent across tasks; existing legacy exports remain stable.
- [x] Each task has a RED command, minimal bounded GREEN objective, re-run and commit; five highest-risk input classes have named owning tests.
- [x] A proposed modern-core limitation is disclosed in advance, not hidden in a success claim.

**Review decision requested:** approve or request revision of **this implementation plan**. Recommended execution: **Native** with targeted independent auth/replay review and exact-head six-job CI because modern and legacy adapters share the security boundary. **No product coding or merging is authorized by the plan's mere publication.**
