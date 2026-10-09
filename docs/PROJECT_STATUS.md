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

## Next goal and source of truth

**Goal #58 — Isolation Lifecycle Recovery:** reconcile two active, source-dirty isolation records whose worktree directories do not exist; prove non-destructive recovery and truthful status with red/green regression coverage before any cleanup. Follow `docs/HANDOFF.md` and `docs/CURRENT_FRONTIER.md`. Prior engineering history is retained in `docs/project/PROJECT_STATE.md`. Historical roadmap text is not current release truth.
