# PROJECT STATE

_Last updated from inspected main SHA `d7d35f9d55a27d418ac9e5708aec3498680137b6` (exact-SHA run `37408073201`) as the evidence baseline._

## Product and repository

- Phase: 3.0.1 release-candidate hardening; all external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`; default branch: `main`.
- Inspected main SHA (docs-update base): `d7d35f9d55a27d418ac9e5708aec3498680137b6`.
- Exact-SHA main CI: run `37408073201` completed success on that SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs succeeded.
- PR #36 merged normally at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. Its exact PR-head run `37405842816` passed all six matrix jobs; PR #37 later advanced main to the inspected base above.
- PR #35 was closed without merge after exact-head run `37400080019` failed; its proposed handoff was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were closed without merge after exact-head CI failures. No dependency upgrades were merged; this docs-only state handoff was the only remaining PR to validate.
- Root production and full dependency audits passed in exact-main run `37408073201`. This does not clear the separate Mission Control package audit: 1 moderate and 2 high findings remain; Vite 8.3.2 is a major upgrade and the locked React Vite plugin does not declare Vite 8 support.
- Overall verdict: IN_PROGRESS because R16, R17, and R20 remain open. R16/R17 and all external release gates remain closed.
- This record does not self-certify the docs-only branch update. Inspect live `origin/main` and match its CI run by exact SHA before the next goal.

## Previously inspected environment (not rechecked for this update)

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
| R17 | External | Open | At `2026-10-05T13:34:32Z`, the GitHub `main` branch protection API returned HTTP 404 `Branch not protected`, and repository rulesets were `[]`; the protection gate is unmet. Exact-release-SHA 24-hour soak, protected npm-publish environment, human Danger Mode sign-off, beta evidence, and explicit release approval remain incomplete. No settings were changed. |
| R18 | Medium | Fixed | PR #30 merged after run `37278290277` passed all six jobs on head `816a98aedd55538d8315036b1c6ada486a754bd6`. Absent Podman fails with ENOENT rather than Docker success. This does not close R16. |
| R19 | Low | Fixed | `docs/compatibility.md` now matches `ci.yml`. The generated Windows run/NOT_RUN table is locked by `tests/unit/windows-ci-claims.test.ts`, which also fails if an existing Windows gate stops running. Exact-head run `37286780402` and merge run `37287594297` succeeded. This does not create Windows full-suite evidence. |
| R20 | High | Open | `packages/mission-control` audit still reports 1 moderate and 2 high vulnerabilities (esbuild, source-map-js, Vite). Vite 8.3.2 is a major fix path; locked `@vitejs/plugin-react@4.7.0` declares Vite peer support only through 7. Review a compatible plugin/toolchain migration before any Vite 8 upgrade. No Mission Control dependency upgrade was made. |

## Latest completed goal (2026-10-06): branch cleanup

**GOAL**
Remove stale branches without merging changes whose exact-head CI failed or changing release gates.

**RESULT**
PRs #35, #14, #15, #16, #18, #20, #21, #23, and #27 were closed without merge after exact-head CI failures; their remote head branches were deleted. Stale local and remote refs already merged into main were pruned. No dependency upgrades were merged. Both active managed task isolations were preserved; their state was reported as active and source-dirty, so their branches/worktrees were left untouched. R16/R17/R20 and all external release gates remain unchanged.

## Previous completed goal (2026-10-06): root audit remediation

**GOAL**
Resolve the root production and full dependency audit findings without changing release gates.

**RESULT**
PR #36 merged at main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. Its exact-head run `37405842816` passed all six matrix jobs. Exact-main run `37406501278` passed all six jobs, including the production and full dependency audits. These audit passes cover the root package only.

**SCOPE**
Reviewed and pinned root `simple-git@4.0.2`, applied patched root overrides for `proxy-addr@2.0.8` and `source-map-js@1.2.2`, and added a `git_blame` option-like filename regression test. PR #35 was later closed unmerged after its exact-head run failed.

**OPEN BOUNDARY**
The separate `packages/mission-control` audit remains 1 moderate and 2 high findings. Its suggested Vite 8.3.2 upgrade is major; locked `@vitejs/plugin-react@4.7.0` does not declare Vite 8 support. No Vite or Mission Control dependency upgrade was performed. R16/R17 and all release gates remain closed.

## Prior completed goal (2026-10-05)

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

At `2026-10-05T13:34:32Z`, `GET /repos/roronoazoroshao369/FolderForge/branches/main/protection` returned HTTP 404 `Branch not protected`, and `GET /repos/roronoazoroshao369/FolderForge/rulesets?includes_parents=true` returned `[]` in the authenticated API context. This confirms that the R17 protection gate is unmet; it is not authorization to change repository settings. No settings were changed.

The 24-hour exact-release-SHA soak, protected npm-publish environment, Danger Mode sign-off, beta evidence, and explicit `v3.0.1` tag/npm publish/GitHub Release approval also remain outstanding. Never retag or delete `v3.0.0`.

## NEXT_RUN_PROMPT

Resume the FolderForge perpetual council on `roronoazoroshao369/FolderForge`, default branch `main`, under the stable council policy. Repository truth overrides this record. Read the release-state and handoff docs, then inspect `git status`, fetch `origin/main`, and match CI to the exact live SHA before any edit. The inspected base snapshot was main `d7d35f9d55a27d418ac9e5708aec3498680137b6`, run `37408073201` green on all six matrix jobs. Any later change requires exact-head CI and a fresh live-main check.

PR #36 is merged. PR #35 and stale dependency PRs #14, #15, #16, #18, #20, #21, #23, and #27 were closed unmerged after failed exact-head CI; no dependency upgrades were merged. This docs-only handoff was the final PR; confirm its exact-head CI and merge state live on the next run. The root production/full audits are clear on the recorded main SHA. The separate Mission Control audit remains 1 moderate and 2 high findings. The lock has Vite `5.4.21` and `@vitejs/plugin-react` `4.7.0`, whose peer range ends at Vite 7; no Vite 8 upgrade was made. Review plugin/toolchain compatibility before considering a Vite 8 migration. R16, R17, and R20 remain open. Keep all release gates closed.

Select one goal only. Do not infer full-repository audit cleanliness from the root audit. Do not tag, publish, release, retag/delete `v3.0.0`, change branch protection or secrets, or cancel workflows without explicit approval. INSPECT → RECONCILE → ONE GOAL → VERIFY → PR → MERGE ONLY IF SAFE AND EXACT-SHA CI GREEN → UPDATE STATE → emit a new NEXT_RUN_PROMPT → stop.
