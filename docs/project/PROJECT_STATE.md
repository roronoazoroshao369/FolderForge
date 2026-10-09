# PROJECT STATE

_Last inspected release-source commit: `7104f75f8784423ae2680a9ab80f8ac5a972eef4`; source CI `37751407631` successful (6/6 matrix jobs). Public tag, npm package and hosted release independently rechecked on 2026-10-09. This documentation change is not self-certified; check its own PR and post-merge CI before attributing verification._

## Authoritative publication snapshot (2026-10-09)

- Product: FolderForge — local-first MCP governance runtime; npm package `@musashishao/folderforge`, version `3.0.1`, npm dist-tag `latest`.
- Repository: `roronoazoroshao369/FolderForge`. Published npm `gitHead`, release tag commit and source main all map to `7104f75f8784423ae2680a9ab80f8ac5a972eef4`.
- npm package SHA-1: `a601fc004470387bfa21caf8489697ec1298fa3b`. npm SHA-512 integrity: `sha512-1NpzWEXAnN84C2p11lR+k+D+viOmVA73pQlDm/VU/Wwk+RElMWo+pqD6bhD9UWHvUQA1s3oZ+WjkAZhaeWfoyw==`. Registry tarball retrieved and byte hashes matched.
- Public annotated tag `v3.0.1`: https://github.com/roronoazoroshao369/FolderForge/releases/tag/v3.0.1 (tag object `889e845c6e0c08d11af8c2dce8a6b6eb90b99d16`; peeled commit above).
- Public GitHub Release `v3.0.1` created 2026-10-09T03:20:23Z; records manual npm publication, original changelog and explicit absent security/reliability attestations. No release assets were attached.
- Source CI `37751407631`: https://github.com/roronoazoroshao369/FolderForge/actions/runs/37751407631 — all six Ubuntu/macOS/Windows x Node 22/24 matrix jobs successful. Platform-skipped steps remain NOT_RUN.
- npm live install and CLI `folderforge 3.0.1` verified separately from a clean temporary prefix. This is not broad user acceptance.
- Publication path: operator-authorized *direct npm publish*. The repository's `publish-npm.yml` OIDC path was NOT used, and MUST NOT be re-run for already-published `3.0.1`.
- Automatic tag-push `release.yml` run `37878788439` failed at its expected exact-commit CI + production-soak gate (no passing 24-hour soak). This is a release-policy exception, not a green release workflow; security gates remain unchanged. See https://github.com/roronoazoroshao369/FolderForge/actions/runs/37878788439.
- GitHub remote branches: at source audit, only `main`. No open pull requests or issues. Branch-protection status: unprotected; no repository rulesets recorded.
- Managed isolation metadata is NOT clean: `iso_b158d434167e4eb8b283` and `iso_0e1294c275b34225a61f` report active/sourceDirty despite corresponding worktree directories being missing from disk and `git worktree list` containing only main. Do not discard/reconstruct without forensic integrity checks.

## Evidence boundary and open risk register

| Risk | Status | Required evidence |
| --- | --- | --- |
| npm publication | PUBLISHED_MANUAL | Package + registry bytes + exact source SHA verified; not an attested release |
| 24-hour exact-commit production soak | WAIVED_FOR_MANUAL_PUBLICATION / NOT_RUN | No claimed reliability certification; a future official release needs actual successful soak |
| GitHub release gate | FAILED_EXPECTED_MISSING_SOAK | `release.yml` run `37878788439` fails by design; no gate was weakened |
| Release provenance/SBOM | UNATTESTED | No original protected-workflow release bundle, GitHub build attestation or SBOM attestation for published bytes |
| Branch protection and npm publish environment | OPEN / EXTERNAL | Branch not protected; protected environment/trusted publisher configuration not verified |
| R16 real Podman and platform parity | OPEN | Native Podman rootless/mount/cgroup evidence absent; skip != pass |
| R17 beta/Danger Mode ratification | OPEN | Independent user evidence and human authorization outside code/CI |
| Isolation metadata with missing worktrees | OPEN / DATA-SAFETY | Separate approved goal, preserve sourceDirty metadata until proven safe |
| R20 | High | VERIFIED_CI | Mission Control Vite 6.4.4 / source-map-js remediation verified on CI; unchanged by this documentation update |

## Goal #57 (post-publish closure)

