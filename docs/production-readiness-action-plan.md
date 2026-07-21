# FolderForge production-readiness action plan

**Status:** Approved maintainer plan
**Approved:** 2026-07-20
**Scope:** Planning and sequencing only. This document does not authorize a public release, tag, npm publication, hosted service, or destructive repository action.

This plan converts the independent technical review into executable epics and issues. It prioritizes trustworthy execution, release provenance, product focus, onboarding, and external proof over additional feature breadth.

## Planning rules

1. Freeze net-new product surface for 90 days unless it directly closes an item in this plan.
2. Do not increase the native tool count merely for breadth.
3. HIGH and CRITICAL execution paths require stronger evidence than ordinary feature paths.
4. An issue is complete only when its code, tests, documentation, migration notes, and reproducible evidence are complete.
5. Comparative claims require a published benchmark method and raw results.
6. Hosted marketplace, active-active coordination, and enterprise multi-tenancy remain gated experiments.
7. Public release operations require separate explicit maintainer approval.

## Product boundary

FolderForge should be developed and described as:

> A local-first governance runtime for coding agents: one MCP endpoint, policy-bound execution, exact approvals, recoverable child servers, and reproducible evidence.

Primary users:

- Individual developers using multiple coding agents and MCP servers.
- Small engineering teams that need bounded local automation and reviewable evidence.
- Enterprise design partners only after adoption and operational gates are met.

Explicit non-goals for this phase:

- A general-purpose coding agent.
- A Kubernetes-first enterprise gateway.
- A public application marketplace.
- A generic distributed workflow engine.
- A monolithic Godot MCP server whose success is measured by tool count.

## Dependency graph

```text
FF-P0-01 Audit durability ─────┐
                              ├──> FF-P0-02 Evidence store v2 ──> FF-P1-05 Governance benchmark
FF-P0-03 Release provenance ──┘                                      │
                                                                     ├──> FF-P4-10 Public proof and docs
FF-P1-04 Core boundary ──> FF-P3-08 Dependency cleanup ──────────────┘
          │
          └──> FF-P2-07 Five-minute onboarding

FF-P1-06 Child MCP compatibility ──> FF-P1-05 Governance benchmark
FF-P3-09 Quality gates ─────────────> all implementation epics
```

## Delivery order

| Order | Epic | Priority | Depends on | Exit proof |
| --- | --- | --- | --- | --- |
| 1 | FF-P0-01 Mandatory audit durability | P0 | None | Failure-injection tests prove required mode fails closed |
| 2 | FF-P0-03 Release provenance closure | P0 | None | Exact tag, commit, package, attestation, SBOM, and release chain |
| 3 | FF-P0-02 Tamper-evident evidence store v2 | P0 | FF-P0-01 | Corruption and truncation are detected deterministically |
| 4 | FF-P1-04 Core boundary and package split | P1 | None | Core no longer imports vertical implementations |
| 5 | FF-P1-06 Child MCP compatibility program | P1 | None | Published compatibility matrix and failure corpus |
| 6 | FF-P3-09 Real lint and critical quality gates | P1 | None | Independent lint plus critical-path coverage gates |
| 7 | FF-P2-07 Five-minute safe onboarding | P2 | FF-P1-04 | Fresh install succeeds in no more than three commands |
| 8 | FF-P3-08 Remove cycles and service-locator coupling | P3 | FF-P1-04 | Dependency graph is acyclic across defined layers |
| 9 | FF-P1-05 Reproducible governance benchmark | P1 | P0 evidence work, FF-P1-06 | Raw results reproduce on documented hardware |
| 10 | FF-P4-10 Documentation, demo, and community proof | P4 | Benchmark and onboarding | Public claims map to evidence and maturity labels |

---

## FF-P0-01 — Mandatory audit durability

**Problem:** Audit writes currently may fail without stopping governed execution. This weakens the evidence contract for HIGH and CRITICAL actions.

**Outcome:** Operators can select `required` or `best-effort` audit durability. HIGH/CRITICAL execution and authenticated HTTP default to `required` unless a documented compatibility profile explicitly overrides it.

