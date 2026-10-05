# PROJECT STATE

_Last updated: 2026-10-05T07:26:02Z_

## Product and repository

- Phase: 3.0.1 release-candidate hardening; external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`; default branch: `main`.
- Verified main baseline SHA: `aa8c5e97683ccde5b2a8aefac4b99b21c0fd08ed`.
- Baseline main CI: run `37275833749` completed success on that exact SHA; all six Ubuntu/macOS/Windows × Node 22/24 jobs succeeded.
- PR #29 is merged; its head `5d901a99fba690bec7ffafad5cebd115b98a2c6f` is an ancestor of main. The clean local checkout was still on its branch at resume; no unexpected changes were present.
- Council branch: `council/podman-smoke-selection`, created from `origin/main` without touching old branches or worktrees.
- Phase: PR/exact-head CI; verdict: IN_PROGRESS. Resolve the current goal PR with `gh pr list --head council/podman-smoke-selection`; no merge is attested by this pre-merge record.

## Verification truth

Baseline CI proves only steps that ran. Docker isolation on Ubuntu/Node 22 is not Podman or macOS/Windows container-runtime proof. Windows matrix jobs also skip the general full-test and package/stdio/HTTP smoke steps.

Environment inspected: Linux, Node `22.23.0`, Docker available; Podman absent from PATH. On unchanged baseline code, requesting `FOLDERFORGE_SANDBOX_RUNTIME=podman` with the locally present pinned Python image makes `npm run smoke:sandbox` exit 0 and report `runtime: docker`. Log: `.folderforge-ci/podman-smoke-selection/baseline-routing.log`; exit file: `baseline-routing.exit`. This is E2 reproduction of wrong-runtime selection, NOT Podman isolation evidence.

## Risk register

| ID | Severity | Status | Evidence / boundary |
| --- | --- | --- | --- |
| R11 | High | Fixed | Prior terminal timeout/kill reaping implementation and exact-main CI remain on main. |
| R12 | High | Fixed | Applicable Linux/Docker sandbox CI gate remains enabled. |
| R13 | High | Fixed | Terminal timeout, signal, and uncertain outcomes remain distinct. |
| R14 | High | Fixed | Orphan recovery and Windows npm launch fixes remain on main. |
| R15 | High | Fixed | Windows/Node 22 third-party child-MCP step succeeded in baseline run `37275833749`. |
| R16 | Medium | Open | Real Podman runtime evidence absent; rootless UID/mount/cgroup behavior and VM-host portability unverified. |
| R17 | External | Open | Exact-release-SHA 24-hour soak, protection/environment confirmation, human Danger Mode sign-off, and beta evidence incomplete. |
| R18 | Medium | Fixed locally / CI pending | Wrong-runtime selection reproduced before fix; eight routing regressions now pass and actual absent-Podman invocation fails with ENOENT rather than Docker success. Exact-head CI still required. |
| R19 | Low | Open / backlog | `docs/compatibility.md` says every matrix job runs full tests and package/stdio/HTTP smoke; `ci.yml` skips these on Windows. Out of this smoke-selection goal; no Windows full-suite claim is accepted. |

## Primary goal contract

**GOAL**
Make the existing sandbox child-MCP smoke honor the same Docker/Podman environment selector as terminal runtime tests, reject unsupported selections before launch, and report the engine actually selected.

**WHY NOW**
The smoke silently tests Docker when the operator requests Podman. This can contaminate release evidence even though successful JSON currently labels Docker.

**SCOPE FILES**
- `.github/workflows/ci.yml` (routing-only focused suite in all six jobs)
- `scripts/smoke-sandbox.mjs`
- `tests/unit/smoke-sandbox.test.ts`
- `docs/sandbox.md`, `CHANGELOG.md`
- State/status/frontier/handoff reconciliation and proposal 024.

**NON-GOALS**
No product tool, CLI, route, MCP API, dependency, version, or containment-flag change. No runtime installation, tag, publish, release, protection, secrets, environment changes, or workflow cancellation. No claim of real Podman isolation from mocked routing tests or Docker success.

**ACCEPTANCE CRITERIA**
1. Regression tests fail before the fix, then pass: absent selection defaults to Docker; explicit Docker/Podman map to generated adapter mode AND success-report runtime; invalid/process/empty selections exit before transport launch; prerequisite instructions name the selected engine; temporary project is removed.
2. Linux/Node 22 with Podman absent and Docker present: requesting Podman with the pinned Python image fails and cannot produce Docker success; default/explicit Docker boundary smoke exits 0.
3. Typecheck, lint, architecture, docs, focused tests, real Docker terminal runtime tests, clean-env full verify, relevant stdio/HTTP smokes, and high-level audit exit 0 with logs.
4. Exact pushed PR head passes all six CI jobs; before merge confirm unchanged main base and no unresolved acceptance failures. Merge only under the user's conditional safe-merge authorization, without bypass.
5. R16/R17 remain open, and evidence explicitly separates routing-only mocks, Docker containment, missing-Podman failure, and future real Podman acceptance.

**ROLLBACK**
Revert the scoped commit or close the PR before merge. No data/config migration.

## Council decision

Options: A — do nothing (reject: preserves reproducible wrong-runtime testing); B — install/run Podman or add a new Podman CI matrix now (defer: engine unavailable locally, rootless mapping/host assumptions expand scope); C — correct existing smoke selection with regression and environment-specific no-fallback evidence (selected).

- Architect: C; reuse the existing environment selector, no new product surface.
- Security/Red-team: C; allow only Docker/Podman and reject before launch, retain all isolation flags.
- QA/Verifier: C; require red/green config-plus-report tests and a real Docker-present/Podman-absent negative check.
- SRE/Release: C; exact-head CI required; keep Podman runtime certification open.
- DX/Docs: C; engine-specific prerequisite text and evidence boundaries.
- Skeptic: conditional C; mocked protocol can prove only routing. Reject any closure of R16 without real Podman commands and exact-SHA evidence.
- Scribe: C; reconcile the stale baseline and persist the goal/evidence honestly.

These are role/hat reviews by one agent, not independent human ratification.

## External human gates still closed

24-hour exact-release-SHA soak; branch protection; protected npm-publish environment; Danger Mode sign-off; beta evidence; explicit `v3.0.1` tag/npm publish/GitHub Release approval. Never retag/delete `v3.0.0`.

## Current evidence and next step

E1: repository/code/workflow inspection. E2: unchanged smoke ignores requested Podman (exit 0, Docker result). E3: baseline main run `37275833749`, not future branch proof.

Red suite exited 1 with 5 failed / 3 passed (8 total); log `.folderforge-ci/podman-smoke-selection/red.log`. The smallest fix now validates the selector and uses it for config/report/guidance. Ordered local verification is complete. Next: scoped commit/PR, exact-head CI, conditional merge, and final state handoff. No new goal in this run.

## Local verification for this goal (E2, pre-commit tree)

Environment: Linux, Node 22.23.0, real Docker; Podman absent. Logs and numeric exit files are under `.folderforge-ci/podman-smoke-selection/`; structured summary: `verification.json`.

| Check / command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | PASS |
| `npm run lint` | 0 | PASS |
| `npm run architecture:check` | 0 | PASS |
| `npm run docs:check` | 0 | PASS |
| `npx vitest run tests/unit/smoke-sandbox.test.ts tests/unit/sandbox-launcher.test.ts` | 0 | 17 passed; smoke protocol is mocked/routing-only |
| `FOLDERFORGE_SANDBOX_RUNTIME=docker FOLDERFORGE_REQUIRE_RUNTIME_TESTS=1 npx vitest run tests/integration/sandbox-runtime.test.ts` (pinned Alpine image) | 0 | 18 passed; real Docker terminal containment |
| clean-env `npm run verify` | 0 | 146 files; 1198 passed, 14 skipped; includes production build |
| default and explicit Docker `npm run smoke:sandbox` (pinned Python image) | 0 each | Real child-MCP boundary PASS |
| explicit Podman `npm run smoke:sandbox` (same pinned Python image, Podman absent) | 1 expected | Negative acceptance PASS: `spawn podman ENOENT`, no success JSON / Docker fallback |
| `npm run smoke:stdio` / `npm run smoke:http` | 0 each | PASS |
| `npm audit --audit-level=high` | 0 | PASS |

Pinned images: Python `python@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df`; Alpine `alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc`. No auto-pull was performed. `docker ps --filter name=folderforge-term-` found no remaining terminal test containers. Diff whitespace check passed. Secret scan found only 17 high-entropy platform-label/path/test-name false positives, individually reviewed; no real secrets identified.

Blast-radius review: `scripts/run-release-check.mjs` invokes the same smoke; CI and package-compatibility assertions still preserve the real Docker boundary step. No release command was executed. Existing selectors/default behavior are retained; only explicit Podman/unsupported smoke selection changes. R19 is backlog, not silently fixed in this goal.

## Delivery boundary

The committed state cannot attest a future CI run for its own content or know its future merge SHA. The exact PR head and eventual main SHA/run must be inspected live before merge/resume; the chat handoff records the observed delivery result. Baseline SHA above is intentionally labeled a verified baseline, not a claim that it will remain current main.
