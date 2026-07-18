# Release process

**Audience:** Maintainers.

FolderForge releases are gated by executable evidence. Source review or a local
build alone is not release evidence.

## Sources of truth

- `package.json` is the package and CLI version source.
- `package-lock.json` must match the root package version.
- `CHANGELOG.md` must contain a non-empty heading for that version; its exact
  section body is the canonical hosted-release note source. `[Unreleased]`
  contains only changes not yet published.
- Git tags, GitHub Releases, and npm dist-tags are public distribution state and
  must be checked independently. None is inferred from another.

The current public state can be inspected with:

```bash
node -p "require('./package.json').version"
npm view @musashishao/folderforge version dist-tags --json
git ls-remote --tags origin
gh release list --repo roronoazoroshao369/FolderForge
```

## Required local gate

```bash
npm ci --ignore-scripts
npm run release:check
npm pack --dry-run

git diff --check
```

`release:check` runs typecheck, lint, unit/integration tests, build,
documentation/version/link checks, production and full dependency audits,
packed-package installation, CLI/doctor/browser-resolution checks, stdio MCP
smoke, and authenticated HTTP MCP smoke.

Review `npm pack --json --ignore-scripts` as well. The tarball must contain the
CLI, production `dist`, dashboard assets, user documentation, examples, license,
and `addons/folderforge_bridge`; it must not contain runtime state, logs,
credentials, `node_modules`, or temporary artifacts.

## Cross-platform gate

The exact release commit must pass all required CI jobs on:

- Ubuntu with Node 22 and 24;
- macOS with Node 22 and 24;
- Windows with Node 22 and 24.

A local Linux pass cannot establish macOS or Windows readiness. Do not reuse old
workflow run IDs as evidence for a newer commit.

## Maintainer procedure

1. Review the working tree and classify every change.
2. Update version metadata and move published changes out of `[Unreleased]`.
3. Run the local gate and inspect the tarball manifest.
4. Commit the intended release tree and confirm `git status --porcelain` is empty.
5. Create the intended local annotated tag, then run
   `node scripts/verify-release-ref.mjs --tag "v${VERSION}" --notes-file RELEASE_NOTES.md`.
   The verifier requires a clean tree, exact tag/HEAD/package alignment, and a
   non-empty versioned changelog section before writing the notes file.
6. Push the intended release commit and wait for that exact commit's required CI
   matrix to pass.
7. Obtain explicit authorization for public tag, npm publication, and hosted
   release actions.
8. Push the verified tag, publish npm, and create a GitHub Release from the
   verifier-produced changelog notes.
9. Recheck npm dist-tags, tag target, release target, CLI version, and package
   contents from the registry.

Example operator commands, after authorization and after replacing `VERSION` and
`COMMIT` with verified values:

```bash
git tag -a "v${VERSION}" "${COMMIT}" -m "FolderForge ${VERSION}"
node scripts/verify-release-ref.mjs --tag "v${VERSION}" --notes-file RELEASE_NOTES.md
git push origin "v${VERSION}"
npm publish --access public
gh release create "v${VERSION}" --verify-tag --title "FolderForge ${VERSION}" --notes-file RELEASE_NOTES.md
```

Do not use generated release notes as a substitute for reviewing factual release
notes. Do not retag an existing public version or rewrite release history.

## Current public-state limitation

At the time this document was refreshed, npm `latest` was newer than the latest
public Git tag and GitHub Release. Repository preparation must not claim those
public objects exist. Closing that gap requires explicit operator authorization
and exact-commit CI evidence.

## Plugin trust limitation

Local MCP plugins are executable packages. Declared network and filesystem
permissions are review and audit metadata, not an operating-system sandbox. Do
not enable untrusted plugin packages.