**Implementation status (2026-07-20):** Implemented and locally verified; pending maintainer review and commit. The proof corpus covers portable unavailable storage, injected `ENOSPC`, partial writes, `fsync`/close failure, restart after an incomplete record, authenticated HTTP, uncertain terminal outcomes, and an eight-process concurrent-writer smoke. CI retains the JSON failure-injection result.

### FF-P0-01 issues

#### FF-P0-01A — Define durability contract

- Add an ADR describing required and best-effort modes.
- Define behavior for startup failure, append failure, flush failure, partial write, disk-full, permission loss, and process crash.
- Define which action classes require durable audit preconditions.

**Acceptance criteria**

- The contract contains a state table for every failure mode.
- Default behavior for HIGH/CRITICAL and authenticated HTTP is unambiguous.
- Compatibility and migration impact are documented.

#### FF-P0-01B — Add audit preflight and required-mode enforcement

- Validate the evidence destination before accepting governed mutations.
- Reject governed execution when required audit durability is unavailable.
- Preserve best-effort mode for explicitly selected local development use.

**Acceptance criteria**

- A required-mode append failure prevents execution.
- The returned error contains a stable code and remediation guidance.
- No secret-bearing arguments are exposed in diagnostics.

#### FF-P0-01C — Add audit failure-injection tests

Cover:

- Read-only destination.
- Disk-full simulation.
- Mid-record truncation.
- Flush or close failure.
- Concurrent writers.
- Restart after an interrupted append.

**Acceptance criteria**

- Tests prove fail-closed behavior for required mode.
- Tests prove explicitly documented degraded behavior for best-effort mode.
- CI preserves failure artifacts for diagnosis.

**Proof gate:** A reviewer can reproduce all failure modes from a documented command without editing source files.

---

## FF-P0-02 — Tamper-evident evidence store v2

**Problem:** Append-only JSONL is easy to inspect but does not prove that records were not removed, reordered, or modified.

**Outcome:** Audit evidence supports deterministic integrity verification while retaining a readable export format.

**Implementation status (2026-07-20):** Implemented and locally verified; pending maintainer review and commit. The v2 store uses versioned hash-chained envelopes, optional Ed25519 signatures, strict cross-process writer locking, offline verification, and explicit legacy migration with `historicalIntegrityClaimed: false`. Approval and task persistence now use strict storage ports and surface corruption instead of skipping records.

### FF-P0-02 issues

#### FF-P0-02A — Introduce evidence storage ports

Define stable interfaces for:

- `AuditStore`
- `ApprovalStore`
- `TaskStore`
- `ArtifactStore`

**Acceptance criteria**

- Core governance logic depends on interfaces rather than filesystem implementations.
- Interfaces specify ordering, durability, idempotency, and corruption semantics.
- Existing filesystem behavior remains available through adapters.

#### FF-P0-02B — Implement chained records

Each record should include:

- Monotonic sequence.
- Previous-record hash.
- Canonical record hash.
- Schema version.
- Optional Ed25519 signature and signer identity.

**Acceptance criteria**

- Modification, deletion, insertion, and reordering are detected.
- Canonicalization is documented and covered by cross-platform fixtures.
- Verification does not require network access.

#### FF-P0-02C — Add migration and verification tooling

- Verify existing v1 JSONL.
- Import v1 into v2 without claiming historical cryptographic integrity.
- Export a readable report and machine-verifiable manifest.

**Acceptance criteria**

- Migration is non-destructive and restart-safe.
- Corrupt lines are surfaced explicitly rather than silently skipped.
- Verification exits non-zero on any integrity failure.

**Proof gate:** A fixture corpus demonstrates detection of every supported tampering class on Linux, macOS, and Windows.

---

## FF-P0-03 — Close public release provenance gap

**Problem:** Repository version, npm dist-tags, hosted releases, and available tags do not currently form a single obvious provenance chain.

