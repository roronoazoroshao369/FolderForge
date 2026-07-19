# Distributed workers

FolderForge 2.5 adds a durable remote-worker control plane for executing an
explicitly allowlisted subset of governed tools on another machine. It is not a
transparent RPC shell: identity, leases, replay policy, artifacts, result
signatures, and local policy are all enforced separately.

## Security model

The coordinator stores state under `.folderforge/distributed/`:

- job arguments are encrypted at rest with AES-256-GCM;
- the coordinator owns an Ed25519 signing key and a separate payload key;
- secret/key/state files use mode `0600` and the directory uses `0700` where the
  platform supports POSIX permissions;
- worker identities are Ed25519 public keys;
- bearer tokens are short-lived, signed, rotatable, and revocable;
- every lease receives a monotonically increasing fencing token;
- acknowledged `no-replay` work becomes `blocked` after an uncertain lease loss;
- only explicitly `idempotent` work may be requeued automatically;
- worker result evidence is signed by the worker and countersigned by the
  coordinator;
- input and output artifact identities are verified by the coordinator store.

Worker bearer tokens and private keys never appear in the agent-facing MCP tool
catalog. Registration, lease, heartbeat, completion, recovery, and revocation
operations are admin-only.

## Start a coordinator

Loopback HTTP is allowed for local testing:

```bash
folderforge distributed serve \
  --project /path/to/project \
  --host 127.0.0.1 \
  --port 7441
```

A non-loopback bind fails closed unless both TLS files are supplied:

```bash
folderforge distributed serve \
  --project /path/to/project \
  --host 0.0.0.0 \
  --port 7441 \
  --tls-cert /secure/coordinator.crt \
  --tls-key /secure/coordinator.key
```

The worker API includes lease, acknowledge, heartbeat, completion/failure, and
lease-bound artifact transfer. Request bodies and responses are bounded. It does
not accept arbitrary shell commands.

## Create and register a worker identity

On the worker machine:

```bash
folderforge worker init --output /secure/folderforge-worker
```

This creates:

- `worker-private.pem` — keep only on the worker;
- `worker-public.pem` — register with the coordinator admin plane;
- `worker.json` — public-key fingerprint metadata;
- a local `.gitignore` that prevents accidental identity-file commits.

Register the public key with `distributed_worker_register`. Store the returned
short-lived token in a mode-`0600` file. Rotate it with
`distributed_worker_rotate`; revoke the identity with
`distributed_worker_revoke`.

## Run the worker

The tool allowlist is mandatory:

```bash
folderforge worker run \
  --coordinator https://coordinator.example.com:7441 \
  --token-file /secure/worker.token \
  --private-key /secure/folderforge-worker/worker-private.pem \
  --allow-tools file_read,run_test,project_verify \
  --project /srv/worker-project
```

Use `--once` for one poll, or leave it out for a bounded polling loop. HTTP is
accepted only for loopback coordinator URLs.

The worker:

1. leases one capability-compatible job;
2. acknowledges before execution;
3. renews the exact lease/fencing token while work runs;
4. downloads only artifacts declared as inputs of that job;
5. replaces `{ "$artifact": "art_...", "filename": "input.txt" }` references
   with bounded local paths;
6. executes through the worker's own FolderForge policy, approval, rate-limit,
   and audit pipeline;
7. refuses tools outside `--allow-tools`, admin tools, `distributed_*`, and
   `marketplace_*` recursion;
8. uploads a redacted bounded result artifact;
9. signs result digest, tool/args identity, artifacts, worker/platform, and policy
   evidence;
10. submits the evidence for coordinator verification and countersigning.

A worker can still be deployed inside FolderForge's Docker/Podman sandbox or a
separate VM. The `remote` evidence mode proves the worker identity and local
allowlist digest; it does not, by itself, prove a cloud/VM isolation boundary.

## Replay and recovery

Choose replay policy when submitting:

- `idempotent`: expired unacknowledged or acknowledged work may be queued again;
- `no-replay`: once acknowledged, an expired/partitioned execution is marked
  `blocked` because its side effects are unknown.

Use `distributed_recover` to persist expiry decisions. A blocked job is never
silently replayed. `distributed_job_retry` accepts only jobs explicitly marked
idempotent.

## Evidence verification

`distributed_completion_verify` checks both signatures against stored identities.
The completion record binds:

- job, lease, worker, and fencing token;
- tool and canonical argument digest;
- result digest and success/failure state;
- input/output artifact IDs;
- worker policy/sandbox evidence;
- worker completion time and coordinator acceptance time.

## Operational limits

The reference implementation is a single durable coordinator with a file lock,
not a multi-coordinator consensus system. Run one writer per project state root.
For active-active coordination, the next architectural step would require a
transactional shared store and leader/fencing semantics at the store layer; do
not put the current JSON state on an eventually consistent network filesystem.
