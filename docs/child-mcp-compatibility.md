# Child MCP compatibility program

FolderForge treats child MCP orchestration as a reliability boundary rather than
a transparent subprocess wrapper. The maintained compatibility contract covers:

- initialization and protocol negotiation;
- bounded, cursor-paginated `tools/list`;
- tool-call isolation and cancellation;
- child-initiated ping handling;
- malformed or oversized frame rejection;
- bounded stderr and stdout buffering;
- heartbeat, crash classification, shutdown, and process cleanup;
- explicit no-replay behavior after an uncertain mutation.

## Deterministic protocol corpus

Run the five portable protocol profiles with:

```bash
npm run compatibility:child-mcp
```

The corpus exercises:

| Profile | Required result |
| --- | --- |
| Baseline initialize/list/call | Negotiates a supported protocol and completes a call |
| Paginated catalog | Follows all cursors exactly once and returns all tools |
| Child-initiated ping | Answers the child's request without blocking catalog discovery |
| Malformed frame | Fails closed with a classified diagnostic |
| Crash during tool call | Returns an uncertain failure and never replays automatically |

The wider `tests/unit/child-mcp-client.test.ts` suite covers request isolation,
timeouts, cancellation notifications, message and catalog limits, list-change
notifications, heartbeat behavior, bounded stderr, process-tree cleanup, and
failure classification.

## Evidence and limitations

CI writes the deterministic result to
`.folderforge-ci/child-mcp-compatibility.json` and preserves it as an artifact.
The result records exact timings, negotiated protocol, tool catalogs, and failure
diagnostics.

These profiles are **not** claims about five third-party MCP products. A public
third-party compatibility matrix additionally requires:

1. pinned server package/image version and digest;
2. exact launch configuration and operating system;
3. permission and sandbox profile;
4. raw protocol/failure evidence;
5. a named result owner and retest date.

Until those external runs exist, FolderForge may claim that its deterministic
protocol corpus passes, but not that an arbitrary third-party server is certified.
