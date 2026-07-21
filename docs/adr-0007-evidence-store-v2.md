# ADR-0007: Tamper-evident evidence store v2

- **Status:** Accepted
- **Date:** 2026-07-20
- **Decision owners:** FolderForge maintainers
- **Related plan:** FF-P0-02 Tamper-evident evidence store v2

## Context

Audit durability prevents required execution from starting without a persisted
record, but an ordinary append-only JSONL file cannot reveal whether a later
operator removed, inserted, reordered, or modified records. Approval and task
stores also previously tolerated malformed records or best-effort persistence,
which could leave in-memory governance state ahead of durable state.

## Decision

FolderForge persists new audit evidence to:

```text
.folderforge/audit/audit.v2.jsonl
```

Each line is a versioned envelope containing:

- `schemaVersion: 2`
- a positive monotonic `sequence`
- `previousHash`
- the original `event`
- a provenance `source`
- a SHA-256 `recordHash`
- an optional Ed25519 signature with `keyId`

The record hash is computed over canonical sorted JSON for the schema version,
sequence, previous hash, event, and source. The signature, when configured, is
over the complete record-hash string. Verification is offline and requires no
network access.

Required writers acquire a project-local cross-process lock, verify the current
chain, append the complete envelope, call `fsync`, and release the lock. A stale
lock is reclaimed only after the stale interval and only when its recorded PID is
not alive. Startup and `folderforge doctor` fail required evidence checks when the
chain is malformed.

The governance layer depends on storage ports:

- `AuditStore`
- `SnapshotStore<T>` for approvals
- `RecordStore<T>` for durable tasks
- `ArtifactStorePort<T>`

Filesystem adapters remain the default local implementation. Approval transitions
are rolled back in memory when persistence fails. Corrupt approval or task records
are surfaced explicitly instead of skipped.

## Legacy migration

The v1 file remains at:

```text
.folderforge/audit/audit.jsonl
```

FolderForge never upgrades it automatically. Migration is explicit:

```bash
npm run evidence:migrate -- \
  --input .folderforge/audit/audit.jsonl \
  --output .folderforge/audit/audit.v2.jsonl
```

The command verifies every legacy line, refuses an existing destination, writes
atomically, and self-verifies the new chain. Each imported envelope records the
legacy file SHA-256, original line number, and migration time. The result always
states `historicalIntegrityClaimed: false`: the new chain proves the migration
output from that point onward, not that the old file was never changed earlier.

## Offline verification

```bash
npm run evidence:verify -- \
  --path .folderforge/audit/audit.v2.jsonl \
  --json
```

Signed records can be checked with one or more:

```text
--public-key key-id=/path/to/public-key.pem
```

Unknown signing keys are reported as unverified signatures but do not invalidate
an otherwise valid hash chain. A wrong known key or invalid signature fails
verification.

## Failure contract

| Failure | Result |
| --- | --- |
| Modified event or source | `invalid_record_hash` |
| Deleted or reordered record | `invalid_sequence` and/or `invalid_previous_hash` |
| Inserted record | sequence or previous-hash failure |
| Partial trailing line | `invalid_json` |
| Wrong known Ed25519 key | `invalid_signature` |
| Unknown signing key | valid chain with `unverifiedSignatures > 0` |
| Corrupt legacy line | migration refuses input; no lines skipped |
| Approval persistence failure | transition rolls back and error propagates |
| Task record corruption | startup/load fails explicitly |

## Consequences

### Positive

- Modification, deletion, insertion, and reordering become detectable.
- Verification is deterministic, readable, and offline.
- Legacy evidence is migrated without overstating historical trust.
- Governance state no longer silently advances when persistence fails.
- Core logic can be tested against storage interfaces instead of concrete files.

### Trade-offs and limits

- This is a single-project local hash chain, not a transparency log or external
  timestamping service.
- An attacker who can replace the complete unsigned file can create a new valid
  chain. Optional signatures, protected keys, release evidence, backups, or an
  external witness are needed to strengthen that threat model.
- Locking is filesystem-based. Eventually consistent network filesystems are not
  supported for concurrent writers.
- Verification is linear in the number of records.

## Verification

The proof corpus includes:

```bash
npx vitest run tests/unit/evidence-store.test.ts \
  tests/unit/audit-durability.test.ts
npm run build
npm run test:audit-concurrency
```

It covers modification, deletion, insertion, reordering, partial writes, restart,
Ed25519 success/failure, strict migration, persistence rollback, and eight real
Node processes writing 200 unique chained records. The normal CI matrix runs the
suite on Linux, macOS, and Windows; the dedicated evidence job preserves a JSON
result artifact.
