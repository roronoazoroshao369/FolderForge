# Proposal 010: baseline docs sync + release prep 2.8.2 (npm publish verification)

- Author role: QA/Verifier + Scribe
- Date: 2026-09-06
- Status: implemented (2026-09-06, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Queue debt from #32: "đồng bộ baseline docs 2.8.1 + xác minh npm publish".
Read-only research on 2026-09-06 established:

1. npm registry serves `@musashishao/folderforge@2.8.0` (dist-tags.latest,
   time.modified 2026-09-05T01:30:33Z — the 2.7.11-era 2FA OTP block is long
   resolved). The repo is at **2.8.1** with local tag `v2.8.1`, but 2.8.1 was
   **never published**; main has since gained five proposals under
   `[Unreleased]` (005, 006, 007 fix, 008, 009).
2. Publishing "2.8.1" from current main would ship content that does not
   match the `[2.8.1]` changelog section — a mislabeled release artifact.
3. `npm whoami` on this machine returns E401 (logged out) and registry
   publishes require the user's 2FA OTP — the publish step belongs to the
   user; the loop only prepares it.
4. Stale current-state pins: `docs/adr-0012` says "FolderForge 2.7.9",
   `src/main.ts` comment says "full catalog (337 tools)", `docs/tools.md`
   says "308 tools (288 agent-facing and 20 admin-only)". Live audit: the
   full preset serves **304 tools** over `tools/list` while the registry
   holds **329** entries at startup (25 admin-only).
5. The Notion track log's section 1 baseline still describes 2.7.9 / 337
   tools / a pre-Phase-1 capability matrix.

## Proposal

### 1. Cut release 2.8.2 on current main (release prep only)

- Bump `package.json` + `package-lock.json` to 2.8.2
  (`npm version 2.8.2 --no-git-tag-version` semantics; no tag until merge).
- CHANGELOG: move the `[Unreleased]` Added/Fixed content into a new
  `## [2.8.2] - 2026-09-06` section; under the `[2.8.1]` heading add one
  line: "Not published to npm; superseded by 2.8.2 on the registry."
- No source behavior changes.

### 2. Fix the three stale current-state pins

- `docs/adr-0012-mission-control-control-plane.md`: "FolderForge 2.7.9" →
  "FolderForge 2.8.2".
- `src/main.ts` comment: "full catalog (337 tools)" → "full catalog
  (304 tools)".
- `docs/tools.md` full-preset row: "**308 tools** in the audited working
  tree: 288 agent-facing and 20 admin-only" → "**304 tools** served over
  `tools/list` in the audited 2.8.2 tree (the registry holds 329 entries at
  startup, including 25 admin-only tools)".

### 3. Notion baseline sync (Scribe)

Rewrite track log section 1 (Hiện trạng repo) to the 2.8.2 reality: current
main hash, 304/329 tool counts, MCP origin now supervised by the
`folderforge-origin.service` systemd unit, and a refreshed capability matrix
(the "Còn thiếu" column is pre-Phase-1 stale).

### 4. Release runbook for the user (never agent-run)

After user-approved merge + push: `npm login` (2FA OTP) → `npm publish` →
`git tag v2.8.2 <merge commit>` + `git push origin v2.8.2` → optional
`npm i -g` refresh + origin/plane restart to run 2.8.2 (separate ops
approval; the running origin stays on 2.8.1 dist until then).

## Threat surface (Security hat)

- No secrets touched; no server behavior, policy, schema-lock, or risk-class
  changes — version metadata + docs only.
- npm publish is CRITICAL and interactive (login + OTP) and is never run by
  the agent; the runbook is instructions for the user, not an agent plan.
- The 2.8.1-skipped-on-npm note prevents a future mislabeled backfill
  publish.

## Test plan (QA hat)

- Gates: typecheck / lint / build exit 0, plus the full suite
  (run_test async, disclosed per #27) — the version string is read from
  package.json by `src/core/version.ts`; test fixtures that pin "2.8.1"
  (e.g. control-service harness) are deps-injected and must stay green.
- Live proof: `node dist/main.js --version` prints 2.8.2 after build.
- Doc claims are evidence-backed: 304 (live tools/list over the full preset,
  1 page), 329 (audit server_start), registry 2.8.0 time.modified.

## Rollback

Revert the branch commit; no live machine state is touched by this proposal.

## Decision log

- 2026-09-06 — QA/Verifier + Scribe — propose — loop #37 (queue debt
  "đồng bộ baseline docs 2.8.1 + xác minh npm publish"); research evidence:
  registry 2.8.0 published 2026-09-05T01:30:33Z, repo 2.8.1 never published
  with five proposals stacked in [Unreleased], npm auth E401, live tool
  counts 304 served / 329 registry, three stale pins enumerated by rg.
- 2026-09-06 — Security Officer — **approve with amendments** — (1) no
  secrets, policy, schema-lock, or risk changes; (2) npm publish stays a
  user-only interactive step (E401 + OTP), the runbook is documentation, not
  an agent action; (3) the 2.8.1 "not published" note is mandatory so nobody
  backfills a mislabeled 2.8.1 artifact later.
- 2026-09-06 — QA/Verifier — **approve with amendments** — (1) full suite
  must stay green after the version bump (fixtures are deps-injected —
  assert, don't assume); (2) live proof is `node dist/main.js --version`
  printing 2.8.2; (3) every doc number must match its evidence source
  (304 = live tools/list, 329 = audit server_start, 25 = difference).
- 2026-09-06 — QA/Verifier — **gates green on the final code** —
  typecheck/lint/build exit 0 and full suite 133 files / 1085 tests PASS
  (85.84s) under the pinned nvm node v22.23.0 toolchain; live proof
  `node dist/main.js --version` prints folderforge 2.8.2. Disclosure: the
  suite ran via process_start with an explicit PATH pin because the
  supervised origin (ops #36) currently serves child processes a minimal
  systemd PATH (node 20) — an environment wart, not a code failure; the
  first suite attempt (proc_68c967c5) failed 46 files on execa imports
  under node 20 and was correctly diagnosed per HARD STOP #3, never
  committed on.
- 2026-09-06 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #37. npm publish itself is NOT covered: it stays a
  user-only interactive step (login + 2FA OTP) per the release runbook.
