# HANDOFF

_Last verified: 2026-10-03._

Use this file when resuming FolderForge work in a new AI or maintainer session.

## Analysis objective status

**COMPLETE.** The repository, current plan/status/roadmap, working-tree state, CI/release evidence, security/dependency gaps, maturity boundary, and prioritized next actions have been analyzed and captured in the current-truth documents below.

Do not repeat broad discovery unless live evidence has materially changed. Resume from the highest unresolved item in `docs/CURRENT_FRONTIER.md`.

## Read first

1. `docs/PROJECT_STATUS.md` — verified current truth.
2. `docs/CURRENT_FRONTIER.md` — prioritized P0/P1/P2 work and exit conditions.
3. `docs/README.md` — documentation precedence and current contracts.

Do **not** treat `docs/roadmap.md`, `docs/ai-agent-roadmap.md`, or `docs/implementation-log.md` as authoritative current state.

## Preserve existing work

The 3.0.0 candidate intentionally combines the preserved stabilization work with the danger-mode breaking change, Node PATH fix, documentation, tests, and release metadata. Do not reset, stash, overwrite, or discard any of it. Nothing is deleted or conflicted.

## Immediate next action

The 3.0.0 zero-approval danger-mode candidate passes full local verification on Node 22 and Node 24. The active MCP also propagates Node 22 to child commands, so Node 20 no longer blocks tools.

Current frontier:

1. commit and push the coherent 3.0.0 candidate;
2. obtain exact-candidate Ubuntu/macOS/Windows × Node 22/24 CI evidence;
3. create and verify `v3.0.1` on that exact SHA (`v3.0.0` is abandoned; do not retag or publish it);
4. retain a genuine 24-hour soak separately; short soak smoke and volume simulation do not satisfy that production-evidence requirement.

## Verification evidence from the latest resume

- branch `main`, committed HEAD `818b7236dfa0e9747c0bbd61dfd24bb201ca8bf6`, ahead/behind `0/0` at initial resume inspection;
- Node 22 local runtime: `22.23.0`; Docker verification runtime: Node `22.23.3` / npm `10.9.9`;
- Node 24 focused runtime: Node `24.21.0` / npm `11.19.0`;
- Node 22 focused regression: **132/132 PASS**;
- Node 24 focused Fleet/policy regression: **95/95 PASS**;
- Node 22 full `npm run verify`: **144 files / 1170 tests PASS**, including 12 visual regressions;
- Node 22 `npm run quality:check`: **PASS** including critical coverage, fuzz, stress, evidence, compatibility, soak smoke/volume, onboarding, adapter smoke, and governance benchmark;
- `docs:check`: **PASS** for 99 Markdown files;
- `smoke:package`, `smoke:stdio`, authenticated `smoke:http`: **PASS**;
- production and full dependency audits: **0 vulnerabilities**;
- 3.0.0 danger semantics: zero manual approval after hard-deny/authorization checks; policy-as-code deny still wins; legacy `allowCriticalInDanger` is ignored and not persisted;
- full Node 22 and Node 24 `npm run verify`: **PASS**;
- `npm run release:check`: post-commit gate requiring candidate HEAD = `origin/main` and `v3.0.1` on the same exact SHA.

Historical external CI for committed HEAD had platform failures. The current uncommitted candidate has no exact-SHA cross-platform evidence yet.

## Completion rule for the next session

Do not move to major feature work until the unresolved P0/P1 stabilization gates in `docs/CURRENT_FRONTIER.md` are closed with current evidence.