Publish/tag/release/source hashes were independently verified. This documentation revision reconciles public inventory and handoff. Completion of its own exact-head CI, merge to main, and post-merge CI must be observed independently before reporting Goal #57 fully complete.

## Previously inspected environment

Historical Linux host evidence included Docker/Node 22, while real Podman rootless acceptance remained NOT_RUN. R20 Mission Control dependency remediation is **VERIFIED_CI**, and remains unaffected by 3.0.1 publication.

## Historical engineering milestones (prior to the 2026-10-09 publication)

The following entries are prior checkpoint history only. Their older descriptions of branch counts, release status, and next steps are superseded by the authoritative snapshot above.

## Latest completed goal (2026-10-08): fail closed on invalid root CLI policy modes

**VERDICT** VERIFIED_CI for product PR #50, not release approval. Invalid policy names previously logged a warning then started under the configured policy; a malformed security flag can misrepresent the applied protection. RED regression: 2 failures in the new invalid-mode tests, actual exit 0 versus expected exit 1. GREEN: final PR head `1f70a77d3d59865652f03cedc5bf7b0d2e623d18`, run `37719460783`, 6/6. Post-merge main `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`, run `37720127758`, 6/6. No policy engine, workflow, dependencies, version, tag or publish action changed.

**OPEN OPERATIONS:** 8 old remote branches are not yet deleted. Live managed isolation/worktree status cannot be attested while FolderForge MCP returns 404/429. Do not delete a task branch without checking isolation ownership and uncommitted files, even when Git history is already merged. R16 Podman and R17 external release gates remain open.

## Previous completed goal (2026-10-08): reject CLI option tokens as values

**VERDICT**

PASS. Root CLI value-taking flags now reject a following flag token rather than consuming it as a value, preventing silent loss of HTTP/auth options.

| Evidence | Result |
| --- | --- |
| Reproduced code defect | `src/main.ts` next() checked only `undefined`, so `--project --http` could consume `--http` as a path |
| Regression scope | Four cases: `--project --http`, `--config --stdio`, `--token --require-auth`, `--port --http` |
| Product PR | #48, exact head `3dd88c04aacea1e74d1d04d0903e208a36f236bf`, run `37714944668`, 6/6 success |
| Merge main | `33026b16b27657544ec152e6611b644e386b6639`, exact-main run `37715608774`, 6/6 success |
| Relevant CI gates | Ubuntu/Node 22 test, coverage, build, CLI smoke, production/full dependency audits: success |
| Release gates | R16/R17 and all human/external release gates remain closed |

**SCOPE**

`src/main.ts`, `tests/unit/cli-and-doctor-regression.test.ts`, and `CHANGELOG.md` only. No CI workflow, policy, package version, or release action changed. This is product and CI evidence, not a real Podman or 24-hour release soak claim.

**NEXT INTERNAL FRONTIER**

Recheck live main and exact-SHA CI, then independently discover and reproduce one new correctness/DX gap. Do not re-open this fixed CLI token-swallowing case without new evidence. R16 requires explicit real-Podman approval; R17 remains external.

## Previous completed goal (2026-10-07): restore root dependency audit after MCP SDK advisory

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

Historical candidate at this checkpoint: the CLI value parser could consume the next flag token; this was resolved by PR #48 on 2026-10-08.

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

Resume the FolderForge council on `roronoazoroshao369/FolderForge`, default branch `main`. Repository truth overrides this handoff. Inspect live main, open PRs, branch refs and exact-main CI first. Last verified product baseline: main `228bfcd449fe9d2f16139ffd76d1d7d4d8df121e`, run `37720127758` success 6/6. Product PR #50 exact head `1f70a77d3d59865652f03cedc5bf7b0d2e623d18`, run `37719460783` success 6/6, fixed invalid CLI policy modes silently falling back.

Select exactly one new goal, prioritize red exact-main CI or safety/correctness regressions, and reproduce before implementation. Keep R16 real-Podman acceptance BLOCKED without approval; R17 and all external release gates remain closed. Do not tag, publish, release, retag/delete `v3.0.0`, change protection or secrets, or claim unrun platform gates. Follow INSPECT → RECONCILE → ONE GOAL → VERIFY → PR → MERGE ONLY IF SAFE AND EXACT-HEAD GREEN → UPDATE STATE → fresh handoff.
