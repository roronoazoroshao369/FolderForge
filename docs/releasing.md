# Release process

FolderForge releases are gated by executable evidence, not by source review alone.
The repository must pass the following command before a version is tagged or
published:

```bash
npm run release:check
```

That command runs, in order:

1. Typecheck and lint.
2. Unit and integration tests.
3. Production build.
4. Production-only and full dependency audits.
5. `npm pack`, tarball installation in a temporary project, and CLI
   `--version`/`--help` smoke checks. The package smoke also rejects any
   `postinstall` script, runs `doctor`, and verifies `setup browser --dry-run`
   resolves the installed package-local Playwright CLI without downloading.
6. Stdio MCP smoke checks covering initialization, `tools/list`, and `file_read`
   from a project path containing spaces and Unicode.
7. Authenticated HTTP MCP smoke checks covering unauthorized rejection,
   `initialize`, `tools/list`, and `tools/call`.

CI runs source, test, build, tarball, and authenticated HTTP smoke gates on
Ubuntu, macOS, and Windows with Node 22 and Node 24. Dependency audits run once
on Ubuntu/Node 22. See `compatibility.md` for the support contract.

## Release-candidate procedure

1. Confirm the working tree and review every logical change set.
2. Run `npm run release:check` on the intended version.
3. Confirm package, CLI, MCP server, and lockfile versions agree.
4. Review `npm pack --json --ignore-scripts` output for unexpected or missing
   files.
5. Review dependency audit output and document any accepted exception.
6. Update `CHANGELOG.md`, migration notes, roadmap, and implementation log.
7. Obtain explicit authorization before committing, tagging, pushing,
   publishing to npm, or creating a hosted release. Publish release candidates
   with `--tag next`; reserve `latest` for a stable verdict.

The current candidate is `2.0.0-rc.2`. It is committed and pushed on `main`,
tagged as `v2.0.0-rc.2`, and published to npm under the `next` dist-tag. A clean
registry install passed CLI/help, no-postinstall, browser setup dry-run, doctor,
stdio, and authenticated HTTP validation. Stable promotion remains blocked until
the full GitHub Actions matrix is observable and successful.

## Current trust limitations

Local MCP plugins are prepared executable packages. Their declared network and
filesystem permissions are review/audit metadata, not OS-enforced sandbox rules.
Do not enable untrusted packages. Signed provenance, hard sandboxing, and remote
marketplace distribution remain release blockers for any untrusted plugin flow.