**Outcome:** Every future public version maps exactly to one reviewed commit and one immutable evidence bundle; historical gaps remain explicitly classified rather than rewritten.

**Implementation status (2026-07-20):** Implemented and locally verified; pending maintainer review and commit. The public inventory captures 28 npm versions and labels registry/source/tag conflicts. The release workflow requires an annotated exact tag, synchronized lock metadata, one exact tarball for attestation and OIDC publication, registry byte verification, checksums, SBOM, release manifest, and GitHub Release assets. No tag, publish, hosted release, or push action has been executed.

### FF-P0-03 issues

#### FF-P0-03A — Inventory and classify existing releases

- Record public npm versions and dist-tags.
- Record hosted releases and remote tags.
- Record source-only candidate versions.
- Mark unverifiable or incomplete historical states without retroactive rewriting.

**Acceptance criteria**

- A maintainer can answer which commit produced every public package.
- Unknowns are labeled as unknown, not inferred.
- The inventory is committed as release documentation.

#### FF-P0-03B — Enforce exact-tag release workflow

- Release only from an annotated, protected tag targeting the tested commit.
- Require package version and tag agreement.
- Use OIDC trusted publishing.
- Produce SBOM, provenance, checksums, and package-content evidence.

**Acceptance criteria**

- Workflow fails when tag, package version, or commit differ.
- Workflow does not publish from an untagged branch head.
- Release artifacts include immutable hashes and attestations.

#### FF-P0-03C — Add release verification command

Verify:

- Tag to commit.
- Commit to source version.
- Package tarball contents.
- Checksums and attestations.
- Hosted release assets.

**Proof gate:** A clean machine can verify a released version using only public artifacts and documented commands.

---

## FF-P1-04 — Define core boundary and split vertical packages

**Problem:** The composition root and core layer know about many vertical subsystems, increasing coupling and making the product boundary hard to understand.

**Outcome:** A small governance core owns contracts and orchestration; vertical capabilities are optional packages.

**Implementation status (2026-07-20):** Local code goal complete. The composition root and config moved to `src/runtime`, critical consumers use narrow interfaces, the architecture gate reports zero production cycles/violations, and `@folderforge/adapter-godot` builds and packs independently while the root tarball remains compatible. Publishing the adapter and moving the complete Godot tool catalog remain separate release/breaking-change decisions.

### Target packages

- `@folderforge/core`
- `@folderforge/runtime-local`
- `@folderforge/adapter-godot`
- `@folderforge/integration-chatgpt`
- `@folderforge/adapter-browser`
- `@folderforge/plugin-sdk`
- `@folderforge/labs-distributed`
- `@folderforge/labs-marketplace`

### FF-P1-04 issues

#### FF-P1-04A — Architecture decision record

Define permitted dependency directions and public interfaces.

**Acceptance criteria**

- Core cannot import Godot, browser, marketplace, distributed, or ChatGPT implementations.
- Labs packages carry explicit maturity labels.
- Compatibility policy for package extraction is documented.

#### FF-P1-04B — Extract first vertical package

Choose Godot or ChatGPT based on dependency analysis and migration risk.

**Acceptance criteria**

- The root package remains usable without installing the extracted vertical.
- Tool schemas and client behavior remain compatible or have a documented migration.
- Package smoke tests run from packed tarballs.

#### FF-P1-04C — Stabilize extension contracts

- Version adapter and plugin interfaces.
- Define capability discovery.
- Define lifecycle, errors, diagnostics, and shutdown semantics.

**Proof gate:** A sample external adapter can be built without importing private core modules.

---

## FF-P1-05 — Publish a reproducible governance benchmark

**Problem:** FolderForge has internal tests and local measurements but lacks a neutral, repeatable public comparison.

**Outcome:** Performance, safety, reliability, and onboarding claims are backed by raw evidence.

