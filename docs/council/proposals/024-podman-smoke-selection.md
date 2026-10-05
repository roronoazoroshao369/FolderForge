# Proposal 024: Honor explicit Podman selection in the sandbox smoke

- Author role: Architect
- Date: 2026-10-05
- Status: implemented
- Classification: bug / compatibility / test / docs

## Problem

On main baseline `aa8c5e97683ccde5b2a8aefac4b99b21c0fd08ed`, `FOLDERFORGE_SANDBOX_RUNTIME=podman npm run smoke:sandbox` runs Docker and exits 0 even when Podman is absent. The adapter config and success report both hardcode Docker. This is a smoke/evidence defect in the inspected 3.0.1 candidate, not proof of a product-runtime escape.

## Proposal

Honor the existing terminal-test environment selector (`docker` by default, explicit `docker` or `podman` only). Reject unsupported values before transport/temp-project creation; use the selected engine in config, prerequisite guidance, and success JSON. No dependency, product surface, containment argument, or version change.

## Threat surface (Security hat)

Selection cannot choose process/host mode or an arbitrary executable. Preserve digest pinning, no network, read-only plugin mount/root, resource limits, and environment checks. No runtime auto-install or pull. Never label mocked protocol evidence as container proof.

## Test plan (QA hat)

Red/green tests execute the smoke entrypoint with mocked MCP protocol only and inspect its real temporary config, success report, early rejection, and cleanup. Then real Docker boundary smoke must pass. On inspected Linux/Node 22 (Docker available, Podman absent), explicit Podman must fail, not silently produce Docker success. The routing-only suite runs explicitly on every OS/Node CI job, including Windows where general tests are skipped. Ordered gates and exact-head six-job CI precede merge. R16 stays open until real Podman isolation is exercised independently.

## Rollback

Revert the scoped commit (or close the PR before merge). No data migration or release action.

## Decision log

- 2026-10-05 — Security hat — approve with strict Docker/Podman validation and no fallback.
- 2026-10-05 — QA hat — approve with red/green config-plus-report assertions and actual missing-engine failure.
- 2026-10-05 — Skeptic hat — amend: all mocks are routing-only; rootless UID/mount/cgroup evidence and macOS/Windows containment remain open.
- Role reviews are by one agent, not independent human sign-off. Full votes and rejected alternatives are in PROJECT_STATE.

## Local implementation evidence

E2: unchanged baseline explicit-Podman smoke exited 0 with Docker evidence; red regression suite exited 1 (5 failed, 3 passed); fixed suite exited 0 (8 passed). Linux/Node 22.23.0, Docker available / Podman absent: fixed explicit-Podman smoke exited 1 with `spawn podman ENOENT`; default and explicit Docker boundary smoke each exited 0. Real Docker terminal suite: 18 passed. Clean-env verify: 146 files, 1198 passed, 14 skipped, exit 0. Typecheck/lint/architecture/docs/stdio/HTTP/audit all exited 0. Logs and exact image digests are recorded in PROJECT_STATE. Exact-head CI is pending at commit time; real Podman containment remains unverified.

## Delivery

PR #30 merged normally at `27fc3e0aa7c79228f84a1f9b351c46c2af27713d` after exact-head run `37278290277` succeeded on `816a98aedd55538d8315036b1c6ada486a754bd6` (all six jobs and routing-only steps). Main merge run `37279062422` must be inspected live; no future documentation SHA is self-certified here. R16/R17 remain open.
