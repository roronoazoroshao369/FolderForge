# AI Agent Roadmap

> **Status:** Internal planning document. This file is not the current product, release, or compatibility contract. See [the documentation index](README.md).


FolderForge's product goal is to let an AI agent safely complete a software task
through one MCP connection: understand the project, edit code, run it, inspect the
result, review quality, and produce an auditable outcome.

## Delivery principles

- Build capability primitives before autonomous orchestration.
- Keep one policy and audit pipeline for native and plugin tools.
- Prefer stable curated wrappers for common agent workflows.
- Preserve structured MCP content instead of reducing results to prose.
- Test every milestone through the public MCP transport, not only internal units.
- Keep capped clients usable through presets and facades.

## Milestone 1.7 — Browser intelligence foundation

Status: implemented, committed, and pushed on `main`; release pending.

- [x] Promote child MCP image blocks to top-level MCP content.
- [x] Avoid duplicate screenshot base64 in compatibility text.
- [x] Propagate child `isError` into parent MCP error and audit semantics.
- [x] Add `browser_set_viewport` for responsive UI testing.
- [x] Expose complete screenshot inputs.
- [x] Keep all browser wrappers inside the 50-tool `vibe-lite` surface.
- [x] Pin browser group under cap pressure.
- [x] Use isolated Playwright sessions by default.
- [x] Add unit, regression, build, and live HTTP MCP verification.
- [x] Document architecture and implementation issues.

Deferred browser enhancements:

- screenshot artifact/resource store;
- visual regression and pixel diff;
- accessibility/contrast scanner;
- device/network emulation presets;
- composed, auditable UI test flows.

## Milestone 1.8 — AI coding runtime

Status: implemented, live-tested, committed, and pushed on `main`; release pending.

- [x] `project_analyze` for framework, command, entrypoint, architecture, and Git evidence.
- [x] `code_context` with bounded BM25 ranking, redacted snippets, and related tests.
- [x] `patch_transaction` preview/apply/status/rollback with conflict detection and diff resources.
- [x] `project_verify` with dry-run plans and structured command/error evidence.
- [x] `change_summary` with Git file categories, numstat, and suggested checks.
- [x] Typed output schemas for all five agent tools.
- [x] Failure data preserved through MCP `isError:true`.
- [x] Agent/browser groups pinned inside the 50-tool `vibe-lite` surface.
- [x] Unit, integration, policy, serializer, preset, and live HTTP MCP verification.

See [`ai-coding-runtime.md`](./ai-coding-runtime.md).

## Milestone 1.9 — Installable plugin ecosystem

Status: implemented, live-tested, committed, and pushed on `main`; release pending.

- [x] Local `folderforge.plugin.json` manifest with identity, semantic version, compatibility, runtime, permissions, and per-tool risk.
- [x] Bounded, symlink-free local install/update with atomic registry writes.
- [x] Hot install/enable/disable/update/uninstall and health checks.
- [x] Dynamic child-adapter registry and two-tool facade integration.
- [x] Per-plugin runtime risk maps feeding the existing policy/audit pipeline.
- [x] Minimal environment plus explicit env allowlist; no automatic parent-secret inheritance.
- [x] Enabled-plugin restart persistence and full-preset advertisement.
- [x] Unit, integration, source-built HTTP MCP, restart, and package-distribution verification.

Remote registries, signatures, publisher provenance, and OS-level network/filesystem sandbox enforcement remain deferred trust-layer work. See [`plugin-system.md`](./plugin-system.md).

## Milestone 2.0 — Governed agent workflows

Status: implemented, live-tested, committed, and pushed on `main`; release pending.

- [x] Persistent workflow definitions, checkpoints, and reproducible reports.
- [x] Explicit planner/coder/tester/reviewer role scopes with allowed-tool validation.
- [x] Dependency DAG validation, step references, expectations, stop/continue behavior, and cancellation.
- [x] Every child step re-enters normal policy, approval, rate-limit, rich-result, and audit handling.
- [x] One-shot approvals are matched by exact tool/args, consumed once, and support pause/resume.
- [x] Successful steps are never replayed on resume or restart.
- [x] Bounded/redacted evidence; image bytes are not persisted.
- [x] Seven typed workflow lifecycle tools included in the 50-tool `vibe-lite` surface.
- [x] Unit, integration, safe-policy, source-built HTTP MCP, approval, and restart verification.

See [`workflows.md`](./workflows.md). FolderForge now supplies the deterministic execution/control plane; AI clients remain responsible for planning and judgment.

## Quality gates for every milestone

1. architecture decision recorded;
2. input/output schemas reviewed;
3. risk and mutation classifications reviewed;
4. unit and integration coverage;
5. public MCP live test;
6. client-cap regression test;
7. documentation and issue log updated;
8. clean git diff with no temporary processes or fixtures;
9. no tag, publish, hosted release, or stable release without explicit user approval.