**Implementation status (2026-07-20):** Local benchmark tooling and baseline complete. Five disclosed runs pass the initial targets: `tools/list` at 1,000 tools p95 0.0443 ms, 500-rule evaluation p95 0.0878 ms, and cold stdio initialize plus `tools/list` p95 613.4203 ms on the recorded machine. The frozen agent-evaluation harness, raw evidence hashes, onboarding smoke, security/failure corpora, and limitations are present. Named competitor runs, 24-hour soak, and independent reproduction remain external evidence gates; no comparative performance claim is made.

### Systems under test

- FolderForge.
- ToolHive.
- Docker MCP Gateway.
- MetaMCP.
- ContextForge.

### Required workloads

- Cold startup.
- `tools/list` at 50, 500, and 1,000 tools.
- Policy evaluation with 500 rules.
- 100 concurrent read calls.
- 20 concurrent mutations.
- Child MCP crash and restart.
- Oversized and malformed child output.
- Path traversal and symlink escape attempts.
- Exact-once approval behavior.
- Plugin secret and network escape attempts.
- Audit storage failure.
- Coordinator crash and lease expiry.
- 24-hour soak.
- Fresh installation by a new user.

### Initial targets

- Cold startup p95 below 1.5 seconds on reference hardware.
- `tools/list` with 1,000 tools p95 below 250 ms.
- Policy evaluation with 500 rules p95 below 5 ms.
- Less than 1% errors during the read-concurrency workload.
- No uncertain mutation replay.
- No path bytes leaked outside configured roots.
- No approval bypass.
- No undetected evidence tampering.
- No orphaned child process after bounded shutdown.
- Fresh install in under five minutes and no more than three commands.

### FF-P1-05 issues

#### FF-P1-05A — Freeze benchmark protocol

- Pin versions and configurations.
- Define hardware and OS reporting.
- Run at least five iterations.
- Preserve all failures and outliers.

#### FF-P1-05B — Implement neutral harness

- Produce machine-readable and human-readable results.
- Separate setup time from measured time.
- Capture logs, traces, and environment metadata.

#### FF-P1-05C — Publish raw evidence and limitations

**Proof gate:** An independent reviewer reproduces at least one full benchmark run within the documented tolerance.

---

## FF-P1-06 — Child MCP reliability compatibility program

**Problem:** Child-server orchestration is a potential product wedge, but compatibility and failure behavior are not yet demonstrated across a representative ecosystem.

**Outcome:** FolderForge publishes a maintained compatibility matrix and a reusable fault corpus.

**Implementation status (2026-07-21):** The deterministic corpus passes 5/5 profiles covering baseline initialize/list/call, pagination, child-initiated ping, malformed-frame rejection, and crash-without-replay, alongside the broader 46-test child client suite and heartbeat stress gate. A separate exact-version and npm-integrity-pinned runner now installs five published products with lifecycle scripts disabled, audits the isolated dependency graph, runs bounded stdio discovery plus reviewed safe probes, and retains package, catalog, transport, source-input, and shutdown evidence. A local Linux/Node 22 development run passed all five products; Ubuntu/macOS/Windows Node 22 CI jobs are configured but are not cross-platform evidence until exact-commit artifacts exist. Independent reproduction and named maintenance ownership remain external gates.

### FF-P1-06 issues

#### FF-P1-06A — Define compatibility contract

Cover initialization, capability negotiation, cancellation, pagination, progress, bounded output, heartbeat, crash recovery, shutdown, and no-replay behavior.

#### FF-P1-06B — Test five representative child servers

Select servers that vary by language, transport behavior, tool count, and output profile.

#### FF-P1-06C — Build fault-injection proxy

Inject delayed responses, malformed messages, duplicate IDs, truncated frames, output floods, crashes, and half-open connections.

**Acceptance criteria**

- No automatic replay of uncertain mutations.
- Bounded memory behavior under output flood.
- Stable diagnostics identify the failing child and phase.
- Shutdown leaves no orphan process in the supported environments.

**Proof gate:** Compatibility results and known limitations are published per version.

---

## FF-P2-07 — Five-minute safe onboarding

**Problem:** The current capability surface and configuration model are powerful but difficult to understand during first use.

**Outcome:** A new user can install, connect one client, inspect the effective policy, and safely execute a first governed action in under five minutes.

