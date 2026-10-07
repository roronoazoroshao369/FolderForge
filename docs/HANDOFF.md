# HANDOFF

_Baseline verified: main SHA `863306eb46a4609a1f065f746ed3b94e6be20535`; exact-SHA CI run `37648701564` passed all six matrix jobs. PR #46 restored clean root dependency audits after the MCP SDK advisory drift._

Use this file only as resume context. Inspect live git and GitHub Actions before trusting it.

## Current snapshot

- Repository: `roronoazoroshao369/FolderForge`
- Default branch: `main`
- Inspected main SHA (docs-update base): `863306eb46a4609a1f065f746ed3b94e6be20535`
- Package version: `3.0.1`
- Exact-SHA main CI: run `37648701564` completed success for all six Ubuntu/macOS/Windows × Node 22/24 jobs.
- PR #46 updated `@modelcontextprotocol/sdk` from locked `1.29.0` to `1.32.1`; exact-head run `37647956742` and merge-SHA run `37648701564` both passed 6/6, including production and full dependency audits.
- PR #39 merged the scoped Mission Control remediation after exact-head run `37424245809` passed 6/6; merge run `37425225414` also passed 6/6.
- PR #40 reconciled R20 to VERIFIED_CI across project state, status, and frontier. Its exact-head run `37427738806` and merge-SHA run `37428315441` both passed 6/6.
- No PRs were open at this run's discovery. The two managed isolations remain active and source-dirty and must not be modified or removed.
- R16 remains BLOCKED pending explicit approval to install/use a real Podman engine. R17 remains EXTERNAL. All release gates remain closed.
- R20 is VERIFIED_CI: Vite 6.4.4 plus `source-map-js@^1.2.2`, local audit 0 vulnerabilities, and 12/12 visual screens pixel-identical. No Vite 8 upgrade was taken.
- This baseline is exact-main evidence only for the SHA above; every later revision needs its own exact-head and exact-main evidence.

## Read first

1. `docs/project/PROJECT_STATE.md` — current run contract, risks, and evidence.
2. `docs/PROJECT_STATUS.md` — durable release-status truth.
3. `docs/CURRENT_FRONTIER.md` — prioritized next work.
4. `CHANGELOG.md` — operator-visible changes for `3.0.1`.

Historical roadmap and implementation-log files do not override live repository evidence.

## Evidence boundaries

Run `37648701564` proves the checks that actually ran on exact inspected main SHA `863306eb46a4609a1f065f746ed3b94e6be20535`. PR #46 exact-head run `37647956742` also passed all six jobs on `9d5753c000e0fc0cc0b2fe5f8d03b4edc6db087a`; production and full dependency audit steps succeeded in both runs. Do not cite skipped platform-specific steps as passes. Docker isolation evidence does not prove Podman, macOS, or Windows container-runtime behavior. Short soak smoke is not a 24-hour soak.

Danger mode remains zero manual approval after hard denies; authorization, workspace/Capsule containment, policy deny, audit, rate limits, and fail-closed sandboxing remain mandatory.

## Immediate next action

Recheck live `origin/main`, open PRs, branch refs, and exact-SHA CI before any further edit. This handoff records inspected base SHA `863306eb46a4609a1f065f746ed3b94e6be20535` and green run `37648701564`; any later revision requires its own exact-SHA evidence. If main CI is green, select one evidence-backed correctness/DX goal. R16 may proceed only after explicit user approval to install or provide a real Podman engine. R17 and every release gate remain closed. Do not infer Podman evidence from Docker success or routing mocks. Do not begin Vite 7/8 migration without a separate compatibility review.

## Human gates still closed

- 24-hour soak on the eventual exact release SHA
- Branch protection confirmation/change
- Protected `npm-publish` environment
- Danger Mode human sign-off
- Beta evidence
- `v3.0.1` tag, npm publish, and GitHub Release

Do not retag or delete `v3.0.0`. Do not perform any closed action without explicit user approval for that exact action.

## NEXT_RUN_PROMPT

Resume the FolderForge perpetual council on `roronoazoroshao369/FolderForge`. Repository truth overrides this handoff. Inspect live `main`, list open PRs and branch refs, and match CI to the exact live SHA before any edit. Recorded baseline: main `863306eb46a4609a1f065f746ed3b94e6be20535`, run `37648701564` success 6/6; PR #46 exact-head run `37647956742` success 6/6; root production/full dependency audits are green with `@modelcontextprotocol/sdk@1.32.1`.

Select exactly one goal. Red exact-main CI is always first priority. Otherwise R16 remains BLOCKED until explicit real-Podman approval; R17 and all release gates remain closed. Discover one measurable correctness/DX issue and reproduce it before implementation. The known CLI parser edge case where a value-taking option can consume the following option token is a candidate. Do not tag, publish, release, alter branch protection or secrets, retag/delete `v3.0.0`, or infer Podman evidence from Docker. End with verdict, exact evidence, and a fresh NEXT_RUN_PROMPT.
