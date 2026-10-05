# PROJECT STATE

_Last updated: 2026-10-05T06:12:00Z_

## Product and repository

- Phase: 3.0.1 release-candidate hardening; external release gates remain closed.
- Package: `@musashishao/folderforge` `3.0.1`.
- Default branch: `main`.
- Main SHA: `4f82fd287763be4d88edb7fec9bb948535ca5abd`.
- Main CI: **red** — `ci.yml` run `37216093165`; only `windows-latest / Node 22` failed, at `Pinned third-party child MCP compatibility`.
- Council branch: `fix/windows-third-party-path` from the main SHA above.
- Council PR: `https://github.com/roronoazoroshao369/FolderForge/pull/28`; verified code head `3a1c173853270578265e7e6fd92be643f24eead3`. The commit containing this state update is documentation-only and must receive its own exact-SHA CI before merge.

## Verification truth

- Verified on exact main SHA: Ubuntu/Node 24 and macOS/Node 24 jobs succeeded in run `37216093165`; the Windows/Node 22 job failed.
- Windows artifact `child-mcp-third-party-windows-latest-37216093165-1`: installation completed, audit reported 0 vulnerabilities, 4/5 profiles passed, and `mcp-filesystem` failed because `list_allowed_directories` text did not match the manifest's mixed-separator expected path.
- Local verification for the current branch: `typecheck`, `lint`, `architecture:check`, `docs:check`, targeted regression (8/8), clean-env `npm run verify` (145 files, 1190 passed, 14 skipped), Linux pinned `mcp-filesystem` probe (1/1, audit ok), and `npm audit --audit-level=high` all exited 0.
- Red-team review: matching remains exact first and otherwise changes only slash direction; package pins, integrity, required tools, audit, sandbox, and process semantics are unchanged. Secret scans found no credential material in the diff; entropy-only identifiers and an existing environment-variable name were reviewed as non-secrets.
- Exact code-SHA CI: workflow-dispatch run `37270699488` completed success for all six OS/Node jobs at `3a1c173853270578265e7e6fd92be643f24eead3`; the Windows/Node 22 artifact reports commit match, clean tree, audit ok with 0 vulnerabilities, and 5/5 profiles passed.
- Broken: main remains at the older red SHA until PR #28 is merged and main CI is confirmed.
- Historical documents `docs/PROJECT_STATUS.md`, `docs/CURRENT_FRONTIER.md`, and `docs/HANDOFF.md` are stale (last marked 2026-10-03) and are not release authority.

## Risk register

- **R11 — Fixed (historical, not re-proved this run):** terminal containers are reaped after timeout/process kill; prior main evidence exists before the current red SHA.
- **R12 — Fixed (historical, not re-proved this run):** sandbox boundary CI gate was added.
- **R13 — Fixed (historical, not re-proved this run):** terminal outcomes distinguish timeout, signal, and uncertain results.
- **R14 — Fixed (historical, not re-proved this run):** Windows npm launch uses `node` plus `npm-cli.js`; run `37216093165` proved package installation starts and completes.
- **R15 — Fixed on PR #28, pending merge:** exact-SHA run `37270699488` and its Windows/Node 22 artifact prove 5/5 profiles passed with audit ok; main still needs the safe merge and post-merge confirmation.

## Current frontier

Land PR #28 only after the documentation-only head receives green exact-SHA CI, then confirm the merged `main` SHA and its CI before advancing the release frontier.

## Primary goal contract

**GOAL**  
Make the Windows/Node 22 pinned third-party child-MCP profile pass when `list_allowed_directories` returns the same path with Windows-native separators.

**WHY NOW**  
Main CI run `37216093165` is red at the highest-priority gate.

**SCOPE FILES**
- `scripts/child-mcp-third-party.mjs`
- `tests/unit/child-mcp-third-party.test.ts`
- `docs/project/PROJECT_STATE.md`
- `CHANGELOG.md` only if operator-visible behavior wording needs correction

**NON-GOALS**
- No new public tool, CLI command, route, or MCP API.
- No dependency update, release, tag, publish, branch-protection, secret, or environment change.
- No unrelated portability or documentation rewrite.

**ACCEPTANCE CRITERIA**
1. A unit regression check proves equivalent `/` and `\\` path separators match while unrelated text does not.
2. `typecheck`, `lint`, `architecture:check`, `docs:check`, targeted tests, clean-env `npm run verify`, relevant third-party validation, and `npm audit --audit-level=high` exit 0 locally.
3. A PR exists for the exact pushed head SHA.
4. `ci.yml` for that head SHA completes successfully, including `windows-latest / Node 22`; its third-party artifact reports 5/5 passed and audit ok.
5. No Critical/High finding, secret exposure, or new public surface is introduced.

**TEST PLAN**  
Add the failing separator-equivalence unit case, implement the smallest matcher, run the ordered local gates, inspect the diff and secret scan, then verify the exact PR SHA and Windows artifact.

**SECURITY IMPACT**  
Low and limited to evidence comparison. Keep exact text comparison as the first path and normalize only slash direction; do not relax tool, pin, integrity, audit, or process checks.

**ROLLBACK**  
Revert the single fix commit or close the PR before merge.

**NEEDS HUMAN APPROVAL:** no.

## Council decision

MCP compatibility and Windows portability favor separator-equivalent comparison. Security and supply-chain lenses veto broader fuzzy matching or pin changes. CI/release evidence requires a real Windows artifact for the exact SHA. The smallest adequate option is a private tested matcher that only treats `\\` and `/` as equivalent.

## External human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

## Next candidate goal

After main is green and this PR is safely merged, reconcile stale release-status documents against the merged exact-SHA evidence without overstating cross-platform or human-gate completion.
