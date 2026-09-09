# Proposal 017: tree-kill natural timeouts in coverage/format/pkg tools

- Author role: Provisioner Engineer
- Date: 2026-09-09
- Status: implemented (2026-09-09, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Debt carried from proposal 008 (loop #35), which fixed natural-timeout
tree-killing for verification checks, `shell_exec`, and the sync `run_*`
path but deliberately deferred `coverage-tools.ts`, `format-tools.ts`,
`pkg-tools.ts` on the assumption that "they spawn binaries directly via
execa without a login shell, so there is no wrapper grandchild layer".

Loop #46 re-read the actual argv tables and that assumption does not hold:

- `run_coverage` spawns `npx vitest|jest …` or `pytest|go|cargo …` — `npx`
  is itself a wrapper process around the real runner.
- `format_check/apply` spawn `npx prettier|biome …` (same wrapper layer) or
  `ruff|black|gofmt|cargo fmt`.
- `pkg_run` spawns `npm|pnpm|yarn run <script>` — the package manager runs
  the script through `sh -c`, i.e. a genuine shell-grandchild layer; and
  `pkg_add`/`pkg_remove`/`pkg_outdated`/`pkg_audit` spawn the package
  manager, which forks its own children.

All three files call `execa(bin, rest, { cwd, timeout: defaultTimeoutMs,
reject: false, maxBuffer })` — **not** detached, and execa's `timeout`
SIGTERMs only the direct child. On a blown budget the wrapper (npx/npm)
dies while the real workload (vitest, the manifest script's `node`, …)
survives as an orphan holding the stdio pipes — the same bug class #29
measured at 30.1s and #35 killed for the other three sites. Fix it with the
proven helper instead of another bespoke path.

## Proposal

Mirror the proposal-008 pattern exactly at the three remaining call sites —
behavior-preserving outward, kill mechanics only:

1. **`src/tools/coverage-tools.ts`** — extract the inline execa block into an
   exported module-level `runCoverageCommand(ctx, argv)` (argv-taking, like
   the already-exported `runPm`; zero logic change) and wire it: drop the
   `timeout` option, spawn `detached: true` on POSIX, arm
   `armTreeKillTimeout(child, defaultTimeoutMs)` right after spawn, dispose
   in `finally` (`await child.finally(() => treeTimeout.dispose())`, the
   build-tools shape).
2. **`src/tools/format-tools.ts`** — `runFmt(ctx, argv)` gains the same
   wiring and an `export` keyword (it already takes argv; no logic change).
3. **`src/tools/pkg-tools.ts`** — `runPm(ctx, argv)` gets the same wiring
   (already exported; no shape change).

Outward contract is frozen bit-for-bit: same argv/cwd/budget, same redaction
and capping, `exitCode: null` on a blown budget (SIGKILL leaves
`exitCode` undefined → `?? null`), no new fields, no output-schema or
schema-lock change, no new timeout message (today these tools report a
blown budget only as `ok:false` + `exitCode:null` — a dedicated timeout
message is a possible DX follow-up, explicitly out of scope here).

Non-goals: ProcessManager/async paths (already correct); changing the
detected argv tables; touching `terminateChildProcessTree` semantics; any
other tool file.

## Threat surface (Security hat)

No new tools, permissions, argv, or policy surface — identical commands,
cwd, and timeout values; only the kill mechanics change. The group kill
targets a process group **we** created (detached spawn in the same call) —
no foreign pids, so no `terminatePidTree`-style identity gate is required.
SIGKILL on a blown budget cannot be trapped by the workload; cancel paths
are untouched (they stay SIGTERM). `validatePkgSpec` and the manifest-script
guard are unchanged.

## Test plan (QA hat)

- Integration (`tests/integration/coverage-format-pkg-timeout.test.ts`, new,
  POSIX-only, skipped on win32): for each of the three argv-taking entry
  points (`runCoverageCommand`, `runFmt`, `runPm`) build a minimal ctx stub
  with a tiny `defaultTimeoutMs` and run a node fixture that orphans a
  **marked** grandchild (the #35 fixture pattern) — assert the call resolves
  promptly (well under the orphan-hang horizon), the outward shape stays
  (`exitCode: null`), and `pgrep -f <marker>` proves the grandchild is
  reaped. `runPm` additionally proves the real wrapper case:
  `npm run <hang-script>` in a temp fixture project (npm → sh → node →
  marked grandchild).
- Regression: `pkg-tools-matrix`, `process-tree`, `terminal-tools`,
  `agent-tools` suites pass unchanged; the three touched modules' existing
  suites pass unchanged on this host.
- Gates: targeted, typecheck/lint/build 0/0/0, full suite (run_test async,
  disclosed per #27).
- Live proof on the built dist: a node harness importing
  `dist/tools/pkg-tools.js` `runPm` with a stub ctx runs the real
  `npm run <hang-script>` with a small budget — resolves promptly, marked
  grandchild reaped (pgrep), real host untouched (temp fixture only).

## Rollback

Revert the branch commit; execa's direct-child timeout semantics return for
the three tools (the orphan risk returns with them; no data or state risk
either way).

## Decision log

- 2026-09-09 — Provisioner Engineer — propose — loop #46, candidate #1 from
  the post-#45 queue (debt #35). Re-read of the argv tables disproves the
  008 deferral assumption: npx/npm wrapper layers exist in all three files
  (`npx vitest`, `npx prettier`, `npm run <script>` → `sh -c` → script), so
  the orphan-grandchild bug class is live there.
- 2026-09-09 — Security Officer — **approve with amendments** — (1) group
  kills only ever target self-spawned detached groups — hard-require
  `detached:true` at every converted POSIX site; (2) SIGKILL only for the
  blown-budget path; cancel paths untouched; (3) no new argv/permissions/
  policy surface; (4) outward contract frozen (exitCode null, no new fields,
  no schema change). This approval does NOT cover merge/push — Git needs
  separate user approval.
- 2026-09-09 — QA/Verifier — **approve with amendments** — (1) per-site
  integration proofs with unique pgrep markers are mandatory (they are the
  regression that kills the bug class here); (2) win32 skip, POSIX-only;
  (3) `runFmt` export and the `runCoverageCommand` extraction must be
  provably logic-free (argv passthrough, same options); (4) full-suite
  evidence method disclosed per #27; (5) live proof must show both prompt
  return AND a reaped grandchild AND zero host change.
- 2026-09-09 — QA/Verifier — **gates green on the final code** — targeted
  70/70 (new tests/integration/coverage-format-pkg-timeout.test.ts 3/3 —
  incl. the real npm → sh → node wrapper chain at ~3.1s, with the
  grandchild proven alive pre-kill (expectAliveSoon) and reaped post-kill
  (expectReaped), no vacuous pass; regressions agent-tools 20 /
  terminal-tools / process-tree / pkg-tools / pkg-tools-matrix unchanged),
  typecheck exit 0, lint exit 0 (eslint --max-warnings=0), build exit 0
  (armTreeKillTimeout present in all three dist tools), full suite **135
  files / 1115 tests PASS** (78.85s, run_test async — disclosed per #27;
  135 = 134 + the new file; 1115 = 1112 + the 3 new tests), live proof
  PROOF_EXIT:0 (dist runPm harness: `npm run hang` in a temp fixture,
  marker ff46proof* sawAlive → reaped, ok:false + exitCode:null frozen,
  elapsed 3028ms, fixture removed, zero host change).
- 2026-09-09 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #46 (survey approval after the LOOP REPORT).
