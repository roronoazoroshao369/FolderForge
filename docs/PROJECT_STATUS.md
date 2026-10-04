# PROJECT STATUS

_Last verified: 2026-10-03 against the live repository and public distribution state._

## Authoritative snapshot

- Repository: `/home/devops/FolderForge`
- Branch: `main`
- Release candidate SHA: the commit containing this document; exact-SHA CI records the immutable identifier.
- Target package version: `3.0.1` (breaking security semantics inherited from the abandoned 3.0.0 candidate).
- npm `latest` before this release: `2.9.0`.
- Previous npm/tag commit: `v2.9.0` at `b0f720a225598e4fc314cbd86b6ea2d94ae7cae5`.
- Target tag: `v3.0.1` after exact-SHA CI and a completed 24-hour soak on the same SHA. `v3.0.0` is public but abandoned (its source lacks terminal sandbox hardening); never retag or publish it.

## Working tree

The 3.0.0 candidate combines the preserved stabilization work with the danger-mode breaking change. No pre-existing work was reset, cleaned, discarded, or overwritten.

The candidate includes policy/Fleet/tunnel/UI/docs/test updates, the Node runtime PATH fix, and the major-version metadata. There are no deleted or conflicted files. Danger mode no longer creates approval requests, so the former pending-approval commit blocker is obsolete.

## Verification truth

Supported-runtime execution evidence is now available.

- The active MCP and its child commands use Node `22.23.0`; the system Node 20 binary is not used as release evidence.
- Node 24 local runtime is installed at `/home/devops/.nvm/versions/node/v24.21.0`.
- Node 22 full `npm run verify`: **VERIFIED PASS** — typecheck, lint, architecture (`cycles=0`, `violations=0`), build, 144 test files / 1170 tests PASS, including 12 visual regressions.
- Node 24 full `npm run verify`: **VERIFIED PASS** on the same 3.0.0 candidate.
- Node 22 `npm run quality:check`: **VERIFIED PASS** — coverage/critical coverage, fuzz, child-MCP stress, audit concurrency, evidence integrity, compatibility, runtime-soak smoke/volume, onboarding, Godot smoke, and governance benchmark all passed.
- Release-specific local checks: `docs:check` **PASS** for 99 Markdown files; `smoke:package` **PASS** (318-file tarball); `smoke:stdio` **PASS**; authenticated `smoke:http` **PASS**.
- Critical-coverage aggregate: statements `86.83%`, branches `78.45%`, functions `92.41%`, lines `89.67%`; all configured thresholds passed.

The five-second runtime-soak smoke and 90k-sample volume gate are quality checks only and are not evidence of a completed 24-hour production soak.

## CI truth

Historical external CI evidence for committed HEAD `818b7236...` showed platform-specific failures, including Windows Fleet reconnect and additional Ubuntu/macOS failures. The current worktree now contains uncommitted fixes and verification changes, so that historical SHA cannot prove the current candidate.

Current exact-candidate cross-platform CI is therefore **UNVERIFIED** until the worktree is captured in a coherent commit and Ubuntu/macOS/Windows × Node 22/24 CI passes for that exact SHA.

## Security / policy consistency

The 3.0.0 candidate changes `danger` to zero manual approval across local MCP, Fleet, OpenAI tunnel, Mission Control, and `policy_explain`:

- approval requirements from HIGH/CRITICAL, `policy.requireApproval`, policy-as-code `approval`, sessions, and supported git elicitation are bypassed;
- explicit denies, authorization, workspace/path/Capsule containment, audit, and rate limits remain enforced;
- legacy `allowCriticalInDanger` input is ignored and removed from rewritten Fleet state; the CLI flag is a deprecated no-op.

Local Node 22/24 verification, typecheck, lint, docs, build, architecture, and visual checks pass. Exact-SHA cross-platform CI remains required before release-ready status.

## Dependency security

Current Node 22 audit evidence is **VERIFIED clean**:

- `npm audit --omit=dev --json`: 0 vulnerabilities;
- `npm audit --json`: 0 vulnerabilities.

The dependency tree already contains the security-oriented package/override changes under review, including `fast-uri` `4.2.1`. The stale exact-version test assertion was corrected and the full verification gates now pass.

## Maturity boundary

FolderForge already has substantial local engineering foundations: policy/approval, durable audit/evidence, worktree isolation, workflows and Proof Packs, structured verification, Mission Control, child MCP composition, runtime-soak tooling, release provenance tooling, and reference distributed-worker capability.

This does **not** establish production certification. Remaining evidence includes a passing exact-commit cross-platform matrix, completed 24-hour exact-revision soak, independent clean-machine reproduction, independent third-party MCP evidence, and external beta/design-partner evidence.

See `docs/CURRENT_FRONTIER.md` for the prioritized next actions.
