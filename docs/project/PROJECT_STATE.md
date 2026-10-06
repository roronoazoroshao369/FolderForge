# PROJECT STATE

_Last updated: 2026-10-06T01:24:06Z_

## Product and repository

- Phase: 3.0.1 release-candidate hardening; external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`; default branch: `main`.
- Verified main SHA: `19b146f16b09c0a952a0251546a1a61c5fb22abe`.
- Exact-SHA main CI: `ci.yml` run `37319345745` completed success on that exact SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs succeeded. This is job/matrix evidence, not proof for skipped steps.
- PR #34 (`docs: record branch protection audit`) merged normally at this SHA. It recorded the unprotected-main finding; no repository setting or workflow was changed.
- At inspection, eight unrelated Dependabot PRs were open: #14, #15, #16, #18, #20, #21, #23, and #27. They are not council-goal PRs and require separate evaluation.
- Overall verdict: IN_PROGRESS because R16 and R17 remain open. R11–R14 are fixed historically but were not re-proved by run `37319345745`; R15 is fixed on main and its Windows/Node 22 third-party child-MCP step succeeded in that run; R18 and R19 remain fixed on main.
- This snapshot is the independently verified base for the current documentation-only reconciliation. It does not self-certify a later PR head or merge SHA. Inspect live `origin/main` and match CI to its exact SHA before the next goal.

## Earlier environment inspection (not repeated for this docs-only goal)

The prior host inspection recorded Linux `devops-HP-Z420-Workstation`, kernel `7.0.0-31-generic`, uid `1000(devops)`, Node `22.23.0`, and Docker at `/usr/bin/docker`. Podman was not on PATH; neither `/usr/bin/podman` nor `/usr/local/bin/podman` existed, Podman service/socket were inactive, and neither `/run/podman` nor `/run/user/1000/podman` was present. cgroup was `0::/init.scope`. Real Podman acceptance remained NOT_RUN; unrelated Docker fixtures are not Podman or VM-host proof. This environment snapshot is historical, not a fresh R16 probe.

## Verification truth

Exact-main run `37319345745` is green on `19b146f16b09c0a952a0251546a1a61c5fb22abe` across all six Ubuntu/macOS/Windows × Node 22/24 jobs. A successful matrix proves only steps that ran. Docker isolation on Ubuntu/Node 22 is not Podman or macOS/Windows container-runtime proof; skipped steps remain NOT_RUN, not passes.

In that exact-main run, Windows/Node 22 `Windows danger-mode regression`, `Pinned third-party child MCP compatibility`, and `Build` succeeded. The full test suite, package smoke, stdio smoke, authenticated HTTP smoke, heartbeat stress, and MCP Inspector were skipped on that job. PR #34 changed no `ci.yml` condition.

## Risk register

| ID | Severity | Status | Evidence / boundary |
| --- | --- | --- | --- |
| R11 | High | Fixed | Terminal timeout/kill reaping remains on main. |
| R12 | High | Fixed | Applicable Linux/Docker sandbox CI gate remains enabled. |
| R13 | High | Fixed | Terminal timeout, signal, and uncertain outcomes remain distinct. |
| R14 | High | Fixed | Orphan recovery and Windows npm launch fixes remain on main. |
| R15 | High | Fixed | Windows/Node 22 pinned third-party child-MCP step succeeded in exact-main run `37319345745`; skipped Windows checks remain NOT_RUN. |
| R16 | Medium | Open | Real Podman runtime evidence absent. Rootless UID/mount/cgroup behavior and VM-host portability unverified. Docker success and routing mocks are not Podman proof. |
| R17 | External | Open | At `2026-10-05T13:34:32Z`, the GitHub `main` branch protection API returned HTTP 404 `Branch not protected`, and repository rulesets were `[]`; the protection gate is unmet. Exact-release-SHA 24-hour soak, protected npm-publish environment, human Danger Mode sign-off, beta evidence, and explicit release approval remain incomplete. No settings were changed. |
| R18 | Medium | Fixed | PR #30 merged after run `37278290277` passed all six jobs on head `816a98aedd55538d8315036b1c6ada486a754bd6`. Absent Podman fails with ENOENT rather than Docker success. This does not close R16. |
| R19 | Low | Fixed | `docs/compatibility.md` now matches `ci.yml`. The generated Windows run/NOT_RUN table is locked by `tests/unit/windows-ci-claims.test.ts`, which also fails if an existing Windows gate stops running. Exact-head run `37286780402` and merge run `37287594297` succeeded. This does not create Windows full-suite evidence. |

## Latest completed goal

**GOAL**
Record exact-SHA branch-protection inspection evidence without changing repository settings.

**RESULT**
PR #34 merged at `19b146f16b09c0a952a0251546a1a61c5fb22abe`. The inspection recorded HTTP 404 `Branch not protected` for `main` and an empty repository rulesets response at `2026-10-05T13:34:32Z`; R17 remains open. The PR changed only this state document.

**VERIFICATION**
The PR reported `npm run docs:check` and `git diff --check` passing. Exact-main CI run `37319345745` passed all six matrix jobs on the merge SHA. No workflow, branch protection, repository setting, or secret was changed.

**BOUNDARY**
This audit is evidence that the protection gate was unmet at the recorded inspection time, not authorization to change it. Release gates remain closed.

## Earlier completed goal (R19)

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

## Historical local evidence for the earlier R19 goal (E2)

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

The last documented branch-protection inspection, at `2026-10-05T13:34:32Z` and recorded by PR #34, found HTTP 404 `Branch not protected` for `main` and `[]` repository rulesets in the authenticated API context. R17 remains unmet. No settings were changed, and this result does not authorize a settings change.

The 24-hour exact-release-SHA soak, protected npm-publish environment, Danger Mode sign-off, beta evidence, and explicit `v3.0.1` tag/npm publish/GitHub Release approval also remain outstanding. Never retag or delete `v3.0.0`.

## NEXT_RUN_PROMPT

Resume the FolderForge perpetual council on the real repository `roronoazoroshao369/FolderForge`, default branch `main`, under the stable council policy. Repository truth overrides this snapshot. At this inspection the verified base was `19b146f16b09c0a952a0251546a1a61c5fb22abe`, with exact-SHA `ci.yml` run `37319345745` green across all six jobs. PR #34 is merged. Eight unrelated Dependabot PRs (#14, #15, #16, #18, #20, #21, #23, #27) were open at inspection; do not mistake them for council work.

Read `docs/project/PROJECT_STATE.md`, `docs/PROJECT_STATUS.md`, `docs/CURRENT_FRONTIER.md`, `CHANGELOG.md`, and `docs/HANDOFF.md`. Inspect git status, fetch `origin/main`, inspect `gh run list`, and match CI to the exact live SHA before editing or asserting status. This snapshot does not certify the current documentation PR's future head or merge SHA.

R11–R14 remain Fixed historically but were not re-proved in run `37319345745`; R15, R18, and R19 are Fixed on main. R16 and R17 remain Open. The last branch-protection inspection (PR #34; `2026-10-05T13:34:32Z`) found HTTP 404 `Branch not protected` and no repository rulesets. Do not repeat that audit without new evidence, and do not change protection or settings. Windows full-suite, package, stdio, HTTP, heartbeat, and Inspector checks remain NOT_RUN; do not reopen R19 unless `docs/compatibility.md` and `ci.yml` diverge.

For the next goal, use one evidence gap only: run real Podman acceptance only when a target engine, digest-pinned image, user, mount, and cgroup context exist; otherwise select one separately authorized R17 evidence gap. Do not install a runtime, substitute Docker or mocks, expand or skip CI gates, or claim external release readiness from green CI.

Human gates remain closed: 24-hour exact-release-SHA soak, branch protection, protected `npm-publish` environment, Danger Mode sign-off, beta evidence, `v3.0.1` tag, npm publish, and GitHub Release. Do not tag, publish, release, retag/delete `v3.0.0`, change protection or secrets, or cancel workflows without explicit approval. Continue INSPECT → RECONCILE → ONE GOAL → VERIFY → PR → MERGE ONLY IF ACCEPTANCE AND EXACT-SHA CI ARE GREEN AND IT IS SAFE → UPDATE PROJECT_STATE → emit a new NEXT_RUN_PROMPT → stop.
