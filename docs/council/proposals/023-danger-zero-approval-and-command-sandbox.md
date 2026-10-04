# Proposal 023: ratify zero-approval danger mode with fail-closed command sandboxing

- Author role: Security / QA / DX council
- Date: 2026-10-04
- Status: implemented; maintainer ratification pending
- ADR link: `docs/security.md`, `docs/sandbox.md`
- Supersedes: proposal 005 (`allowCriticalInDanger`) and proposal 021 (`--dangerously-allow-critical` tunnel propagation)

## Problem

FolderForge 3.0.0 intentionally changes `danger` into a zero-manual-approval mode. That contract removes an escape-hatch toggle and lets authorized HIGH and CRITICAL tools run without approval, but host-shell execution still has the operating-system privileges of FolderForge. Approval removal and host containment must therefore be reviewed as separate controls. The repository also needs an honest record that distinguishes implemented code from human ratification.

## Proposal

1. Ratify this precedence: authorization and agent-facing surface; hard deny and containment; policy-as-code deny; then `danger` allow without approval.
2. Keep explicit deny rules, blocked destructive commands, path/workspace/Capsule boundaries, admin/OAuth authorization, audit durability, and rate limits above the danger bypass.
3. Make `shell_exec` and `process_start` fail closed in danger by default unless `terminal.sandbox.mode` is `docker` or `podman`.
4. Run terminal containers with a digest-pinned, pre-existing image; no pull; no capabilities; no-new-privileges; read-only root; bounded PID/CPU/memory/tmpfs; network disabled by default; only the active workspace mounted read-write at `/workspace`.
5. Keep `terminal.sandbox.requireInDanger: false` as an explicit trusted-host compatibility escape hatch. It does not weaken destructive-command denies.
6. Treat this as post-3.0 hardening until a new release passes the complete verification, migration, and soak gates. Do not rewrite the public `v3.0.0` tag.

## Council findings

### Security

Approved with amendment: zero approval is acceptable only when hard denies remain structurally independent of risk and approval. Arbitrary commands in danger must not silently fall back to host execution. Container isolation reduces blast radius but is not a VM or a defense against a vulnerable runtime/kernel. Digest pinning and `--pull=never` prevent tag drift and surprise downloads; the workspace remains writable by design.

### QA

Approved with amendment: regression coverage must prove (a) danger bypasses approval, (b) host command execution fails closed by default, (c) blocked commands still deny even when the compatibility escape hatch is enabled, (d) container argv has the expected isolation flags and rejects image/cwd escapes, and (e) safe/dev behavior is unchanged. Node 22/24 and supported-OS release gates remain mandatory.

### DX

Approved with amendment: error text must name `terminal.sandbox.mode docker or podman`; configuration docs must include a copyable example and the trusted-host opt-out; `policy_explain` must report the same deny before execution. Existing process-mode users in safe/dev retain their approval-gated behavior.

## Threat surface (Security hat)

- `/workspace` is read-write, so an allowed command can modify the project.
- `network: bridge` intentionally restores egress and should be exceptional.
- Docker/Podman daemon access, host kernel vulnerabilities, malicious images, and writable-mount attacks remain outside FolderForge's guarantee.
- A user who sets `requireInDanger: false` explicitly accepts host execution with that user's OS privileges.
- Container commands do not receive host environment variables through `--env`; runtime-client configuration can still affect the Docker/Podman client itself.

## Test plan (QA hat)

- Unit: terminal launch argv, digest enforcement, resource bounds, cwd containment.
- Policy pipeline: default danger host-shell deny, explicit compatibility opt-out, destructive-command deny, zero approval/audit behavior.
- Integration: `shell_exec` timeout/tree kill remains covered in explicit process mode.
- Config: invalid mode/image/resource values fail before serving.
- Full gates: typecheck, lint, tests, build, docs check, security audit, package smoke, Node 22/24 exact-SHA CI, and release soak for the eventual release candidate.

## Rollback

Revert terminal sandbox integration while preserving 3.0.0's zero-approval policy semantics. If container launch causes an incident, set policy to `safe` or `readonly`; do not disable hard denies. A temporary trusted-host deployment may set `terminal.sandbox.requireInDanger: false`, document the exception, and remove it after remediation.

## Ratification checklist

- [x] Security threat review recorded.
- [x] QA regression matrix recorded.
- [x] DX migration/error contract recorded.
- [x] Implementation and automated tests added on a post-3.0 hardening branch.
- [ ] Independent human security reviewer signs off.
- [ ] Maintainer accepts the breaking/default behavior for the next release.
- [ ] Exact candidate passes Node 22/24 and supported-OS CI.
- [ ] Runtime soak and release evidence are attached.

## Decision log

- 2026-10-04 — Security hat — amend — require container sandbox for danger command execution by default; preserve explicit hard denies.
- 2026-10-04 — QA hat — amend — require fail-closed, argv, compatibility, and unchanged-safe/dev regression tests.
- 2026-10-04 — DX hat — approve with docs — actionable error and explicit trusted-host opt-out required.
- 2026-10-04 — Maintainer/human security reviewer — pending — automated council review is not represented as human approval.
