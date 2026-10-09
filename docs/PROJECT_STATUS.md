# PROJECT STATUS

_Last verified 2026-10-09. Authoritative source release commit: `7104f75f8784423ae2680a9ab80f8ac5a972eef4`. This document's PR requires its own independent exact-head CI; the source CI is not evidence for documentation edits._

## Publication state

| Field | Verified status |
| --- | --- |
| npm | `@musashishao/folderforge@3.0.1` is public and `latest` |
| npm source `gitHead` | `7104f75f8784423ae2680a9ab80f8ac5a972eef4` |
| npm SHA-1 | `a601fc004470387bfa21caf8489697ec1298fa3b` |
| npm SHA-512 | `sha512-1NpzWEXAnN84C2p11lR+k+D+viOmVA73pQlDm/VU/Wwk+RElMWo+pqD6bhD9UWHvUQA1s3oZ+WjkAZhaeWfoyw==` |
| GitHub tag | annotated `v3.0.1`, peeled commit matches npm |
| GitHub Release | https://github.com/roronoazoroshao369/FolderForge/releases/tag/v3.0.1 |
| Exact-source CI | `37751407631` SUCCESS 6/6 jobs (skipped steps NOT_RUN) |
| Release tag workflow | `37878788439` FAILURE at required 24-hour soak evidence |
| Publish path | Direct npm CLI, manually authorized; NOT protected trusted npm OIDC |
| Signed bundle/SBOM attestations | NOT PRESENT for the exact published artifact |
| GitHub branches | Main only at source audit; temporary docs branch exists during closeout |
| Open PR/issue count at source audit | 0 / 0 |
| Security governance | Branch protection absent, Podman evidence absent, no human beta/Danger Mode sign-off |

Registry tarball hashes were independently recomputed from newly downloaded bytes; installation under a disposable prefix and CLI `folderforge 3.0.1` succeeded. These checks establish package accessibility and entrypoint operation, not complete product or platform readiness.

## Operator-authorized release exception

On 2026-10-09, version 3.0.1 was manually published without a passing 24-hour production soak. Tag push subsequently triggered the unchanged `release.yml` hard gate and run `37878788439` failed at the soak requirement. The missing gate must not be described as passed or waived for future releases. Never rerun `publish-npm.yml` for an already-published immutable npm version. Do not backfill or fabricate SBOM, provenance, or soak attestations for this package.

## Product maturity

Current local governance, policy, audit and child MCP paths remain **beta / locally hardened**, not production-certified. R20 Mission Control dependency remediation is **VERIFIED_CI** (Vite 6.4.4 and patched source-map-js); this does not certify production readiness. Mission Control/Fleet is locally verified; distributed workers and marketplace remain Labs. R16 Podman, R17 external checks, and the two stale managed-isolation entries remain open.

## G58 implementation and next goal

G58 product PR [#60](https://github.com/roronoazoroshao369/FolderForge/pull/60) merged as `948feb34614bb66bb1bfb8170f6f7c2cbed3284b`, with product exact-head `a0ff768b6087abe1822a1a41d1926edce37e3f3c`, PR CI `37955610544` SUCCESS 6/6 and push CI `37955602053` SUCCESS 6/6. Exact-main CI `37956471711` verified SUCCESS 6/6 on product merge SHA `948feb34614bb66bb1bfb8170f6f7c2cbed3284b`: G58 product closed. This documentation PR's exact-head/post-merge CI remain separate checks. G58 adds truthful missing-worktree health and refuses unsafe mutations; it **did not reconstruct** either historical missing/sourceDirty isolation worktree. Metadata SHA-256 is unchanged: `47a189d85d05c4ef651886679cbf9e4e34be6d552f8a162a42e180441e0f4074`.

**Next after verified G58 closeout: G59 design/spec discovery** for legacy/modern MCP protocol compatibility. G59 implementation is not approved. See `docs/HANDOFF.md`, `docs/CURRENT_FRONTIER.md`, and `docs/project/GOAL58_ISOLATION_EVIDENCE.md` for authoritative engineering gates and limitations. Historical roadmap text is not current release truth.
