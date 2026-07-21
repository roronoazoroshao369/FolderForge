# ADR-0006: Required audit durability for governed execution

- **Status:** Accepted
- **Date:** 2026-07-20
- **Decision owners:** FolderForge maintainers
- **Related plan:** FF-P0-01 Mandatory audit durability

## Context

FolderForge records tool calls, policy decisions, approvals, rate-limit events,
and outcomes in an append-only JSONL audit log. Historically, audit append
failures were logged as warnings and execution continued. That behavior preserved
local availability but allowed a HIGH- or CRITICAL-risk action to run without
its required evidence record.

The system needs two explicit operating contracts:

1. A strict contract for operations where missing evidence is unacceptable.
2. A compatibility contract for low-risk local development where audit storage
   failure should not make read-only inspection unusable.

## Decision

FolderForge adds the following configuration:

```yaml
audit:
  durability: best-effort # required | best-effort
  requireForHighRisk: true
  requireForAuthenticatedHttp: true
```

Environment equivalents are:

- `FOLDERFORGE_AUDIT_DURABILITY`
- `FOLDERFORGE_AUDIT_REQUIRE_HIGH_RISK`
- `FOLDERFORGE_AUDIT_REQUIRE_AUTHENTICATED_HTTP`

An audit event is written in required mode when any of these conditions is true:

- `audit.durability` is `required`.
- The operation is HIGH or CRITICAL and `requireForHighRisk` is enabled.
- The caller is authenticated through static-token or OAuth HTTP and
  `requireForAuthenticatedHttp` is enabled.

Required writes create the audit directory with private permissions, acquire the
project-local writer lock, verify the existing v2 hash chain, open
`audit.v2.jsonl`, loop until the complete envelope is written, flush it with
`fsync`, and close the descriptor before execution proceeds. POSIX audit files
are maintained at mode `0600`. Startup preflight verifies existing sequence,
previous-hash, record-hash, and JSONL completeness, so a crash-interrupted or
modified chain is not silently followed by new required evidence.

Best-effort writes retain the prior availability behavior: a write failure is
logged, the event remains in the bounded in-memory buffer, and execution may
continue.

## Failure contract

| Failure point | Required mode result | Handler status | Retry guidance |
| --- | --- | --- | --- |
| Startup preflight with baseline `required` | Startup fails with `AUDIT_UNAVAILABLE` | Not started | Repair storage, then restart |
| Startup finds malformed or incomplete JSONL | Required startup/call fails with `AUDIT_UNAVAILABLE` | Not started | Preserve and repair or migrate the evidence file |
| Initial call-event write | Tool returns `AUDIT_UNAVAILABLE` | Not started | Repair storage; a later call is safe |
| Policy, approval, or rate-limit event write | Tool returns `AUDIT_UNAVAILABLE` | Not started | Repair storage; a later call is safe |
| Terminal result/error write after handler starts | Tool returns `AUDIT_OUTCOME_UNCERTAIN` | Completed or may be partial | Do not retry automatically |
| Any best-effort write | Warning and in-memory event | Unchanged | Operator decides whether degraded evidence is acceptable |

Errors returned to clients contain stable codes and remediation guidance. They
do not include raw tool arguments or filesystem error details. Detailed local
logging contains the audit path and operating-system error, after normal logger
redaction.

## Consequences

### Positive

- HIGH/CRITICAL execution cannot begin without a durable call record by default.
- Authenticated HTTP callers receive the same evidence guarantee even for
  lower-risk tools.
- Callers can distinguish a definitely-not-started operation from an uncertain
  post-execution outcome.
- Low-risk local stdio inspection remains available under the default
  best-effort baseline.

### Trade-offs

- Required mode performs synchronous open, write, flush, and close operations,
  adding storage latency to each required audit event.
- Network filesystems and unusual storage drivers may provide weaker durability
  semantics than a local filesystem despite a successful `fsync`.
- Durability and integrity are separate contracts. The implemented v2 hash chain,
  optional signatures, migration, and their limits are defined in
  [ADR-0007](adr-0007-evidence-store-v2.md).

## Verification

`tests/unit/audit-durability.test.ts` injects storage failures without unsafe
host changes or platform-specific permission assumptions. It verifies:

- Required startup preflight failure and best-effort degradation.
- HIGH-risk and authenticated-HTTP pre-execution blocking.
- Simulated `ENOSPC`, partial writes, `fsync` failure, and close failure.
- Restart rejection of an incomplete trailing JSONL record.
- Secret-free client errors and uncertain-outcome signaling after execution.
- Complete records from independent writers sharing one audit path.

Reproduce the local proof corpus with:

```bash
npx vitest run tests/unit/audit-durability.test.ts
npm run build
npm run test:audit-concurrency
```

The concurrency command starts eight real Node processes that append 25 required
records each and verifies all 200 records are complete and unique. CI runs the
fault corpus with a JSON reporter, retains its result artifact, and runs the
multi-process smoke on Node 22 across the supported operating-system matrix.
