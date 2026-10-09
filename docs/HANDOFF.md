# HANDOFF — G58 managed isolation integrity product merged (2026-10-09)

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

## G58 product delivery — verified evidence and remaining closeout

- Approved design PR #58 and implementation plan PR #59; original main baseline `da736f0c84fa1f49fc53bf27654f398068a3aaa1`.
- Product PR [#60](https://github.com/roronoazoroshao369/FolderForge/pull/60) **MERGED**: final head `a0ff768b6087abe1822a1a41d1926edce37e3f3c`, PR-head CI `37955610544` SUCCESS 6/6, push CI `37955602053` SUCCESS 6/6, merge commit `948feb34614bb66bb1bfb8170f6f7c2cbed3284b`.
- Final local verification: `npm run verify` 151/151 test files, 1263 PASS, 14 SKIP. `npm run smoke:stdio`, `npm run smoke:http`, `npm run docs:check`, `npm run architecture:check`, Mission Control build, diff check PASS. Reviewer SPEC/QUALITY PASS; macOS path alias and crash/restart rollback recovery regressions added. Platform CI skips remain NOT_RUN.
- Post-merge exact-main CI `37956471711` verified SUCCESS 6/6 on `948feb34614bb66bb1bfb8170f6f7c2cbed3284b`: **G58 product delivery closed**. This documentation branch and its merge still require fresh exact-head and post-merge CI. CI of the product head cannot certify a later documentation SHA. CI of the previous head cannot certify a later documentation SHA.
- Live historical forensic check: two `active/sourceDirty` records (`iso_b158d434167e4eb8b283`, `iso_0e1294c275b34225a61f`) still have missing task worktrees and refs; recorded base commits are readable. `.git/folderforge/isolations.json` SHA-256 `47a189d85d05c4ef651886679cbf9e4e34be6d552f8a162a42e180441e0f4074` unchanged after merge. Do **not** prune, discard, rollback or try to reconstruct historical uncommitted/untracked bytes. G58 provides truthful health and fail-closed operations, not actual data recovery.
- **Branch cleanup safety:** source feature worktree contains ignored `.omc` session/project-memory and `.superpowers/sdd` review/ledger artifacts. Do not `git clean` or force-remove the local worktree, even though Git status is clean. Only delete a merged remote feature ref after verifying main contains the head; preserve local evidence.
- No npm publish/tag, release, production soak certification or future G59 implementation is part of this closeout.

## Next program goal after G58

**G59 — MCP Protocol Compatibility Assessment / Modernization**, not yet approved for product implementation. Inspect live main first. Write a focused compatibility design against `2025-11-25` and `2026-07-28` before coding, preserve old clients and security boundary, gather actual conformance evidence. Do not start G59 until G58 product and documentation closeout are independently verified.

## Goal #57 verification protocol

After documentation PR completion, inspect actual PR-head and post-merge CI; report both SHAs and run IDs in the human handoff. The source CI shown above does not prove changes made by the documentation PR. Verify remote main-only branch hygiene after PR merge. Re-check npm dist-tags, tag peel, GitHub Release body, assets, and exact tarball integrity; keep direct manual publication classified honestly.
