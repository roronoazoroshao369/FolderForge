# MCP Facade (MCP-in-MCP gateway for large child servers)

**Status: IMPLEMENTED (Option B).** Steps 0-8 landed. The facade ships behind the
opt-in `facade: true` adapter flag; see `docs/adapters.md` for usage and
`tests/integration/facade.test.ts` for the governance guarantees. This doc is
retained as the design record (problem, options, decisions, delivery plan).

**Implementation note (Step 6 deviation).** The facade's `<adapter>__list_tools`
/ `<adapter>__call_tool` names are _per-adapter and discovered at wiring time_,
so - like every other `<adapter>__<tool>` name - they contain `__` and are
excluded from `FROZEN_TOOLS` by the existing "adapter tools are dynamic, not
frozen" rule (`tests/unit/schema-lock.test.ts` filters `name.includes('__')`).
Freezing them would require a static per-adapter enumeration the schema-lock
deliberately avoids. Their contract is instead pinned in code: `list_tools` is
`LOW`/`mutates:false`, `call_tool` is the `MEDIUM`/`mutates:true` envelope, and
the effective sub-op risk is resolved per call via
`src/adapters/child-mcp/risk-map.ts`.

**Current execution contract.** `call_tool` uses `ToolDefinition.classifyCall` to
resolve the selected sub-tool's synthetic identity, risk, mutation flag, and
approval arguments before OAuth and policy evaluation. The logical sub-tool then
passes through one governance pipeline only. This prevents the facade envelope
from blocking LOW reads in `readonly`, avoids consuming wrapper quota before a
sub-tool denial/approval, and keeps one audit/rate-limit identity per operation.
The public `call_tool` schema remains a conservative mutating envelope because MCP
annotations and listed OAuth schemes cannot vary by arguments; request-time
enforcement uses the narrower concrete classification.

## Problem

FolderForge proxies child MCP servers by discovering their tools via `tools/list`
and re-exporting each one namespaced as `<adapter>__<tool>` (see
`docs/adapters.md`, `src/tools/adapter-tools.ts`, `src/tools/index.ts`).

Many agents/clients cap an integration at **~50 tools**. Native FolderForge is
already tuned to that ceiling via `GROUP_PRESETS` + `PRESET_TOOL_CAP`
(`vibe-lite` lands at exactly 50). But a single child server can be huge:

- **Godot MCP** targets **149 tools** across 26 families (`docs/godot-mcp.md`).

Namespacing all 149 out blows the cap instantly and crowds out every native
tool. Today the only lever is to hide most of them — which means the child is
never usable in full. We need a way to keep **all 100+ child ops reachable while
consuming ~1 slot** on the agent side.

The chosen shape (confirmed with the maintainer):

- **Opt-in per adapter.** Only adapters flagged as "large" get a facade; small
  adapters (Serena, Playwright) keep flat `<adapter>__<tool>` namespacing. No
  regression for the common case.
- **Discovery via `list_tools` + `call_tool`.** The facade advertises a tiny,
  fixed tool pair; the agent pulls per-sub-tool schemas on demand.
- **Per-sub-op governance is non-negotiable.** Every underlying operation is
  still risk-classified and approval-gated individually; the dispatcher must not
  become a governance bypass, and the audit trail must record the _real_
  sub-tool, not just the dispatcher name.
- **Schema-lock:** facade tools are generated per adapter and remain dynamic,
  outside `FROZEN_TOOLS`, exactly like other namespaced adapter tools. Their
  envelope contract is pinned in the facade builder and regression tests.

## Background: how routing works today

- `src/adapters/child-mcp/client.ts` — minimal stdio JSON-RPC client:
  `initialize`, `listTools()`, `callTool(name, args)`.
- `src/adapters/child-mcp/registry.ts` — lazy-spawns children (`ensure(name)`).
- `src/tools/adapter-tools.ts` — `buildAdapterTools()` discovers each child's
  tools and wraps each as a native `ToolDefinition` (namespaced, `MEDIUM`/
  `mutates:true` default), routed through `ToolRegistry.call`.
- `src/tools/registry.ts` — `ToolRegistry.call` runs the **whole governance
  pipeline per call**: audit record → `policy.evaluate(name, risk, mutates,
args)` → approval (dashboard or elicitation) → rate limit → handler → audit
  result. This is the pipeline we must keep hitting once per sub-op.
