# PROJECT STATE

_Last updated: 2026-10-05T06:42:55Z_

## Product and repository

- Phase: 3.0.1 release-candidate hardening; external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`.
- Default branch: `main`.
- Current main SHA: `f9a6e32a6ab48db929682bc1662232021df5c96e`.
- Main CI: **green** — `ci.yml` run `37272090032` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs on that exact SHA.
- Council branch: `docs/reconcile-green-main` from the current main SHA.
- Council PR: `https://github.com/roronoazoroshao369/FolderForge/pull/29`; current committed head before this state update: `4a1d6334888774323dcbc01ee850be0ae33281ae`. This state update must be included in the final exact head verified by CI.

## Verification truth

- Exact main SHA `f9a6e32a6ab48db929682bc1662232021df5c96e` matches `origin/main`; the working tree was clean at resume.
- Run `37272090032` completed success for Ubuntu, macOS, and Windows on Node 22 and 24.
- The Windows/Node 22 pinned third-party child-MCP step ran successfully; PR #28 is merged. R15 is therefore fixed on main.
- Platform-specific skipped steps are not treated as evidence for those platforms. In particular, container-runtime isolation remains Linux/Docker evidence, not macOS, Windows, or Podman evidence.
- Local verification for this documentation-only branch passed: `typecheck`, `lint`, `architecture:check`, `docs:check`, clean-env `npm run verify`, and `npm audit --audit-level=high` all exited 0.
- Broken: no known Critical or High defect is established in this goal. Release certification remains blocked by external human gates and unverified Podman claims where applicable.

## Risk register

- **R11 — Fixed:** terminal containers are reaped after timeout/process kill; implementation and prior exact-SHA CI evidence are on main.
- **R12 — Fixed:** the sandbox boundary CI gate is present and runs on the applicable Linux job.
- **R13 — Fixed:** terminal outcomes distinguish timeout, signal, and uncertain results.
- **R14 — Fixed:** Windows npm launch uses `node` plus `npm-cli.js`.
- **R15 — Fixed:** main run `37272090032` proves the Windows/Node 22 pinned third-party child-MCP check succeeds on SHA `f9a6e32a6ab48db929682bc1662232021df5c96e`.
- **R16 — Open:** no current Podman runtime evidence was established by this run; documentation and release decisions must not infer Podman parity from Docker CI.
- **R17 — Open:** release-level human evidence is incomplete: 24-hour exact-SHA soak, branch protection, protected npm-publish environment, Danger Mode sign-off, and beta evidence.

## Current frontier

Reconcile stale release-status documents to the green exact-main evidence without calling skipped platform checks passes or claiming external release readiness. After that, the highest-value engineering frontier is an evidence-backed audit of claimed Podman and cross-platform sandbox coverage that adds no public surface.

## Primary goal contract

**GOAL**  
Reconcile `PROJECT_STATE`, `PROJECT_STATUS`, `CURRENT_FRONTIER`, and `HANDOFF` with the merged green main SHA and its exact-SHA CI evidence.

**WHY NOW**  
The repository and main CI are green, but the durable status documents still say main is red or the candidate is uncommitted. That drift could cause a false release decision.

**SCOPE FILES**
- `docs/project/PROJECT_STATE.md`
- `docs/PROJECT_STATUS.md`
- `docs/CURRENT_FRONTIER.md`
- `docs/HANDOFF.md`

**NON-GOALS**
- No code, dependency, public tool, CLI command, route, or MCP API change.
- No tag, npm publish, GitHub Release, branch-protection, secret, environment, or workflow cancellation.
- No claim that skipped CI steps or Docker evidence prove macOS, Windows, or Podman behavior.

**ACCEPTANCE CRITERIA**
1. All four files identify main SHA `f9a6e32a6ab48db929682bc1662232021df5c96e` and run `37272090032` as green exact-SHA evidence.
2. Stale claims that main is red, the candidate is uncommitted, or exact-SHA cross-platform CI is unavailable are removed.
3. External human gates and unverified Podman evidence remain explicitly open.
4. `typecheck`, `lint`, `architecture:check`, `docs:check`, clean-env `npm run verify`, and `npm audit --audit-level=high` exit 0.
5. The exact pushed PR head passes required `ci.yml` jobs before any merge.

**TEST PLAN**  
Run text drift checks, then the ordered repository gates. Review the diff for over-claims and secrets, push a single documentation commit, and verify CI for the exact PR head.

**SECURITY IMPACT**  
No runtime change. The security benefit is preventing false release certification; the main risk is over-claiming skipped or platform-inapplicable checks.

**ROLLBACK**  
Revert the documentation commit or close the PR before merge.

**NEEDS HUMAN APPROVAL:** no.

## Council decision

CI/release and documentation-drift lenses require correction now. Security vetoes wording that equates a successful matrix job with every skipped platform-specific step passing. Portability requires Podman remain unverified. The smallest adequate option is a four-file documentation reconciliation with no runtime or public-surface change.

## External human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

## Verification evidence for this goal

Local gates on branch `docs/reconcile-green-main`: `typecheck` exit 0; `lint` exit 0; `architecture:check` exit 0 (`files=135`, `cycles=0`, `violations=0`); `docs:check` exit 0 (102 Markdown files); clean-env `npm run verify` exit 0 (145 test files, 1190 passed, 14 skipped); `npm audit --audit-level=high` exit 0 with 0 vulnerabilities. Before merge, GitHub Actions must show `ci.yml` completed success for the current PR head; the committed file cannot self-attest a future run for its own SHA. Main baseline: run `37272090032` completed success at `f9a6e32a6ab48db929682bc1662232021df5c96e` with six successful matrix jobs.

## Next candidate goal

Audit claimed Podman and cross-platform sandbox coverage against executable checks and current documentation; close one reproducible evidence gap without adding public surface.
