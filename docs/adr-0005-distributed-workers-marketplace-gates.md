# ADR-0005: distributed workers and verified marketplace gates

- Status: Accepted; local reference implementation completed for 2.5.0
- Date: 2026-07-19
- Updated: 2026-07-19

## Context

Distributed execution and third-party distribution multiply the consequences of
identity mistakes, stale leases, replay, dependency compromise, and weak
sandboxing. The original decision deferred runtime implementation until local
sandbox, artifact, provenance, benchmark, and beta evidence boundaries were
explicit and testable.

## Decision

FolderForge now includes a **single-coordinator remote-worker reference runtime**
and a **local verified marketplace/index runtime**. The implementation preserves
the original sequencing constraints:

- remote worker identity is short-lived and asymmetric;
- side-effect uncertainty is represented as `blocked`, not hidden by retry;
- worker evidence and coordinator acceptance are signed;
- package versions are immutable and publisher-signed;
- package bytes are quarantined and independently rescanned before disabled
  installation;
- public hosting, public enrollment, publisher verification, moderation staffing,
  and comparative claims remain operator-controlled external actions.

Completing the local runtime does not automatically satisfy public-service or
multi-tenant readiness.

## Worker implementation

The coordinator uses:

- encrypted durable payloads;
- Ed25519 coordinator and worker identities;
- short-lived rotatable/revocable worker bearer tokens;
- capability matching;
- leases, acknowledgements, heartbeats, monotonic fencing tokens, and bounded
  recovery;
- explicit `idempotent` or `no-replay` contracts;
- lease-bound artifact transfer;
- worker result signatures plus coordinator countersignatures;
- mandatory worker-side tool allowlists and the normal FolderForge policy,
  approval, rate-limit, and audit pipeline;
- TLS-required non-loopback HTTP transport.

See [`distributed-workers.md`](./distributed-workers.md).

## Marketplace implementation

The local marketplace uses:

- Ed25519 publisher identities and revocation;
- immutable signed `id@version` metadata;
- exact package, manifest, SBOM, provenance, and source digests;
- bounded HTTPS/local index sync;
- lifecycle-script, secret, symlink, nested-archive, path, file-count, expanded-
  byte, manifest, SBOM, provenance, and compatibility scans;
- safe quarantine extraction;
- local `listed`, `yanked`, and `security-hold` moderation overlays;
- disabled-only installation followed by separate governed enablement.

See [`marketplace.md`](./marketplace.md).

## Remaining gates for a public hosted service

Before claiming a production multi-tenant worker fleet or public marketplace,
operators still need evidence outside this repository:

### Worker fleet

- exact six-job CI evidence for the release commit;
- external workload identity/TLS certificate lifecycle;
- shared transactional storage and rate limits for multiple coordinators;
- leader/fencing behavior at the storage layer;
- worker-host sandbox/VM attestation and patch management;
- network-partition, clock-skew, duplicate-delivery, malicious-worker, and
  malicious-coordinator exercises in the target deployment;
- operational monitoring, backup/restore, incident response, and capacity tests.

### Public marketplace

- real publisher identity verification and key-recovery policy;
- hosted package/index availability and backup;
- independent malware analysis and vulnerability response;
- moderation, reporting, takedown, dispute, appeal, and security-advisory staffing;
- legal/licensing review appropriate to the operator;
- external plugin authors exercising migration, rollback, revocation, and sandbox
  diagnostics;
- public beta graduation evidence from the frozen intake process.

## Consequences

FolderForge can now test remote execution and verified distribution end-to-end
without pretending that repository code creates a trustworthy public service by
itself. The local runtime is reversible and auditable. Public claims remain gated
by exact CI, benchmark, beta, identity, moderation, and operations evidence.
