# ADR-0005: gates for distributed workers and a plugin marketplace

- Status: Accepted as sequencing policy; runtime implementation deferred
- Date: 2026-07-19

## Context

Distributed execution and a remote plugin marketplace multiply the consequences
of identity mistakes, stale leases, replay, dependency compromise, and weak
sandboxing. Implementing either before the local trust boundary is measurable
would turn unresolved local risks into remote, multi-tenant risks.

## Decision

FolderForge will not implement production distributed workers or marketplace
installation until all prerequisites below are met with evidence for an exact
release commit.

### Worker prerequisites

- the six-job OS/Node CI matrix is green;
- workflow checkpoints use cryptographic run identities and signed evidence;
- every side-effecting operation has an idempotency or explicit no-replay
  contract;
- a durable artifact/blob store supports remote integrity verification;
- worker authentication uses short-lived workload identity, not shared static
  tokens;
- leases, fencing tokens, heartbeats, cancellation, retry, and coordinator
  recovery have deterministic tests;
- shared rate limits and quotas are enforced outside one process;
- sandbox policy is enforced on the worker host and reported in attested evidence;
- threat modeling covers malicious workers, malicious coordinators, confused
  deputies, network partitions, clock skew, and duplicate delivery.

### Marketplace prerequisites

- packages have a signed publisher identity and revocation path;
- source-to-artifact provenance and SBOMs are available;
- immutable versions and digest-pinned dependencies are required;
- automated malware, secret, lifecycle-script, symlink, archive-bomb, and manifest
  scans run before listing;
- permissions are enforced by the sandbox rather than displayed only as metadata;
- compatibility tests run against supported FolderForge and MCP versions;
- moderation, reporting, takedown, dispute, and security-advisory processes exist;
- beta plugin authors have exercised installation, update rollback, migration,
  and sandbox diagnostics.

## Proposed worker architecture after the gate

A coordinator may persist immutable workflow definitions and issue one leased step
at a time. Workers acquire a short-lived lease with a monotonically increasing
fencing token. Results include tool identity, canonical argument hash, input and
output artifact hashes, sandbox evidence, and an idempotency key. The coordinator
accepts only the newest valid fencing token and never retries an operation whose
side-effect status is unknown unless that operation declares an enforceable
idempotency contract.

Transport and storage choices remain open. A design must first prove correctness
with a single remote worker, then partitions and duplicate delivery, before any
parallel scheduler or autoscaling work.

## Proposed marketplace architecture after the gate

The marketplace should be an index of immutable signed manifests and artifact
digests, not a package execution service. Clients fetch metadata, verify publisher
and provenance, download to quarantine, independently verify the digest and
policy, then install disabled. Enablement remains a separate governed action.
Marketplace reputation cannot replace signature, sandbox, and local policy.

## Consequences

This sequencing deliberately delays attractive distributed and marketplace
features. In return, claims about remote execution and third-party plugins remain
honest, testable, and reversible. Local sandbox, artifact, provenance, benchmark,
and beta work are therefore release gates, not optional polish.
