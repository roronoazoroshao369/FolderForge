# PROJECT STATE

_Last updated: 2026-10-05T09:10:45Z_

## Product and repository

- Phase: 3.0.1 release-candidate hardening; external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`; default branch: `main`.
- Verified main SHA: `3b1889e42cd236d80fd57f3cb6521ccc7700ef84`.
- Exact-SHA main CI: run `37287594297` completed success; all six Ubuntu/macOS/Windows × Node 22/24 jobs succeeded.
- PR #32 merged normally at `2026-10-05T09:04:02Z`. Accepted head: `bda17ce160e93587043f5b95c814b0a3f0f0373e`; exact-head run `37286780402` completed success for all six jobs. Merge commit is the verified main SHA above. No admin or bypass flag was used.
- Overall verdict: IN_PROGRESS because R16 and R17 remain open. R19 is fixed on this main SHA.
- This handoff does not self-certify a later documentation commit. Inspect live `origin/main` and match its run by exact SHA before the next goal.

## Environment inspected before the goal

Host: Linux `devops-HP-Z420-Workstation`, kernel `7.0.0-31-generic`, uid `1000(devops)`, Node `22.23.0`. Docker: `/usr/bin/docker`. Podman: not on PATH, no `/usr/bin/podman` or `/usr/local/bin/podman`, `podman.service` and `podman.socket` inactive, no `/run/podman` or `/run/user/1000/podman`. cgroup: `0::/init.scope`. Real Podman acceptance is NOT_RUN. Present Docker images are unrelated local fixtures and are not Podman or VM-host proof.

## Verification truth

Baseline and merge CI prove only steps that ran. Docker isolation on Ubuntu/Node 22 is not Podman or macOS/Windows container-runtime proof. Windows jobs still skip the full suite, package/stdio/HTTP smokes, heartbeat stress, and MCP Inspector. Those skips are NOT_RUN, not passes.

On PR head run `37286780402`, Windows/Node 22 recorded: `Windows danger-mode regression` success, `Pinned third-party child MCP compatibility` success, `Build` success; `Test`, package smoke, stdio smoke, HTTP smoke, heartbeat stress, and MCP Inspector skipped. No `ci.yml` condition changed.

## Risk register

| ID | Severity | Status | Evidence / boundary |
| --- | --- | --- | --- |
| R11 | High | Fixed | Terminal timeout/kill reaping remains on main. |
| R12 | High | Fixed | Applicable Linux/Docker sandbox CI gate remains enabled. |
| R13 | High | Fixed | Terminal timeout, signal, and uncertain outcomes remain distinct. |
| R14 | High | Fixed | Orphan recovery and Windows npm launch fixes remain on main. |
| R15 | High | Fixed | Windows/Node 22 third-party child-MCP step succeeded again in run `37286780402`. |
| R16 | Medium | Open | Real Podman runtime evidence absent. Rootless UID/mount/cgroup behavior and VM-host portability unverified. Docker success and routing mocks are not Podman proof. |
| R17 | External | Open | Exact-release-SHA 24-hour soak, protection/environment confirmation, human Danger Mode sign-off, and beta evidence incomplete. |
| R18 | Medium | Fixed | PR #30 merged after run `37278290277` passed all six jobs on head `816a98aedd55538d8315036b1c6ada486a754bd6`. Absent Podman fails with ENOENT rather than Docker success. This does not close R16. |
| R19 | Low | Fixed | `docs/compatibility.md` now matches `ci.yml`. The generated Windows run/NOT_RUN table is locked by `tests/unit/windows-ci-claims.test.ts`, which also fails if an existing Windows gate stops running. Exact-head run `37286780402` and merge run `37287594297` succeeded. This does not create Windows full-suite evidence. |

## Completed goal

**GOAL**
Reconcile the false Windows workflow claims without weakening or expanding gates.

**WHY THIS GOAL**
Real Podman acceptance was preferred and was NOT_RUN because no Podman engine, socket, or service was available. Installing a runtime was not approved. The remaining reproducible internal gap was R19.

**SCOPE**
`docs/compatibility.md`, `docs/releasing.md`, `CHANGELOG.md`, proposal 025, and `tests/unit/windows-ci-claims.test.ts`. No workflow, product, dependency, or version change.

**ACCEPTANCE**
1. The contract test failed before the document contained the generated table, then passed.
2. `git diff -- .github/workflows/ci.yml` was empty.
3. Windows danger-mode regression, Node 22 third-party probe, build, and the shared typecheck/lint/docs/architecture/routing/fleet steps still run.
4. Exact PR head and the resulting main SHA each passed all six CI jobs.
5. R16 and R17 remain open. Skipped Windows checks stay labeled NOT_RUN.

**ROLLBACK**
Revert `bda17ce160e93587043f5b95c814b0a3f0f0373e` or the merge `3b1889e42cd236d80fd57f3cb6521ccc7700ef84`. No data migration.

## Council decision

Options: A — do nothing (reject: leaves a false supported-platform claim); B — install Podman or expand Windows to the full suite now (reject: engine unavailable, and expansion was out of scope); C — document the existing workflow exactly and lock it (selected).

- Architect: C; do not invent Windows coverage by editing the workflow.
- Security: C; keep the Windows danger-mode and third-party gates mandatory.
- QA/Verifier: C; red/green contract test plus exact-SHA CI.
- SRE/Release: C; do not treat a green Windows job as full-suite evidence.
- DX/Docs: C; say NOT_RUN explicitly.
- Skeptic: conditional C; a generated table can drift if the parser short-circuits. The parser must consume both sides of `&&`, and skipped steps must not be narrated as acceptance.
- Scribe: C; record the absent Podman probe as NOT_RUN, not as a failed containment test.

These are role/hat reviews by one agent, not independent human ratification.

## Local evidence for the completed goal (E2)

| Check | Exit | Result |
| --- | --- | --- |
| red `npx vitest run tests/unit/windows-ci-claims.test.ts` before the contract table | 1 | missing contract marker; log `.folderforge-ci/windows-claim-reconcile/red2.log` |
| green focused contract test | 0 | 2 passed |
| `npm run verify` | 0 inferred from log | 147 files; 1200 passed, 14 skipped; no FAIL or ELIFECYCLE |
| `npm run docs:check` | 0 | PASS |
| `npm run build` | 0 | PASS |
| `git diff --check` | 0 | PASS |
| `git diff -- .github/workflows/ci.yml` | empty | no gate added, removed, or weakened |

## External human gates still closed

24-hour exact-release-SHA soak; branch protection; protected npm-publish environment; Danger Mode sign-off; beta evidence; explicit `v3.0.1` tag/npm publish/GitHub Release approval. Never retag or delete `v3.0.0`.

## NEXT_RUN_PROMPT

Resume the FolderForge perpetual council on `roronoazoroshao369/FolderForge`, default branch `main`, under the stable council policy. Repository truth overrides this record. Read PROJECT_STATE, PROJECT_STATUS, CURRENT_FRONTIER, CHANGELOG, sandbox/compatibility docs, and ci.yml. Inspect git status, fetch origin/main, and match CI to the exact live SHA before editing. A documentation handoff may have advanced main after `3b1889e42cd236d80fd57f3cb6521ccc7700ef84`; do not assume this file's SHA is still current.

R11–R15, R18, and R19 are fixed. R16 (real Podman and deployment-specific containment) and R17 (external release/human gates) remain open. Windows full-suite, package, stdio, HTTP, heartbeat, and Inspector checks remain NOT_RUN; do not reopen R19 unless the document and workflow diverge again. Select ONE gap: real Podman acceptance only when a target engine, image, user, mount, and cgroup context are actually available. Otherwise do not install a runtime and do not expand or skip CI gates. Record environment, engine/user/mount/cgroup context, exact SHA, command, exit, and artifact. Docker or routing mocks do not prove Podman/VM-host parity. Skipped checks are NOT_RUN.

Do not tag, publish, release, retag/delete v3.0.0, change protection or secrets, or cancel workflows without explicit approval. INSPECT → RECONCILE → ONE GOAL → VERIFY → PR → MERGE ONLY WITH ACCEPTANCE AND EXACT-SHA CI GREEN → UPDATE PROJECT_STATE → emit NEXT_RUN_PROMPT → stop.
