# HANDOFF — after FolderForge 3.0.1 npm publication

_Updated 2026-10-09 from independent public npm/GitHub observations. Exact release-source SHA `7104f75f8784423ae2680a9ab80f8ac5a972eef4` has CI `37751407631` SUCCESS 6/6 jobs. This closeout document must not self-certify its own PR or eventual merge._

## Current snapshot

- Release-source CI: `37751407631` SUCCESS 6/6 matrix jobs, subject to documented platform skips.
- R20 Mission Control security dependency remediation: **VERIFIED_CI**; unaffected by manual npm publication.

## Source of truth

- Repository: `roronoazoroshao369/FolderForge`; default branch `main`.
- npm `@musashishao/folderforge@3.0.1` exists, `latest=3.0.1`; npm `gitHead` and annotated public `v3.0.1` both resolve to `7104f75f8784423ae2680a9ab80f8ac5a972eef4`.
- npm immutable tarball SHA-1 `a601fc004470387bfa21caf8489697ec1298fa3b`; SHA-512 `sha512-1NpzWEXAnN84C2p11lR+k+D+viOmVA73pQlDm/VU/Wwk+RElMWo+pqD6bhD9UWHvUQA1s3oZ+WjkAZhaeWfoyw==`; downloaded package bytes verified. Disposable npm install and CLI version smoke passed.
- GitHub Release: https://github.com/roronoazoroshao369/FolderForge/releases/tag/v3.0.1 — release notes disclose operator-authorized manual publish without 24h soak or OIDC/SBOM attestation.
- Automated tag-push release workflow `37878788439` failed due to its intact CI+soak hard gate; it is NOT passing release certification. Do not dispatch `publish-npm.yml` for this already-published version.
- The exact source CI `37751407631` passed six matrix jobs; platform-specific skipped steps are NOT_RUN.
- Main remote had no other branches before documentation PR. Current two FolderForge managed-isolation records are stale/active/sourceDirty with missing worktrees; do not discard.

## Read first

- `docs/project/PROJECT_STATE.md` for release provenance and history.
- `docs/PROJECT_STATUS.md` and `docs/CURRENT_FRONTIER.md` for current risk and next goal.
- `docs/project/RELEASE_3_0_1_MANUAL_PUBLICATION.md` for the exact manual release exception.

## Release exception and open gates

No verified passing 24-hour exact-commit soak; no protected npm-publish environment/OIDC proof; no attestations tied to published package; GitHub main unprotected; R16 real Podman runtime verification, R17 Danger Mode human sign-off and independent beta remain open. Do not claim production certification, runtime reliability, marketplace safety, or complete Windows/macOS test coverage. Version `v3.0.0` was abandoned and must not be rewritten.

## Next primary goal — #58 Isolation Lifecycle Recovery

Inspect **live** main/CI/branches and `docs/project/PROJECT_STATE.md` before acting; this handoff may be stale. Objective: reproduce discrepancy between FolderForge `isolation_list` active/sourceDirty records and missing managed worktree directories, identify ownership and recoverability before any change, define fail-closed repair semantics, obtain the required Superpowers approvals, and implement red→green lifecycle tests. Do not remove user data or stale metadata speculatively. Keep a single primary goal, exact-head tests/CI, verified product PR, post-merge CI and documentation closeout; clean temporary remote branches only after preserving work.

## Goal #57 verification protocol

After documentation PR completion, inspect actual PR-head and post-merge CI; report both SHAs and run IDs in the human handoff. The source CI shown above does not prove changes made by the documentation PR. Verify remote main-only branch hygiene after PR merge. Re-check npm dist-tags, tag peel, GitHub Release body, assets, and exact tarball integrity; keep direct manual publication classified honestly.
