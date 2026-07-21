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
- child tool-list invalidation, direct-wrapper refresh, and parent notification;
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
failure classification. `tests/integration/adapters.test.ts` additionally starts
a real child process and proves that an advertised list-change refreshes direct
wrappers atomically and reaches a connected parent MCP client.

## Pinned third-party matrix

The deterministic corpus is complemented by a separate network-backed runner:

```bash
npm run compatibility:child-mcp:third-party
```

It currently pins five published products/packages: the MCP Everything,
Filesystem, Memory, and Sequential Thinking reference servers plus Microsoft
Playwright MCP. Exact versions, npm integrity values, required tools, reviewed
safe probes, environment isolation, audit behavior, and claim boundaries are
documented in [Pinned third-party compatibility](third-party-mcp-compatibility.md).

## Evidence and limitations

CI writes the deterministic result to
`.folderforge-ci/child-mcp-compatibility.json`. Node 22 jobs on Ubuntu, macOS, and
Windows additionally write `.folderforge-ci/child-mcp-third-party.json`. Both are
preserved as artifacts. Reports record exact timings, protocol versions, catalog
hashes, transport counters, package integrity, audit status, source-input hashes,
and failure diagnostics.

The deterministic fixtures prove protocol behavior but are not third-party
product claims. The pinned matrix proves only the exact package bytes and
operating system recorded in each passing report; it does not certify every tool,
mutation, remote API, browser binary, transport, future version, or arbitrary MCP
server. Independent clean-machine reproduction and named maintenance ownership
remain external evidence gates.
