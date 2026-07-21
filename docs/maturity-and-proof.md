# Product maturity and proof matrix

FolderForge is a local-first governance runtime for coding agents. Capability
maturity is reported separately so experimental breadth is not confused with a
production guarantee.

| Area | Maturity | Current reproducible proof | External gate still required |
| --- | --- | --- | --- |
| Local stdio governance | Beta / hardened local path | Cross-platform tests, MCP Inspector, packed-package and onboarding smoke | Independent user reproduction |
| Policy, approvals, path and command boundary | Beta / hardened local path | Critical coverage gate, exact-approval tests, escape and self-approval tests | Design-partner incident exercises |
| Workspace Capsules and Git worktree isolation | Beta / locally verified | Exact binding/expiry/revocation/scope/budget/integrity tests; dirty/drift/symlink/apply/rollback/discard/restart worktree tests; dashboard and registry integration | External client UX, non-Git checkpoint fallback, and sandboxed command execution |
| Durable workflow task runtime and Proof Packs | Beta / locally verified | Owner/project/client boundary, reconnect, pause concurrency, targeted one-time handoff, state tamper/revision/lock tests, secret redaction, manifest/file tamper tests | Natural-language planning/context compiler, external reproduction, and production observation |
| Mission Control and persistent write freeze | Beta / locally verified | Restart restoration, prior-mode preservation, state digest tamper rejection, exact containment allowlist, active-call value-redaction, dashboard mutation-block/stop-process integration | Remote multi-tenant operator console, distributed active-call aggregation, and independent incident exercise |
| Audit durability and evidence v2 | Beta / hardened local path | Failure injection, hash-chain tamper corpus, migration smoke, 8-process writer test | External witness/key operations for stronger non-repudiation |
| Child MCP runtime | Beta | 46 child-client tests, stress suite, five deterministic protocol profiles, and a five-product exact-version/integrity-pinned runner with local Linux evidence | Passing exact-commit artifacts on all required operating systems plus independent reproduction and maintenance ownership |
| Runtime soak evidence | Harness complete; long-duration proof pending | Governed/audited samples, planned child restart, SIGTERM resume, SHA-256 JSONL verification, reset fail-closed, CI smoke, and 90,001-record volume test | A retained passing 24-hour active-duration chain for the exact revision plus independent review |
| Godot adapter package | Extraction candidate | Independent build/pack/install/import smoke | Separate publication/versioning decision |
| Browser and UI quality | Experimental integration | Local/integration tests and explicit browser setup | Broader OS/browser beta evidence |
| Distributed workers | Labs | Local reference tests, signed evidence and lease/fencing fixtures | Real multi-host operation, SRE ownership, HA design |
| Marketplace | Labs | Local signature/quarantine/moderation tests | Publisher proofing, hosting, legal/takedown and security response |
| Comparative benchmark | Protocol ready; no comparative claim | Frozen agent protocol and local governance microbenchmark | Same-version competitor runs and independent reproduction |

## Reproducible local gates

```bash
npm run verify
npm run test:coverage
npm run smoke:evidence
npm run test:audit-concurrency
npm run compatibility:child-mcp
npm run compatibility:child-mcp:third-party  # network-backed exact pins
npm run smoke:runtime-soak
npm run smoke:onboarding
npm run smoke:adapter-godot
npm run smoke:package
npm run benchmark:governance
```

## Claims FolderForge must not make yet

- Production-grade active-active or multi-tenant platform.
- Certified compatibility with arbitrary third-party MCP servers.
- Public marketplace safety or publisher identity assurance.
- Better performance, security, or developer experience than named competitors
  without equivalent raw benchmark evidence.
- Historical cryptographic integrity for legacy audit logs.
- Published availability of `@folderforge/adapter-godot` until a separate release
  is explicitly approved and completed.

- Complete autonomous command verification inside Propose/Autopilot worktree capsules; command tools remain fail-closed until the process sandbox is connected.

- Full natural-language autonomous task planning and context compilation; the durable runtime currently executes explicit bounded workflow definitions.

## External evidence backlog

The remaining roadmap gates require elapsed time or independent participants and
cannot be completed by changing repository code:

1. at least one independent clean-machine reproduction of the benchmark;
2. passing exact-commit third-party compatibility artifacts on Ubuntu, macOS, and Windows, followed by an independent clean-machine reproduction and named retest owner;
3. a 24-hour soak with all failures and outliers retained;
4. 10–20 external beta participants or equivalent design-partner evidence;
5. adoption thresholds before hosted marketplace or active-active investment.

These are recorded as external gates, not silently marked complete or replaced by
unit-test counts.
