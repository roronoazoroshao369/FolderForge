# Product maturity and proof matrix

FolderForge is a local-first governance runtime for coding agents. Capability
maturity is reported separately so experimental breadth is not confused with a
production guarantee.

| Area | Maturity | Current reproducible proof | External gate still required |
| --- | --- | --- | --- |
| Local stdio governance | Beta / hardened local path | Cross-platform tests, MCP Inspector, packed-package and onboarding smoke | Independent user reproduction |
| Policy, approvals, path and command boundary | Beta / hardened local path | Critical coverage gate, exact-approval tests, escape and self-approval tests | Design-partner incident exercises |
| Audit durability and evidence v2 | Beta / hardened local path | Failure injection, hash-chain tamper corpus, migration smoke, 8-process writer test | External witness/key operations for stronger non-repudiation |
| Child MCP runtime | Beta | 46 unit tests, stress suite, five deterministic protocol profiles | Pinned third-party server compatibility runs |
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

## External evidence backlog

The remaining roadmap gates require elapsed time or independent participants and
cannot be completed by changing repository code:

1. at least one independent clean-machine reproduction of the benchmark;
2. pinned compatibility runs against five representative third-party servers;
3. a 24-hour soak with all failures and outliers retained;
4. 10–20 external beta participants or equivalent design-partner evidence;
5. adoption thresholds before hosted marketplace or active-active investment.

These are recorded as external gates, not silently marked complete or replaced by
unit-test counts.
