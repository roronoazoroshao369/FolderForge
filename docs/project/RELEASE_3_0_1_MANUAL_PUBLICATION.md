# FolderForge 3.0.1 — manual npm publication evidence

**Observed:** 2026-10-09 UTC. **Classification:** PUBLIC / MANUAL / NOT_ATTESTED. This is not a protected-workflow green release.

## Immutable public evidence

| Artifact | Observed identity |
| --- | --- |
| npm | `@musashishao/folderforge@3.0.1`, dist-tag `latest` |
| Registry source `gitHead` | `7104f75f8784423ae2680a9ab80f8ac5a972eef4` |
| Registry package SHA-1 | `a601fc004470387bfa21caf8489697ec1298fa3b` |
| Registry SHA-512 | `sha512-1NpzWEXAnN84C2p11lR+k+D+viOmVA73pQlDm/VU/Wwk+RElMWo+pqD6bhD9UWHvUQA1s3oZ+WjkAZhaeWfoyw==` |
| GitHub annotated tag object | `889e845c6e0c08d11af8c2dce8a6b6eb90b99d16` |
| Tag peeled source SHA | `7104f75f8784423ae2680a9ab80f8ac5a972eef4` |
| GitHub Release | https://github.com/roronoazoroshao369/FolderForge/releases/tag/v3.0.1 |
| Exact-source matrix CI | https://github.com/roronoazoroshao369/FolderForge/actions/runs/37751407631 — SUCCESS 6/6 jobs |
| Auto release workflow | https://github.com/roronoazoroshao369/FolderForge/actions/runs/37878788439 — FAILURE at production-soak gate |
| GitHub Release assets | 0; no signed release bundle or SBOM attached |

The published npm tarball was re-downloaded and its SHA-1 / SHA-512 recalculated, matching registry metadata. A new temporary-prefix installation ran `folderforge --version` and printed `folderforge 3.0.1`. Source `gitHead` and annotated tag peel independently agree. Neither npm metadata nor the download hash constitutes an independent supply-chain attestation.

## Explicit exception and limitations

The maintainer explicitly authorized publishing 3.0.1 directly to npm, without the 24-hour production soak. The already-published package cannot be republished under the same version by `publish-npm.yml`. GitHub `release.yml` remains unchanged: on tag push it failed the required soak verification. The GitHub Release was manually created only to document the immutable package and the unfulfilled release conditions; it must not be represented as the green protected-workflow release.

No exact-source 24-hour active soak, protected npm OIDC publication, signed GitHub build attestations, SBOM attestation, release bundle/SHA256SUMS asset or third-party security validation was established for the published tarball. Do not invent, backdate or silently substitute evidence. All later versions use the normal gated process unless explicitly and transparently authorized otherwise.

## Verification after documentation merge

This evidence is tied to the pre-merge release commit. The docs change does not alter the published source or npm package. Verify the documentation PR exact-head and post-merge main CI independently, then reconcile the next handoff. Branch protection, trusted npm publish environment, human Danger Mode sign-off, independent beta and real Podman portability remain external/open work.