- `src/server/mcp-server.ts` — `tools/list` returns `registry.listActive()`;
  `tools/call` delegates to `registry.call(name, args, control)`. `control`
  carries `elicitInput` (interactive approval) and `signal` (cancellation).
- `src/tools/schema-lock.ts` — `FROZEN_TOOLS` freezes native names +
  `mutates`/`risk`. Adapter tools are explicitly **not** frozen (dynamic).

Key constraint that shapes everything below: **governance keys off the tool
`name` passed to `registry.call`**. A dispatcher that calls the child directly
(bypassing `registry.call`) would silently skip policy/approval/audit — the one
thing we must not do.

## Options

### Option A — Single dispatcher tool

One tool, e.g. `godot__dispatch`, with `{ tool: string, args: object }`. Proxies
straight down to the child's `tools/call`.

```
tools/list  ->  [ ..native.., godot__dispatch ]         # 1 slot
call         ->  godot__dispatch({ tool:"run_project", args:{...} })
```

- **Discovery:** the agent must already know sub-tool names and their arg shapes.
  Only source is the dispatcher's `description` — so we'd have to inline (a
  summary of) 149 schemas into one string. That's exactly the token blowup a
  facade is meant to avoid, and it's static (drifts from the child).
- **LLM accuracy:** worst of the three. No per-sub-tool JSON schema means no
  argument validation/autocomplete; the model guesses arg names and enum values.
  With 149 similarly-named ops (`get_status` vs `query_status`) misfires are
  likely — this is the documented failure mode of tool overload.
- **Governance:** doable but requires care — the dispatcher handler must
  re-enter the governance pipeline keyed on the _sub-tool_ (not on
  `godot__dispatch`), or approvals/risk collapse to one bland MEDIUM gate.
- **Schema-lock:** trivial — 1 frozen tool.
- **Verdict:** smallest surface, weakest usability. Good only if the agent has
  out-of-band knowledge of the child.

### Option B — Dispatcher + discovery (`list_tools` + `call_tool`)

Two fixed tools per large adapter:

- `godot__list_tools({ family?, name_contains?, cursor? })` → returns sub-tool
  descriptors: `name`, `description`, `inputSchema`, `risk`, `mutates`, `family`.
- `godot__call_tool({ tool: string, args: object })` → runs one sub-op through
  the full governance pipeline.

```
tools/list   ->  [ ..native.., godot__list_tools, godot__call_tool ]   # 2 slots
step 1        ->  godot__list_tools({ family:"Scene Management" })
                    -> [{name:"open_scene", inputSchema:{...}, risk:"HIGH"}, ...]
step 2        ->  godot__call_tool({ tool:"open_scene", args:{ path:"..." } })
```

- **Discovery:** real, dynamic, and paginated. The agent lists (optionally
  filtered by family/substring) then reads the exact `inputSchema` for the one
  sub-tool it wants — schemas fetched on demand, not dumped up front. Mirrors the
  emerging ecosystem pattern (tool-gating / meta-MCP: "discover then call").
- **LLM accuracy:** much better than A — the model sees the true per-sub-tool
  schema right before calling, so args validate. Still one notch below flat
  native tools (no first-class autocomplete in the client's tool picker, and it
  costs an extra `list_tools` round-trip), but the schema is authoritative and
  never drifts because it's read live from the child.
- **Governance:** clean. Before the handler runs, `classifyCall` looks up the
  sub-tool's risk/mutation contract and supplies a synthetic per-sub-op identity
  (for example `godot__call_tool:open_scene`). Policy mode, OAuth step-up,
  approval, rate-limit, handler execution, and audit then run once for that
  logical sub-op. `list_tools` is LOW/read-only. The dispatcher cannot downgrade
  risk because classification comes from the adapter risk map, not caller args.
- **Schema-lock:** the generated facade pair and child catalog are dynamic adapter
  tools and remain outside the native frozen surface.
- **Verdict:** best balance of slot cost (2), discoverability, and governance.

### Option C — Hybrid: one dispatcher per family

Group the child's 26 families; expose one `call_tool`-style entry per family
(e.g. `godot__scene({ op, args })`, `godot__runtime({ op, args })`), optionally
plus one `list_tools`.

```
tools/list   ->  [ ..native.., godot__project, godot__scene, godot__runtime, ... ]
                  # ~10-15 slots depending on family count
```

