# Benchmark execution operations

The benchmark task manifest and result validator are frozen separately from the
agent/harness used to run them. FolderForge 2.5 adds a no-shell execution runner
that produces raw redacted evidence and machine-readable results.

## Harness contract

Run:

```bash
npm run benchmark:run -- \
  --command /absolute/path/to/agent-harness \
  --command-args-json '["--json"]' \
  --system-name FolderForge \
  --system-version 2.5.0 \
  --commit <exact-commit> \
  --agent <agent-name> \
  --model <model-name> \
  --runs 5 \
  --output benchmarks/results/folderforge.json
```

Each invocation receives:

```text
FOLDERFORGE_BENCHMARK_TASK_JSON
FOLDERFORGE_BENCHMARK_TASK_ID
FOLDERFORGE_BENCHMARK_RUN
FOLDERFORGE_BENCHMARK_WORKDIR
FOLDERFORGE_BENCHMARK_FIXTURE
FOLDERFORGE_BENCHMARK_EVIDENCE_DIR
```

The harness must finish stdout with one JSON object containing:

```json
{
  "success": true,
  "securityPass": true,
  "toolCalls": 20,
  "tokens": 12000,
  "approvals": 1,
  "unintendedFiles": 0,
  "notes": "reviewed bounded note"
}
```

## Isolation and evidence

The runner:

- invokes an executable directly with `shell:false`;
- copies each fixture into a fresh temporary directory;
- applies a per-run timeout;
- captures bounded stdout/stderr;
- redacts common bearer, token, secret, password, API-key, and JWT forms;
- passes only a portable minimal environment by default;
- exposes extra environment variables only through explicit `--env-allow`;
- stores one evidence JSON file and SHA-256 per run;
- records failed, timed-out, and malformed harness runs instead of dropping them;
- deletes temporary workdirs unless `--keep-workdirs` is explicit.

The result still must pass `npm run benchmark:validate`. Comparative publication
requires the frozen task hash, the minimum run count for every task, no duplicate
or omitted runs, and compatible hardware for latency claims.

## Local governance microbenchmark

The separate local overhead benchmark measures FolderForge itself without making
competitor claims:

```bash
npm run benchmark:governance
```

It preserves all five samples and records Node, operating system, architecture,
CPU model/count, and memory. The tracked baseline is
`benchmarks/baselines/local-governance.json` and covers:

- construction of a 1,000-tool governed registry;
- `tools/list` over 1,000 synthetic definitions;
- one policy decision through a 500-rule policy-as-code set;
- cold process startup, MCP initialization, and one real stdio `tools/list` call.

The July 20, 2026 local baseline passes the initial limits with p95 values of
0.0443 ms for `tools/list`, 0.0878 ms for 500-rule evaluation, and 613.4203 ms
for cold stdio initialize plus `tools/list`. These values apply only to the
hardware and software recorded in that JSON file. They are not a comparison with
ToolHive, Docker MCP Gateway, MetaMCP, ContextForge, or another system.

CI reruns the microbenchmark on its disclosed runner and stores the complete JSON
as an artifact. A public comparative result additionally requires pinned versions,
equivalent configuration, raw evidence from every system, and independent
reproduction.
