# CURRENT FRONTIER

_Last release/source verification: 2026-10-09. Release-source `7104f75f8784423ae2680a9ab80f8ac5a972eef4`, CI `37751407631` PASS 6/6 matrix jobs. New documentation commits need independent exact-head and post-merge CI._

## P0 — Goal #57: 3.0.1 post-publish closure

- npm `@musashishao/folderforge@3.0.1` is public (`latest`); registry tarball hashes match.
- GitHub annotated tag and hosted Release `v3.0.1` exist and bind to the same source commit.
- Manual publish lacked 24-hour soak and OIDC attestation/SBOM evidence; automatic tag-push `release.yml` run `37878788439` failed at the soak gate as designed. No gate changed. Never republish immutable version 3.0.1.
- Public inventory, governance docs, handoff and explicit release exception are being reconciled in the documentation PR. Do not mark Goal #57 complete until exact-head CI, merge and post-merge CI are independently verified.

## P0 — Goal #58: Managed isolation lifecycle reconciliation (next technical goal)

Two records (`iso_b158d434167e4eb8b283` / `iso_0e1294c275b34225a61f`) remain active/sourceDirty while their worktree roots are missing and Git reports only the main worktree. Start with read-only inventory and reproducible failure, not deletion. Design a fail-closed, non-destructive state reconciliation path, cover missing worktree / dirty source / branch missing / restart cases, preserve audit evidence and recovery options, and verify with TDD. Do not silently discard human work.

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
