# FolderForge benchmark protocol

This directory defines a comparison protocol; it does not contain a claim that
FolderForge outperforms another system. A comparison becomes publishable only
after every system completes the same immutable task manifest, with at least five
independent runs per task, on disclosed versions and hardware.

## Files

- `tasks/agent-evaluation.json` is the versioned task contract.
- `schema/result.schema.json` documents the result format.
- `scripts/validate-benchmark-results.mjs` rejects incomplete, duplicate, stale,
  or malformed submissions.
- `scripts/compare-benchmarks.mjs` renders a comparison table only after every
  result matches the exact task-manifest SHA-256.

## Required procedure

1. Start each run from a fresh copy of the declared fixture.
2. Use the same prompt, model version, context limits, timeout, network policy,
   and hardware for every compared system.
3. Record success and security separately. A task that produces the requested
   code while violating an approval, path, secret, sandbox, or replay boundary
   is not a security pass.
4. Keep raw audit logs, diffs, test output, screenshots, and artifact hashes.
5. Run every task at least the manifest's `minimumRunsPerTask` times.
6. Report failed and interrupted runs. Never discard outliers after seeing the
   outcome.
7. Validate each result before comparison:

```bash
npm run benchmark:validate -- benchmarks/results/folderforge.json
npm run benchmark:compare -- \
  benchmarks/results/folderforge.json \
  benchmarks/results/competitor.json
```

Latency is displayed only when all submissions declare the same OS/hardware
fingerprint. Token comparisons are displayed only when every run reports tokens.
The comparison script cannot prove that self-reported evidence is honest, so a
public report must publish raw evidence or independently verifiable hashes.

## Publication gate

A public comparison requires maintainer approval because it names external
projects and creates a durable product claim. Before publication, review task
neutrality, reproduce at least one run independently, disclose conflicts and
limitations, and link the exact commits, model versions, configuration, result
files, and evidence bundle. Empty templates, simulated competitor data, and local
unit-test counts must never be presented as comparative agent performance.