- **Discovery:** the family split is itself a coarse taxonomy the model reads
  from tool names; still needs `list_tools` (or per-family descriptions) for the
  `op` enum + arg schemas.
- **LLM accuracy:** better than a single blob (the family narrows the search
  space, and per-family `op` enums are shorter), but each family tool still hides
  N schemas behind one entry.
- **Governance:** same re-entry requirement as B, per family.
- **Slot cost:** the sticking point. 26 families would need heavy grouping to
  stay under budget; a sensible fold (~10-15 tools) is a middle ground but eats a
  meaningful chunk of the 50-tool budget that native tools also need.
- **Verdict:** a reasonable fallback if a client can't do the two-step B flow,
  but strictly more slots than B for no governance benefit.

## Cross-cutting analysis (applies to all options)

**Sub-tool discovery.** With a facade, per-sub-tool JSON schema no longer lives
in `tools/list`. A (`list_tools`) beats jamming it into a description: dynamic,
paginated, filterable, and always in sync with the live child. This is what B/C
provide and A lacks.

**LLM accuracy.** Losing per-tool schema from the client's native picker does
raise miscall risk (documented tool-overload effect). B mitigates it by handing
the model the exact schema on demand immediately before the call; A does not.
Recommend `list_tools` responses include `risk` and a one-line `description` per
sub-tool so the model can self-select and anticipate approval prompts.

**Policy / approval / risk.** Hard requirement: **each logical sub-op crosses one
governance pipeline under its own classification.** Before the `call_tool`
handler runs, `ToolDefinition.classifyCall` resolves the sub-tool's `risk` and
`mutates` values (from a per-adapter risk map — for Godot, the 149-tool bands in
`docs/godot-mcp.md`; default `MEDIUM`/`mutates:true` otherwise), its synthetic
identity, and its approval arguments. OAuth → `PolicyEngine.evaluate` → approval
→ rate-limit → handler → audit then runs once under that effective contract.
Consequences:

- `game_eval` (CRITICAL) still requires `danger` mode + approval even via facade.
- Audit records the **real sub-tool** (`summary`/`detail` carry
  `godot:open_scene`), so the trail is not blurred to one dispatcher line.
- Rate limits count per sub-op, not per dispatcher.

**Schema-lock & dynamic surface.** Facade tools are generated per adapter and
are therefore excluded from `FROZEN_TOOLS`, like every other namespaced adapter
tool. The builder and tests pin the envelope contract (`list_tools` LOW/read-only;
`call_tool` MEDIUM/mutating), while request-time classification supplies the
selected sub-tool's effective contract. The child catalog also remains dynamic.

## Ecosystem survey

The "too many tools" problem is well-trodden; recurring patterns:

- **Proxy/gateway that filters the advertised list** — client sees a subset,
  full set stays reachable (mcpproxy, MetaMCP, MCPJungle, mcp-gateway). Overlaps
  with our existing presets/cap.
- **Discover-then-call meta-tools** — a small fixed tool pair (search/list +
  execute) fronting many backend tools, loading only what's needed within a
  token budget (tool-gating-mcp, hypertool). This is exactly Option B.
- **Semantic/RAG tool search** — rank tools by query relevance (BM25 /
  embeddings) instead of listing all. A natural later enhancement to
  `list_tools` (ranked, not just family-filtered).

**MCP spec support to exploit.** The protocol has
`notifications/tools/list_changed`: a server can tell the client its tool list
changed and the client re-pulls `tools/list`. This enables an _alternative_
"dynamic surfacing" approach (equip/unequip a family, then notify) as used by
hypertool. We note it as a **future option** but do not depend on it now: the
current server declares `capabilities: { tools: {} }` (no `listChanged`), and not
all clients honor the notification. Option B works on every client without it.

## Recommendation — Option B (`list_tools` + `call_tool`), opt-in per adapter

Chosen because it is the only option that simultaneously: costs ~2 slots
regardless of child size; keeps discovery dynamic and schema-accurate (best LLM
accuracy short of flat native tools); and preserves per-sub-op governance
end-to-end. It matches the dominant ecosystem "discover-then-call" pattern and
needs no client-specific capability. Option C stays documented as a fallback for
clients that struggle with the two-step flow; Option A is rejected (weakest
usability, static schema drift).