**Implementation status (2026-07-20):** Local CLI goal complete. Ordinary startup no longer creates configuration; `init` creates explicit `observe`, `develop`, or `trusted-automation` profiles with overwrite protection and backups; `connect` safely handles Cursor, VS Code, Claude Code, and generic stdio. The built-binary smoke completes `init → doctor → connect` in three commands and 2.22 seconds on the recorded machine. The required 5–10 unfamiliar-user sessions and 80% independent completion rate remain external usability gates.

### Proposed flow

```text
folderforge init
folderforge connect <client>
folderforge doctor
```

### Profiles

- `observe`: read-only inspection and diagnostics.
- `develop`: bounded project mutations with exact approvals.
- `trusted-automation`: explicit operator-selected automation profile with stronger setup requirements.

### FF-P2-07 issues

#### FF-P2-07A — Make configuration creation explicit

- Avoid surprising project writes on ordinary startup.
- Explain transport and security implications before writing configuration.
- Show the effective profile and policy source.

#### FF-P2-07B — Add client connection recipes

Provide tested recipes for the supported coding clients and generic stdio MCP clients.

#### FF-P2-07C — Run usability sessions

- Recruit 5–10 users unfamiliar with the repository.
- Record time, commands, errors, and abandoned steps.
- Fix the highest-friction path before public claims.

**Proof gate:** At least 80% of fresh participants complete the defined first task within five minutes without maintainer intervention.

---

## FF-P3-08 — Remove dependency cycles and service-locator coupling

**Problem:** Cyclic imports and late-bound broad container access obscure dependencies and increase regression risk.

**Outcome:** Explicit constructor dependencies and acyclic layer boundaries replace service location in critical paths.

**Implementation status (2026-07-20):** Local architecture goal complete. Shared task presets moved to a dependency-neutral module; `ToolRegistry`, `McpTaskManager`, and workspace routing use narrow contracts; config and composition moved out of `core`; `registry:any` was removed. Automated analysis currently reports zero production runtime cycles and zero forbidden boundaries, including independent-package source isolation, and runs in CI.

### Initial known targets

- Registry, container, and MCP task manager cycle.
- Tools index and workspace tools cycle.
- Late-bound registry field in the composition container.

### FF-P3-08 issues

#### FF-P3-08A — Add dependency-boundary checks

- Define allowed import layers.
- Fail CI on new cycles or forbidden vertical-to-core dependencies.

#### FF-P3-08B — Break current cycles

- Move shared constants and contracts into dependency-neutral modules.
- Replace cross-index imports with direct contract imports.

#### FF-P3-08C — Narrow the composition root

- Replace broad container access with explicit interfaces.
- Keep object construction in one composition layer.

**Proof gate:** Automated dependency analysis reports zero cycles across production modules and blocks regressions.

---

## FF-P3-09 — Real lint and critical-path quality gates

**Problem:** The current lint command duplicates TypeScript type checking, and aggregate coverage can hide weakly tested high-risk modules.

**Outcome:** Static quality checks are independent, fast, and risk-weighted.

**Implementation status (2026-07-20):** Local quality goal complete. `npm run lint` now runs ESLint with zero warnings instead of duplicating TypeScript; architecture checks are independent; coverage includes both aggregate gates and critical-path floors. The current critical set measures 85.01% statements, 76.78% branches, 90.87% functions, and 88.00% lines, with per-file minimums. CI runs the architecture, failure, compatibility, onboarding, package, evidence, and benchmark gates selectively by risk.

### FF-P3-09 issues

#### FF-P3-09A — Introduce a real linter

- Select ESLint or Biome through an ADR.
- Start with correctness and unsafe-pattern rules.
- Ratchet rather than reformat the repository indiscriminately.

#### FF-P3-09B — Add per-module critical coverage gates

Prioritize process, build, database, onboarding, artifact, code, audit, container, approvals, child MCP, and release code.

#### FF-P3-09C — Expand CI matrix selectively

