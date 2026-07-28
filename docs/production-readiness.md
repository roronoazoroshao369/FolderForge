# Production readiness evidence

FolderForge does not treat a short smoke test, a simulated evidence volume, or a
successful local build as proof of long-running production readiness. A release
candidate must have evidence tied to the exact commit that will be tagged and
published.

## Required remote gates

The release and npm publish workflows fail closed unless the candidate commit has:

1. a successful `.github/workflows/ci.yml` run for the exact Git SHA, including
   the supported operating-system and Node.js matrix;
2. an unexpired artifact named `production-soak-<full-commit-sha>` created by a
   successful `production-soak` workflow;
3. a runtime-soak hash chain whose `run_start` record names that exact commit and
   confirms a clean working tree;
4. at least 24 hours of active runtime, a completed `pass` verdict, zero
   unexpected failures, sufficient sample density, observed planned fault
   injection, and a successful governance-audit verification.

The release workflows download the artifact again and run
`scripts/verify-production-soak.mjs`; they do not trust the artifact name alone.
The npm workflow attests the resulting verification receipt and attaches it to
the immutable release evidence.

## Production soak workflow

`.github/workflows/production-soak.yml` is manually dispatched for a candidate
ref. It resolves an immutable commit, then runs four resumable five-hour segments
and one completion segment. Each segment rebuilds the exact source, requires a
clean tracked tree, verifies the evidence chain, and passes the evidence forward
through a commit-named artifact. The final job writes
`production-soak-receipt.json` and retains the complete evidence artifact for
release verification.

The segmented design is deliberate: no single job is responsible for the whole
24-hour observation, and interrupted intermediate evidence remains verifiable.
Only the final completed artifact satisfies the release gate.

## Local verification

A completed evidence directory can be checked with:

```bash
npm run production:verify-soak -- \
  --evidence-dir .folderforge-soak/runtime \
  --commit "$(git rev-parse HEAD)" \
  --receipt .folderforge-soak/runtime/production-soak-receipt.json
```

The verifier defaults to a 24-hour minimum. A lower
`--minimum-duration-ms` is intended only for deterministic tests of the verifier,
not for release approval.

## Release sequence

1. Merge the candidate commit and wait for exact-SHA CI to pass.
2. Dispatch `production-soak` for that commit and retain its final artifact.
3. Create the semantic-version tag on the same commit.
4. Allow `release.yml` to verify CI and soak evidence before creating the GitHub
   Release.
5. Dispatch `publish-npm.yml`; it repeats the evidence verification before
   packing, attesting, publishing, and verifying registry bytes.

A repository can be code-complete before these remote gates run, but it must not
be described as production-certified until the exact-commit evidence exists and
passes.
