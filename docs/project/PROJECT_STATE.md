# PROJECT STATE

_Last updated from inspected main SHA `863306eb46a4609a1f065f746ed3b94e6be20535` (exact-SHA run `37648701564`) as the evidence baseline._

## Product and repository

- Phase: 3.0.1 release-candidate hardening; all external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`; default branch: `main`.
- Inspected main SHA (docs-update base): `863306eb46a4609a1f065f746ed3b94e6be20535`.
- Exact-SHA main CI: run `37648701564` completed success on that SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs succeeded.
- PR #39 merged at that SHA after exact-head run `37424245809` passed all six matrix jobs on head `9563b5652e5bcdf515fab4dd40743a8ec7c1f740`.
- PR #36 merged normally at prior main SHA `7fa11eecfb8bddd0a9d3d195d2ad8427ca7a7226`. Its exact PR-head run `37405842816` passed all six matrix jobs; PR #37 later advanced main to the inspected base above.
- PR #35 was closed without merge after exact-head run `37400080019` failed; its proposed handoff was superseded by PR #37. PRs #14, #15, #16, #18, #20, #21, #23, and #27 were closed without merge after exact-head CI failures. PR #39 later merged the scoped Mission Control dependency remediation after exact-head CI passed.
- Root production and full dependency audits passed in exact-main run `37648701564`. PR #46 raised the `@modelcontextprotocol/sdk` security floor to `^1.32.1` after GHSA-6qxp-vccf-f47h made the previous `1.29.0` lock fail the production audit; exact-head run `37647956742` and merge-SHA run `37648701564` each passed all six jobs. The separate `packages/mission-control` remediation (R20) remains VERIFIED_CI. No release gate changed.
- Overall verdict: IN_PROGRESS because R16 and R17 remain open. R20 is VERIFIED_CI. R16/R17 and all external release gates remain closed.
- This record is grounded in the verified main SHA above. Any later revision still requires its own exact-SHA CI before being used as a baseline.

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
| R20 | High | VERIFIED_CI | PR #39 merged at `4a8fcafec87bf1b6ace59042bf4688eaf853c6f8`: Vite 5.4.21 → 6.4.4 (clears GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff), esbuild 0.21.5 → 0.25.12 via Vite 6 (clears GHSA-67mh-4wv8-2f99), and `source-map-js@^1.2.2` override (clears GHSA-68fv-2mgg-jv7q). Local audit is 0 vulnerabilities; SPA build and all 12 visual-regression screens pass. Exact-head run `37424245809` and merge run `37425225414` each passed 6/6. No Vite 8 upgrade was taken. |

## Latest completed goal (2026-10-07): restore root dependency audit after MCP SDK advisory

**VERDICT**

PASS. Exact-main CI is green again after updating the locked MCP TypeScript SDK security floor.

| Evidence | Result |
| --- | --- |
| Red main baseline | `26432cc45c2e8e1d3ad4e52ad924a4deb3bf4860`; run `37646358844` failed only on Ubuntu/Node 22 production dependency audit |
| Root cause | `@modelcontextprotocol/sdk@1.29.0` matched GHSA-6qxp-vccf-f47h; PR #45 itself did not change dependencies |
| Product PR | #46, exact head `9d5753c000e0fc0cc0b2fe5f8d03b4edc6db087a`, run `37647956742`, 6/6 success |
| Merge main | `863306eb46a4609a1f065f746ed3b94e6be20535`, run `37648701564`, 6/6 success |
| Dependency audits | production and full audit steps both success on PR head and merge main |
| Release gates | R16/R17 and every external release gate remain closed |

**SCOPE**

`package.json`, `package-lock.json`, and `CHANGELOG.md`: minimum `@modelcontextprotocol/sdk` is now `^1.32.1`; locked runtime is `1.32.1`. No workflow, policy, release, or public schema change.

**NEXT INTERNAL FRONTIER**

With exact-main CI green, select one measurable correctness/DX goal. The CLI value parser remains a candidate: a value-taking option should not consume the following option token as its value. Reproduce before changing it.

## Previous completed goal (2026-10-06): reconcile R20 CI status

**VERDICT**

PASS for the documentation goal: repository truth confirms PR #39 merged and R20 is VERIFIED_CI. Overall release verdict remains IN_PROGRESS because R16 and R17 are open.

| Evidence | Result |
| --- | --- |
| Live `origin/main` | `4a8fcafec87bf1b6ace59042bf4688eaf853c6f8`; local main matched and was clean before branching |
| PR #39 exact head | run `37424245809`, head `9563b5652e5bcdf515fab4dd40743a8ec7c1f740`, 6/6 success |
| Merge SHA | run `37425225414`, SHA `4a8fcafec87bf1b6ace59042bf4688eaf853c6f8`, 6/6 success |
| Open PRs | none at discovery |
| Managed isolations | both active/source-dirty; untouched |
| R16 / R17 | BLOCKED / EXTERNAL; unchanged |

## Previous completed goal (2026-10-06): Mission Control audit remediation (R20)

**GOAL**
Clear the separate `packages/mission-control` audit (1 moderate esbuild, 2 high source-map-js/Vite) without taking the unreviewed Vite 8 major and without touching release gates.

**WHY THIS GOAL**
Exact-main CI is green (run `37413497510` on `d063bf74f5b8c8261400e86fcea6f8778a4f11e3`), no PRs are open, and the decision rule ranks a reproducible open audit finding next. R16/R17 are externally blocked.

**SCOPE**
`packages/mission-control/package.json` (vite `^5.4.11` → `^6.4.4`, new `overrides` for `source-map-js@^1.2.2`), `packages/mission-control/package-lock.json`, and state/frontier/handoff docs. No workflow, version, root dependency, or release-metadata change.

**COMPATIBILITY REVIEW (pre-change)**
Latest Vite 6 line is 6.4.4; all three Vite advisories name ranges ending at `<=6.4.2`. `vite@6.4.4` engines allow Node ^18/^20/>=22 (repo requires Node >=22; CI matrix Node 22/24). Locked `@vitejs/plugin-react@4.7.0` declares peer `^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`; locked `@tailwindcss/vite@4.3.3` declares `^5.2.0 || ^6 || ^7 || ^8`. Vite 6 bundles esbuild `^0.25.0`, which clears the esbuild dev-server advisory. Vite 8 was rejected: the locked React plugin does not declare Vite 8 support.

**ACCEPTANCE**
1. `npm audit` in `packages/mission-control` reports 0 vulnerabilities (was 1 moderate + 2 high). PASS (E2).
2. Resolved tree: `vite@6.4.4`, `esbuild@0.25.12`, `source-map-js@1.2.2`, plugin-react 4.7.0 and tailwind 4.3.3 unchanged. PASS (E2).
3. `npm run build` in `packages/mission-control` (tsc --noEmit && vite build) passes on Vite 6.4.4. PASS (E2).
4. SPA visual regression suite passes against the Vite 6 build: 12/12 screens, 0.000% pixel diff. PASS (E2).
5. Root `npm run verify` and `npm run docs:check` pass; `git diff -- .github/workflows/ci.yml` empty. Evidence logged under `.folderforge-ci/mc-audit/`.
6. Exact-head CI on the PR passes all six matrix jobs before merge (E3 gate).

**ROLLBACK**
Revert the branch commit; only `packages/mission-control` manifest/lockfile and docs change. No data migration.

**COUNCIL**
Options: A — do nothing (reject: open High audit findings); B — Vite 8.3.x (reject: locked plugin-react declares support only through Vite 7); C — minimal compatible major Vite 6.4.4 + source-map-js override (selected); D — override-only without Vite upgrade (reject: no patched Vite 5 line exists for the three advisories).

- Architect: C; smallest boundary change with a declared-compatible toolchain.
- Security: C; clears all three findings fail-safe; dev-server-scoped advisories still worth removing.
- QA/Verifier: C; audit zero, build, visual suite, root verify, exact-head CI.
- SRE/Release: C; CI already runs `npm --prefix packages/mission-control ci --ignore-scripts` and the SPA build.
- DX/Docs: C; record that no Vite 8 path was taken and why.
- Skeptic: conditional C; Vite 6 output changes could shift pixels — refuted by 12/12 visual screens at 0.000% diff. Residual: audit cleanliness is time-bound to the advisory database at run time.
- Scribe: C; R20 was marked Fixed with an exact-head CI caveat; this run reconciles it to VERIFIED_CI.

## Previous completed goal (2026-10-06): branch cleanup

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
The separate `packages/mission-control` audit remained open at that time; it was remediated by the R20 goal above (Vite 6.4.4 + `source-map-js@^1.2.2` override). No Vite 8 upgrade was performed. R16/R17 and all release gates remain closed.

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

Resume the FolderForge perpetual council on `roronoazoroshao369/FolderForge`, default branch `main`. Repository truth overrides this record. Inspect live main, open PRs, branch refs, and CI matched to the exact live SHA before any edit. The recorded baseline is main `863306eb46a4609a1f065f746ed3b94e6be20535`, run `37648701564` success 6/6; PR #46 exact-head run `37647956742` also passed 6/6 and restored clean root production/full dependency audits with `@modelcontextprotocol/sdk@1.32.1`.

R16 remains BLOCKED pending explicit approval for real Podman evidence. R17 and all external release gates remain closed. Do not tag, publish, release, retag/delete `v3.0.0`, alter branch protection or secrets, or infer Podman evidence from Docker.

Select one goal only. If exact-main CI is red, fix it first. Otherwise discover and reproduce one measurable correctness/DX issue; the CLI parser case where a value-taking flag can consume the next option token is an evidence-backed candidate, not yet a completed fix. INSPECT → RECONCILE → ONE GOAL → VERIFY → PR → MERGE ONLY IF SAFE AND EXACT-SHA CI GREEN → UPDATE STATE → emit a fresh NEXT_RUN_PROMPT → stop.