- Keep broad typecheck, unit test, build, and package smoke coverage.
- Add risk-based cross-platform checks for Inspector, stress, and failure injection.
- Pin third-party actions to immutable revisions where practical.

**Proof gate:** A deliberate defect in each critical control is caught by a specific test or static rule rather than only by aggregate coverage.

---

## FF-P4-10 — Documentation, demo, and community proof

**Problem:** The repository contains substantial capability, but the public product story, maturity boundaries, and independently verifiable proof are not yet simple.

**Outcome:** Users can understand what FolderForge is, what is stable, what is experimental, and how to verify its claims.

**Implementation status (2026-07-20):** Local documentation/proof goal complete. The README leads with the local-first governance workflow, the maturity matrix separates hardened beta paths from experimental/labs subsystems, ADRs and release inventory define boundaries, and every local security/reliability/performance claim maps to a command, test, benchmark, or evidence artifact. Community participation, independent reproductions, external beta cohorts, and hosted public proof remain external program gates.

### FF-P4-10 issues

#### FF-P4-10A — Rewrite product narrative

Lead with the local-first governance workflow rather than tool count.

#### FF-P4-10B — Publish maturity matrix

Label each subsystem as stable, beta, experimental, labs, or internal.

#### FF-P4-10C — Create one end-to-end evidence demo

Show:

1. Connect a coding client.
2. Inspect effective policy.
3. Attempt a disallowed action.
4. Approve an exact mutation.
5. Crash and recover a child MCP server.
6. Verify the resulting evidence chain.

#### FF-P4-10D — Establish community feedback loop

- Beta entry criteria.
- Reproducible bug reports.
- Compatibility submissions.
- Published graduation criteria.

**Proof gate:** Every security, reliability, or performance statement in public docs links to a test, benchmark, or versioned evidence artifact.

---

## 30/60/90-day execution plan

### Days 0–30

- Freeze feature expansion unrelated to this plan.
- Complete the release inventory and exact-tag release design.
- Define and implement required audit durability.
- Approve the core-boundary ADR.
- Publish positioning and maturity language.
- Freeze the benchmark protocol.
- Introduce a real lint ratchet.

### Days 31–60

- Complete audit failure-injection coverage.
- Implement evidence-store interfaces and v2 record format.
- Test five child MCP servers and publish preliminary compatibility notes.
- Build the three-command onboarding flow.
- Run the first 5–10 onboarding sessions.
- Add per-module critical coverage gates.
- Break the first dependency cycles.

### Days 61–90

- Publish benchmark methodology and FolderForge baseline results.
- Run at least two competing systems under the same protocol.
- Extract the first vertical package.
- Exercise the exact-tag OIDC release workflow without publishing, then request release approval separately.
- Recruit 10–20 external beta participants.
- Publish known limitations and a versioned maturity matrix.

## Six-to-twelve-month investment gates

Advance distributed coordination or hosted marketplace work only when at least one adoption threshold is met:

- 50 weekly active developers, or
- 5 active engineering teams, or
- 3 credible paid design partners or letters of intent.

Advance active-active or multi-coordinator work only when all of the following are true:

- A measured workload demonstrates the single-coordinator bottleneck.
- At least three engineers can own the subsystem.
- On-call and SRE responsibilities are explicitly staffed.
- Network partition, clock skew, and recovery semantics have a written test plan.

## Issue template for implementation work

Every implementation issue created from this plan should contain:

```text
Problem
User impact
Security and compatibility impact
In scope
Out of scope
Design constraints
Acceptance criteria
Failure-injection or adversarial cases
Documentation and migration requirements
Verification commands
Evidence artifacts
Dependencies
Rollback plan
```

## Definition of done

An epic is not complete until:

- Its accepted design is recorded.
- Production code and migrations are implemented.
- Unit, integration, adversarial, and cross-platform tests required by risk are passing.
- User and operator documentation is updated.
- Release and compatibility implications are documented.
- Evidence can be reproduced from a clean checkout.
- Known limitations remain explicit.
- No public release or publication step has occurred without separate approval.
