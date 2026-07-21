# ADR-0010: Resumable tamper-evident runtime soak evidence

- **Status:** Accepted
- **Date:** 2026-07-21
- **Related pillars:** runtime reliability, child MCP lifecycle, audit durability,
  and evidence integrity

## Context

A long-running reliability claim cannot be supported by a final summary alone.
Multi-hour runs may be interrupted, large samples can hide failures in aggregates,
and mutable JSON output cannot prove that records were not edited, removed, or
reordered after the run.

FolderForge already has governed execution, a durable audit chain, child-process
lifecycle controls, and short stress tests. It lacked one harness that continuously
exercised those paths, retained every failure and outlier, resumed after operator or
infrastructure interruption, and produced evidence suitable for later verification.

## Decision

1. Runtime soak evidence is an append-only canonical JSONL SHA-256 chain. Every
   record includes a stable run ID, monotonic sequence, previous hash, payload, and
   record hash.
2. Every append uses complete-write handling followed by `fsync`; evidence and
   derived summaries use private file permissions where supported.
3. One sample executes a governed and durably audited `file_read`, a child MCP
   `tools/list`, and an exact-response child tool call. Latency, event-loop delay,
   memory, transport counters, and content hashes are retained per sample.
4. Planned child restarts are first-class fault records, not silently excluded from
   timing or failure accounting.
5. SIGINT/SIGTERM close the child and append a segment boundary. `--resume` first
   verifies the complete chain and exact configuration, then continues active test
   duration in a new segment.
6. Unexpected failures and threshold outliers remain full raw records. Summary
   percentiles are derived data and never replace the evidence chain.
7. A run receives `run_complete` only after the planned active duration is reached
   and the independent FolderForge governance audit chain verifies successfully.
8. Recursive reset is allowed only for directories carrying a valid FolderForge
   soak ownership marker.

## Safety and reliability properties

- An interrupted run exits non-zero and cannot be mistaken for completion.
- A modified, missing, reordered, malformed, or partially written record fails
  verification before resume.
- Resume rejects configuration drift and completed runs.
- The runner does not inherit arbitrary child environment variables.
- Planned faults and unexpected failures use separate classifications.
- Large full-day record counts are processed iteratively rather than expanded as
  function arguments.
- Reset fails closed for unmarked files and directories.

## Trade-offs

`fsync` per sample intentionally adds latency and I/O overhead. The harness measures
an evidence-preserving production-control path rather than maximum possible tool
throughput. High-throughput microbenchmarks remain separate.

The bundled child fixture provides deterministic lifecycle evidence. It does not
substitute for a 24-hour run against every third-party server or production
workload. Third-party compatibility and runtime soak evidence remain complementary.

Paused wall-clock time is excluded from active soak duration. This permits safe
resume but means a 24-hour active run can span more than 24 hours of wall time.

## Verification

```bash
npx vitest run \
  tests/unit/runtime-soak-lib.test.ts \
  tests/integration/runtime-soak.test.ts
npm run smoke:runtime-soak
npm run lint
npm run docs:check
```

The automated corpus covers completion, planned restart, SIGTERM interruption and
resume, chain tampering, incomplete records, reset refusal, Unicode/space paths,
and a bounded large-chain unit test. A dedicated
`npm run test:runtime-soak-volume` gate constructs and verifies the 90,001-record
full-day volume model outside the latency-sensitive unit suite.

## Claim boundary

This ADR establishes the harness and evidence contract. It does not establish that a
24-hour run has passed. That claim requires a retained chain with at least
86,400,000 ms of active duration, `run_complete`, a passing verdict, verified audit
metadata, and raw failure/outlier records for the exact claimed revision.
