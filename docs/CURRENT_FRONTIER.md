# CURRENT FRONTIER

_Last release/source verification: 2026-10-09. Release-source `7104f75f8784423ae2680a9ab80f8ac5a972eef4`, CI `37751407631` PASS 6/6 matrix jobs. New documentation commits need independent exact-head and post-merge CI._

## P0 — Release baseline and G58 implementation

- Goal #57 is **CLOSED**: `@musashishao/folderforge@3.0.1` was published manually and reconciled with public annotated `v3.0.1` tag and GitHub Release. Docs PR #57 merged to main `3337d714f8d75c9e7586f99c5a37b3f446141116`; post-merge CI `37880351065` passed 6/6 jobs. Manual publication lacks exact-source 24-hour soak and protected OIDC/SBOM attestations; tag release workflow failure `37878788439` remains truthful and security gates unchanged.
- User approved **Trusted Agent Development Workstation** North Star, spec PR #58 and G58 implementation plan PR #59. Plan merge baseline: `da736f0c84fa1f49fc53bf27654f398068a3aaa1`, CI `37891430646` SUCCESS 6/6.
- **G58 implementation under verification on feature branch `feat/g58-isolation-health`**: read-only physical health separated from persisted state, stable governed errors, fail-closed mutation preflight, expected-SHA branch delete, truthful Mission Control UX and forensic inventory. Local tests and task-specific reviews passed, but no GitHub product PR exact-head CI or post-merge main gate is claimed in this document.
- Two historical isolations remain `active/sourceDirty` with missing physical worktrees and refs. Their state file hash was preserved; no historical restore/discard, branch deletion or metadata mutation performed. See [the non-destructive forensic evidence](project/GOAL58_ISOLATION_EVIDENCE.md).
- **Next after verified G58 merge:** G59 MCP protocol modernization (2025-11-25 legacy and 2026-07-28 modern conformance). Its epic charter is **not** an approved implementation plan.

## P1 — Adoption and compatibility proof

- Independently install `3.0.1` from npm on Linux, macOS and Windows (Node 22 and 24), run `doctor`, first real MCP tool task, authenticated HTTP and actual client connection.
- Existing exact-source CI has 6 successful jobs; Windows and several macOS jobs skip full-suite/security/package checks. Skips remain NOT_RUN. Preserve an accurate platform matrix.
- Collect human onboarding and incident-exercise evidence; use `docs/beta-program.md` and `docs/maturity-and-proof.md`.

## P1 — Security and release governance

- R16 real Podman rootless UID/mount/cgroup verification remains open. Docker and routing mocks are not Podman proof.
- R17 branch protection, protected npm-publish GitHub environment, trusted-publisher setup, Danger Mode human sign-off and external beta remain open.
- For *future* releases, preserve exact-commit soak, immutable SBOM/provenance and OIDC protected publishing. A manually published historical package cannot retroactively acquire a passing workflow receipt.

## P1 — Mission Control dependency audit

R20 is **VERIFIED_CI** for the Vite 6.4.4 / source-map-js security remediation, supported by independent exact-head and post-merge matrix CI. No pending R20 claim remains; future dependency advisory drift requires a fresh reproduction.

## P2 — External release evidence

The 3.0.1 manual publication explicitly did NOT meet the 24-hour active soak / protected npm OIDC / SBOM-attestation gates. Those remain mandatory for the standard future-release process; do not retroactively label them passed. Podman acceptance and independent beta are also open.

## P2 — UX and footprint after stabilization

- Test Mission Control/Fleet onboarding on clean machines and representative clients.
- Review the published tarball's generated dashboard assets for cumulative, unused hashed bundles. Any cleanup must be proven against the pack/install/visual regression suite in a NEW patch release, not in 3.0.1.
- Treat distributed coordination and marketplace as Labs until external gates are satisfied.

## Decision rule

One primary goal per iteration. Prioritize red exact-main CI, reproducible data/security risk, false platform claims, measured correctness/DX, then feature scope. Require Superpowers discovery, appropriate approval stage, TDD for behavior changes, exact-head CI before PR merge, post-merge main verification, and removal of completed *temporary* remote branches. Never automatically destroy sourceDirty isolation metadata or claim skipped tests as passed.