Applied opt-in: a `facade: true` flag on the adapter def. Flagged adapters emit
the `<adapter>__list_tools` / `<adapter>__call_tool` pair instead of N
namespaced tools; unflagged adapters are unchanged.

### Confirmed decisions (locked before build)

1. **Sub-tool identity for governance/audit — `<adapter>__call_tool:<subtool>`.**
   This synthetic key is what `call_tool` passes into the governance pipeline and
   what the audit trail records, so it never collides with the flat
   `<adapter>__<tool>` namespace used by non-facade adapters.
2. **Risk map source for Godot — the 149-tool bands table in
   `docs/godot-mcp.md`** is the authoritative per-sub-op risk map, with
   `MEDIUM`/`mutates:true` as the fallback for any child tool not in the map.
3. **`list_tools` ranking - substring in v1; BM25 relevance delivered post-v1.**
   v1 shipped with substring filtering only; optional free-text `query` BM25
   ranking was added afterwards (see Delivered enhancements).
4. **`list_changed` path — out of scope for v1.** Option B needs no notification;
   dynamic surfacing via `tools/list_changed` is revisited as a separate
   enhancement (see Future work).

## Delivery plan (small steps) - COMPLETE

Steps are sequenced so each is independently reviewable and CI-green.

- **[x] Step 0 — Config surface.** Add `facade?: boolean` to `AdapterDef`
  (`src/core/types.ts`) + default in `src/core/config.ts`. Doc the flag in
  `docs/adapters.md`. No behavior change yet.
- **[x] Step 1 — Child schema pass-through.** Extend `StdioChildClient.listTools()`
  to also return `inputSchema` (already available from the child; today's wrapper
  reads it, the client type just omits it). Pure plumbing.
- **[x] Step 2 — Sub-tool catalog cache.** In the child-MCP layer, cache each
  flagged adapter's discovered sub-tools (name, description, inputSchema) keyed
  by adapter, refreshable. Feeds both `list_tools` and risk resolution.
- **[x] Step 3 — Per-adapter risk map.** Introduce a risk-map lookup (default
  `MEDIUM`/`mutates:true`); wire the Godot bands from `docs/godot-mcp.md`.
- **[x] Step 4 — Facade tool builder.** In `adapter-tools.ts`, when `facade:true`,
  emit `<adapter>__list_tools` + `<adapter>__call_tool` instead of N tools.
  `list_tools` is a filtered/paginated LOW catalog read; `call_tool` dispatches
  only after pre-pipeline dynamic classification.
- **[x] Step 5 — Single-pass governance.** Add `ToolDefinition.classifyCall` and
  resolve the sub-op identity/risk/mutation/approval args before OAuth and policy.
  Registry, policy, approval, quota, handler, and audit execute once per sub-op.
- **[x] Step 6 (see deviation note above) — Dynamic schema contract.** Keep
  generated adapter facade names outside `FROZEN_TOOLS`; pin their envelope and
  per-call behavior through builder code, integration tests, and docs.
- **[x] Step 7 — Tests.** Extend the fake-stdio-MCP integration test (0.2) with a
  100+-tool child: assert only 2 tools advertised, `list_tools` filters, and a
  CRITICAL sub-op is approval-gated (governance not bypassed).
- **[x] Step 8 — Docs.** New section in `docs/adapters.md` + this file's "chosen"
  status; note the `list_changed` and semantic-ranking follow-ups as future work.

### Future work (explicitly out of scope for v1)

- Dynamic `tools/list_changed` "equip a family" surfacing (needs `listChanged`
  capability + client support).
- Sharing the facade mechanism across adapters (Option C style folding) if a
  client can't drive the two-step flow.

### Delivered enhancements (post-v1)

- **Semantic/BM25 ranking in `list_tools`.** `list_tools` accepts an optional
  free-text `query`. When set, the (substring-pre-filtered) catalog is ranked by
  a dependency-free BM25 over each sub-tool's `name` + `description` (name field
  boosted so a name hit outranks a description-only hit); non-matching sub-tools
  are dropped, the response sets `ranked: true`, and each entry carries a
  `score`. `name_contains` still works and can be combined with `query`.
  Implemented in `src/adapters/child-mcp/rank.ts`; covered by
  `tests/unit/facade-rank.test.ts` and `tests/integration/facade.test.ts`.
