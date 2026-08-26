# Agent Council — autonomous improvement loop

Formalization of the multi-expert council that evolves this repo (ADR-0012,
Phase 4). The council is a *discipline*, not a daemon: each session runs the
loop below and records outcomes in the Notion track log.

## Roles

| Role | Responsibility |
| --- | --- |
| Architect | Architecture, ADRs, API contracts |
| Security Officer | Auth, tunnel exposure, redaction, threat model |
| DX/UI Designer | UX flows, design consistency, a11y |
| Provisioner Engineer | Per-folder lifecycle, process supervision |
| QA/Verifier | Tests, coverage, release gates |
| Scribe | Track log + plan hygiene after every loop |

One agent may hold several roles in a session, but every proposal must be
*reviewed wearing a different hat* than it was written with.

## The loop

1. **Discovery** — read the track log and repo state (`git_status`, `git_log`,
   `project_analyze`, `change_summary`); produce a gap list ordered by value.
2. **Proposal** — write `docs/council/proposals/NNN-<slug>.md` from
   `docs/council/proposal-template.md`. Small, verifiable, reversible.
3. **Council review** — challenge the proposal as Security + QA at minimum:
   threat surface, blast radius, test plan. Approve, amend, or reject.
4. **Implement** — on a `council/<task>` branch, smallest increments first.
5. **Verify** — `project_verify` (typecheck/lint/build) + targeted tests, then
   the full suite before the phase closes.
6. **Log** — tick the checkbox, append a track-log row with the commit hash.

## Merge rules

- Merge to `main` only after: full suite green, ADR updated if architecture
  moved, and a human approves the merge/push (CRITICAL operations stay
  gated — the council never self-approves a push).
- Breaking the frozen tool schema (`src/tools/schema-lock.ts`) requires an
  explicit major-version discussion in the proposal.
- Secrets never persist in plaintext; state files under `.folderforge/` stay
  covered by denied globs.

## Guardrails

- Every mutation goes through the policy pipeline; approvals for HIGH/CRITICAL.
- Long-running work uses `process_start` + polling, never blocking calls.
- Two consecutive tool failures on the same path → stop, diagnose, explain.

## KPIs (recorded monthly in the track log)

- Proposals merged vs rejected (target: mostly merged, zero silent rejections).
- Test pass rate at each gate (target: 100% before commit).
- Policy incidents: unintended HIGH/CRITICAL executions (target: 0).
- Rollback count per release (target: 0).
