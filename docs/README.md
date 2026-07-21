# FolderForge documentation

This index separates current user and operator guidance from contributor design
material and historical records.

## Getting started

| Document | Audience | Purpose |
| --- | --- | --- |
| [README](../README.md) | User | Install, first run, MCP client examples, and product overview. |
| [Compatibility](compatibility.md) | User / Operator | Supported Node and operating-system matrix and evidence rules. |
| [Playwright setup](playwright-macos.md) | User / Operator | Browser installation, degraded behavior, diagnostics, and macOS notes. |
| [Godot MCP](godot-mcp.md) | User / Operator | Install the shipped Godot addon and use editor/runtime tools. |

## Guides

| Document | Audience | Purpose |
| --- | --- | --- |
| [ChatGPT connection](chatgpt-connect.md) | Operator | Guided Auth0/DCR lifecycle for ChatGPT connectors. |
| [OAuth](oauth.md) | Operator | External authorization-server and protected-resource configuration. |
| [Workflows](workflows.md) | User / Contributor | Persistent governed workflow usage. |
| [MCP platform](mcp-platform.md) | User / Contributor | Resources, prompts, progress, cancellation, subscriptions, and principal-bound tasks. |
| [Policy as code](policy-as-code.md) | User / Operator | Restrictive project policy, RBAC selectors, execution identity, and audit correlation. |
| [AI coding runtime](ai-coding-runtime.md) | User / Contributor | Analyze, patch, verify, and report workflow. |
| [Artifacts and browser quality](artifacts.md) | User / Contributor | Content-addressed evidence, visual comparison, and accessibility checks. |
| [Browser emulation and flows](browser-emulation-flows.md) | User / Contributor | Device/network profiles and bounded governed UI flows. |
| [Distributed workers](distributed-workers.md) | Operator / Contributor | Remote worker identity, leases, artifacts, replay policy, and signed evidence. |
| [Verified marketplace](marketplace.md) | Operator / Plugin author | Publisher trust, immutable index, quarantine, moderation, and disabled install. |
| [Plugin SDK](plugin-sdk.md) | Plugin author | Template, validate, test, deterministic pack, keygen, SBOM/provenance, and signing CLI. |
| [Beta program](beta-program.md) | User / Maintainer | Entry, evidence, privacy, and graduation criteria for external beta testing. |
| [Benchmark protocol](../benchmarks/README.md) | Contributor / Maintainer | Neutral tasks, immutable result validation, and publication rules. |
| [Benchmark operations](benchmark-operations.md) | Contributor / Maintainer | No-shell harness execution, evidence, environment isolation, and result creation. |
| [Production-readiness action plan](production-readiness-action-plan.md) | Maintainer / Contributor | Approved epics, dependencies, proof gates, and 30/60/90-day execution sequence. |

## Reference

| Document | Audience | Purpose |
| --- | --- | --- |
| [Tools](tools.md) | User / Contributor | Native tool groups and behavior. |
| [Adapters](adapters.md) | User / Contributor | Child MCP configuration, facades, lifecycle, and diagnostics. |
| [Plugin system](plugin-system.md) | User / Contributor | Local plugin packaging and trust boundaries. |
| [Sandboxing](sandbox.md) | Operator / Plugin author | Docker/Podman isolation, image pinning, mounts, resources, and diagnostics. |
| [MCP facade](mcp-facade.md) | Contributor | Large child-server facade contract. |

## Security

| Document | Audience | Purpose |
| --- | --- | --- |
| [Vulnerability reporting](../SECURITY.md) | User / Researcher | How to report a suspected vulnerability privately. |
| [Technical security model](security.md) | Operator / Contributor | Path, command, secret, approval, auth, and audit controls. |
| [Audit durability ADR](adr-0006-audit-durability.md) | Operator / Contributor | Required versus best-effort evidence writes and failure semantics. |
| [Evidence store v2 ADR](adr-0007-evidence-store-v2.md) | Operator / Contributor | Hash chaining, signatures, strict migration, verification, and threat-model limits. |
| [Core/runtime boundary ADR](adr-0008-core-runtime-package-boundary.md) | Contributor / Maintainer | Dependency direction, cycle gates, and the Godot adapter extraction. |
| [Child MCP compatibility](child-mcp-compatibility.md) | Operator / Contributor | Deterministic protocol profiles, evidence, and third-party certification limits. |
| [Pinned third-party MCP compatibility](third-party-mcp-compatibility.md) | Operator / Contributor | Exact server/package pins, isolated execution, cross-platform artifacts, and claim boundaries. |
| [Runtime soak evidence](runtime-soak.md) | Operator / Maintainer | Resumable long-run harness, hash-chained samples, fault injection, verification, and 24-hour claim boundary. |
| [Maturity and proof matrix](maturity-and-proof.md) | User / Maintainer | Capability maturity, reproducible gates, prohibited claims, and external evidence backlog. |
| [Release inventory](release-inventory.md) | Maintainer / Researcher | Factual npm, tag, and hosted-release provenance snapshot with explicit unknowns. |
| [OAuth ADR](adr-0004-oauth-resource-server.md) | Contributor / Maintainer | Resource-server architecture and trade-offs. |

## Architecture

| Document | Audience | Purpose |
| --- | --- | --- |
| [Architecture](architecture.md) | Contributor | Main components and data flow. |
| [MCP plugin architecture](mcp-plugin-architecture.md) | Contributor | Plugin architecture. |
| [Distributed workers and marketplace ADR](adr-0005-distributed-workers-marketplace-gates.md) | Contributor / Maintainer | Implemented local architecture and remaining public-service gates. |
| [Browser agent design](browser-agent-design.md) | Internal design | Browser design notes; not a current user contract. |

## Migration

| Document | Audience | Purpose |
| --- | --- | --- |
| [Migration to 2.0](migration-2.0.md) | User / Operator | Breaking and operational changes in 2.0. |
| [ChatGPT lifecycle v2](migration-chatgpt-lifecycle-v2.md) | Operator | Receipt and lifecycle migration notes. |

## Contributing and releasing

| Document | Audience | Purpose |
| --- | --- | --- |
| [Contributing](../CONTRIBUTING.md) | Contributor | Development, tests, pull requests, and review expectations. |
| [Release process](releasing.md) | Maintainer | Release gates and operator-controlled publication steps. |

## Internal / historical

These documents are useful context but are **not current product contracts**:

- [Roadmap](roadmap.md) — historical delivery record and future ideas.
- [AI-agent roadmap](ai-agent-roadmap.md) — planning material.
- [Implementation log](implementation-log.md) — historical implementation notes.
- [ChatGPT lifecycle plan](chatgpt-lifecycle-plan.md) — internal design plan.

When an internal document conflicts with README, reference, security, or
compatibility documentation, the current user-facing document and executable
tests take precedence.

## Workspace safety

- [Workspace Capsules](workspace-capsules.md)
- [Managed task isolation](task-isolation.md)
- [Durable task runtime and Proof Packs](task-runtime-and-proof-packs.md)
- [ADR-0011: Capsules and worktrees](adr-0011-workspace-capsules-and-isolation.md)
