# Resumable runtime soak evidence

FolderForge includes a long-running runtime harness for collecting continuous,
tamper-evident evidence across the governed tool pipeline and a live child MCP
process. The harness is designed for multi-hour and 24-hour runs, including
operator interruption and later resume.

## What each sample proves

Every successful sample performs all of the following:

1. executes `file_read` through `ToolRegistry.callAgent` with audit durability set
   to `required`;
2. verifies the returned sentinel content;
3. performs a complete child MCP `tools/list` request;
4. calls the child `echo` tool and verifies the exact response;
5. records latency by phase, event-loop delay, process memory, child transport
   counters, protocol version, PID, catalog size, and content hashes; and
6. fsyncs the JSONL evidence record before moving to the next sample.

The default fault schedule restarts the child process every 300 samples and records
old/new PIDs plus recovery latency. Planned restarts are classified separately from
unexpected failures.

## Run profiles

A five-second release smoke is available as:

```bash
npm run smoke:runtime-soak
```

Start the maintained 24-hour profile with:

```bash
npm run soak:runtime:24h
```

The default evidence directory is `.folderforge-soak/runtime`. To use a dedicated
location or custom profile:

```bash
npm run soak:runtime -- \
  --output-dir /var/tmp/folderforge-soak \
  --duration-ms 86400000 \
  --interval-ms 1000 \
  --fault-every 300
```

## Resume after interruption

SIGINT and SIGTERM close the active child, append a `segment_end` record, fsync the
chain, update `summary.json`, and exit non-zero so automation does not mistake an
incomplete run for success. Continue the same active-duration target with the exact
same configuration:

```bash
npm run soak:runtime -- \
  --output-dir /var/tmp/folderforge-soak \
  --duration-ms 86400000 \
  --interval-ms 1000 \
  --fault-every 300 \
  --resume
```

Resume first verifies every existing record and rejects a changed configuration or
an already completed run. Paused wall-clock time is not counted as active soak
time; every resumed execution creates a new segment in the same evidence chain.

## Evidence integrity

`evidence.jsonl` is an append-only SHA-256 chain. Each envelope commits to its run
ID, sequence, previous hash, canonical payload, source-input hashes, environment,
and measurements. Records are appended with full-write handling and `fsync`.
`summary.json` is derived and can always be regenerated:

```bash
npm run soak:runtime -- \
  --output-dir /var/tmp/folderforge-soak \
  --verify
```

The verifier fails on modified payloads, missing/reordered records, broken previous
hashes, invalid schema, malformed JSON, or an incomplete final JSONL record.
FolderForge's governed audit log is independently verified before a run receives a
`run_complete` record.

All unexpected failures and threshold outliers remain as full records; the summary
never substitutes for the raw chain. Evidence and summary files are written with
mode `0600` where the platform supports POSIX permissions.

## Safe reset

`--reset` removes only a directory containing FolderForge's ownership marker. An
arbitrary existing path, file, or unmarked directory is rejected rather than
recursively deleted:

```bash
npm run soak:runtime -- \
  --output-dir /var/tmp/folderforge-soak \
  --duration-ms 86400000 \
  --reset
```

## Claim boundary

The repository currently contains automated short-run evidence for completion,
planned child restart, SIGTERM resume, tamper detection, incomplete-record
detection, safe reset, and a 90,001-record full-day volume model. CI retains the
five-second smoke artifact.

The normal test suite covers a bounded 5,001-record chain; a dedicated
`npm run test:runtime-soak-volume` gate constructs and verifies 90,001 records and
retains its CI report without competing with latency-sensitive unit tests. These
gates prove the harness, not a completed 24-hour production observation. A
24-hour reliability claim requires a passing `run_complete` chain whose recorded
active duration is at least 86,400,000 ms, whose source revision and environment
match the claim, and whose raw failure/outlier records are retained. Independent
reproduction and review remain separate external evidence gates.
