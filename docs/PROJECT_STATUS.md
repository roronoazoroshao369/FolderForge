# PROJECT STATUS

_Last verified: 2026-10-05T09:10:45Z against live git and GitHub Actions._

## Authoritative snapshot

- Repository: `/home/devops/FolderForge`
- Default branch: `main`
- Verified main SHA: `3b1889e42cd236d80fd57f3cb6521ccc7700ef84`
- Package: `@musashishao/folderforge` `3.0.1`
- Exact-SHA main CI: `ci.yml` run `37287594297` completed **success** on that SHA.
- Matrix result: all six Ubuntu/macOS/Windows × Node 22/24 jobs completed successfully. Skipped steps are NOT_RUN, not passes.
- `v3.0.0` remains public and abandoned; never retag, delete, or publish it.
- `v3.0.1` is not tagged or published by this status update.

## Working tree and delivery state

PR #32 merged the Windows claim reconciliation at `3b1889e42cd236d80fd57f3cb6521ccc7700ef84` after exact-head run `37286780402` succeeded on `bda17ce160e93587043f5b95c814b0a3f0f0373e`. Merge run `37287594297` succeeded on that exact main SHA. A later documentation handoff may advance main; inspect it live. PR #28 and PR #30 remain merged. The Windows/Node 22 third-party check succeeded again in run `37286780402`.

Automated dependency PRs remain open but are unrelated to the release-candidate hardening goal. They must be evaluated independently and must not be treated as already verified by the main run.

## Verification truth

Run `37287594297` is exact-SHA evidence for the jobs and steps that actually ran. It proves the repository matrix completed successfully on Ubuntu, macOS, and Windows with Node 22 and 24.

It does **not** turn skipped platform-specific steps into passes. Container-runtime isolation ran only where the workflow enabled it; Docker evidence is not macOS, Windows, or Podman evidence. Short runtime-soak checks and sample-volume gates are not a completed 24-hour soak.

Earlier local verification on the merged implementation branch reported clean typecheck, lint, architecture, docs, full verify, relevant third-party probe, and high-level audit. Current branch-local evidence is recorded in `docs/project/PROJECT_STATE.md` and must be refreshed for each new change.

## Security and policy consistency

Danger mode remains zero manual approval after hard denies. Authorization, workspace and Capsule containment, policy deny, audit, rate limits, and fail-closed terminal sandbox requirements still apply.

No known Critical or High defect was established during this documentation reconciliation. This is not production certification and does not waive the remaining human gates.

## Open release gates

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- Explicit approval for `v3.0.1` tag, npm publish, and GitHub Release
- Evidence review for any claimed Podman support

See `docs/CURRENT_FRONTIER.md` for the prioritized next goal and `docs/project/PROJECT_STATE.md` for per-run evidence.
