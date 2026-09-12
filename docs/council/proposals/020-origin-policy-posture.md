# Proposal 020: origin policy posture — keep danger+allow-critical (evidence-based, no code change)

- Author role: Security Officer
- Date: 2026-09-12
- Status: accepted (decision record — no code change; merged to main 2026-09-12)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Context (debt #29)

Loop #29 queued: "policy mode đang danger trên instance operator — cân nhắc
hạ về dev/safe khi không cần". Loop #49 adjudicates it with host + code
evidence instead of acting on the headline alone.

## Evidence

Host (2026-09-12, read-only): the origin unit's ExecStart is
`--project /home/devops/FolderForge --http --host 127.0.0.1 --port 3112
--no-dashboard --tools-preset full --policy danger
--dangerously-allow-critical --auth token` (token delivered via
`origin.env` 0600, not argv — the #36 wart is fixed). The control plane on
:7332 runs the default `dev` policy. The origin is reachable beyond
loopback only through the named cloudflared tunnel, which requires the
bearer token.

Code (`src/policy/policy-engine.ts`): in non-danger modes every HIGH
(`shell_exec`, `git_commit`) and CRITICAL (`git_push`) tool is
approval-gated (`baselineApproval && mode !== 'danger'`; CRITICAL
gated unless `allowCriticalInDanger`). Approval requests persist to
`<projectRoot>/.folderforge/approvals.jsonl` — the origin's store
(`/home/devops/FolderForge`) is NOT the control plane's store
(`/home/devops`); the origin runs `--no-dashboard` (main.ts warns about
exactly this combination: "approval-gated actions cannot be resolved");
`approval_approve` is admin-plane only; client elicitation is unproven on
the operator's chat transport.

## Decision

KEEP the origin at `danger` + `--dangerously-allow-critical`. Lowering it
today would gate every HIGH/CRITICAL council action behind approvals that
have no reachable resolver — a self-lockout of the council's workhorse,
not a security improvement. The posture is intentional for a
single-operator, loopback + bearer-auth instance and is documented here
instead of left implicit.

## Revisit when (any one suffices)

1. The origin gains a reachable approval channel (dashboard enabled on
   loopback, a shared approval store with the control plane, or a proven
   elicitation client) — then re-evaluate dev/safe.
2. The host stops being single-operator (other users, or the tunnel auth
   model changes).
3. A concrete abuse/blast-radius incident is traced to the danger posture.

## Related finding (separate queue item)

`repo_vibecode` (:3114) and `vibcode-auto-test` (:3116) run manually with
danger + allow-critical AND their credentials in process argv (visible to
any local process via `ps`), `--project .` cwd-relative, no supervisor —
the #36 wart class still live there. Owned by the "dedupe + units" queue
item (separate approval); flagged here so it is not lost.

## Rollback

Nothing to roll back — no host or code change. To reverse the decision,
satisfy a revisit condition and open a new proposal.

## Decision log

- 2026-09-12 — Security Officer — propose decision record — loop #49,
  candidate #1 from the post-#48 queue (debt #29).
- 2026-09-12 — QA/Verifier — evidence reviewed — host argv/units,
  approval-store topology (origin store ≠ plane store), policy-engine
  gating semantics; no verification gates needed (no code change).
- 2026-09-12 — User — **direction approved** — Option A via survey: close
  debt #29 as an evidence-based decision; do not touch the host.
- 2026-09-12 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #49 (survey approval after the LOOP REPORT).
