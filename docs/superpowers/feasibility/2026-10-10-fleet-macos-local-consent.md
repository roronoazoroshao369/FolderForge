# Pre-plan macOS Consent Feasibility Record

**Date:** 2026-10-10
**Related approved written spec:** `docs/superpowers/specs/2026-10-10-fleet-zero-config-trusted-host-consent-design.md` — PR #75, commit `bde1b57c0f421f81be555237927783e283906b06`.
**Experimental PR (DO NOT MERGE):** https://github.com/roronoazoroshao/FolderForge/pull/76
**macOS CI run:** https://github.com/roronoazoroshao/FolderForge/actions/runs/38057786780
**Probe exact commit:** `704ff16fcd72a2ee1cf959965395c99fdd7db0e1`
**Status:** macOS primitive feasibility **PASS**, real operator presence and live Fleet end-to-end **NOT_RUN**.

## Question and architectural decision

Can the owner request `full + danger + trusted-host` in the Fleet UI and approve that exact instance/settings tuple from a separate macOS terminal **without** editing global or child YAML, while remote-only Dashboard/MCP requests cannot self-approve?

**Conditional answer:** the underlying macOS/Node filesystem and TTY primitives are available. Use a narrowly scoped **per-instance, file-backed, locally confirmed grant** outside the agent workspace, read and validated by the running parent. This avoids needing native `getpeereid` bindings or a universally enabled global parent startup flag. The existing `requireInDanger: true` remains the default for all unconsented Fleet instances. The accepted threat boundary covers HTTP/MCP-only attackers without code execution as the parent OS user; it does **not** withstand malicious same-UID code or establish physical human presence.

**Do not mistake feasibility for product readiness:** no permission grant, parent integration, real interactive local Mac acceptance or crash-recovery test was built by the spike.

## Evidence ledger

| Gate | Result | Evidence / limit |
| --- | --- | --- |
| Hosted macOS runtime | **PASS** | `macos-latest`, `darwin`, Node `v22.23.2`, workflow `38057786780`, job `114229695372` |
| Required Node POSIX constants | **PASS** | `O_NOFOLLOW`, `O_EXCL`, `O_CREAT`, `O_RDONLY`, `O_WRONLY` detected |
| Owner-only directory | **PASS** | temp directory `0700`, `lstat().uid === process.getuid()` and no group/other bits |
| Creation/readback/file sync | **PASS** | `O_CREAT | O_EXCL | O_NOFOLLOW`, `0600`, `fstat` UID, regular file, `nlink === 1`, `FileHandle.sync()` |
| Symbolic-link refusal | **PASS** | open through symlink with `O_NOFOLLOW` rejected |
| Noninteractive execution | **PASS** | CI stdin not a TTY; helper eligibility probe rejects it |
| Actual interactive owner approval | **NOT_RUN** | CI runner cannot certify a human at the user's Mac; manually verified local acceptance is required before product merge |
| Same-UID attacker resistance | **NOT_CLAIMED** | Arbitrary code as service UID can imitate a TTY and access same-UID files; explicitly excluded |
| Complete Dashboard → local helper → grant → Fleet start | **NOT_RUN** | Product implementation pending plan approval |
| APFS directory fsync / crash power-loss durability | **UNVERIFIED** | macOS file fd `fsync` was checked; directory-entry ordering and `F_FULLFSYNC` were **not** proven. Must test chosen transaction protocol on macOS and fail closed if unsupported |
| Linux qualification | **NOT_RUN** | separate platform gate after macOS path |
| Windows qualification | **UNSUPPORTED** | no supported local consent path without independent ACL/security design |

## Primary sources checked

- Apple Secure Coding Guide — race-resistant file handling, `O_NOFOLLOW`, `fstat`, ownership: https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html
- Apple `open(2)` — `O_EXCL`, `O_NOFOLLOW`: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html
- Apple `fsync(2)` — limits of power-loss guarantees and `F_FULLFSYNC`: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html
- Apple macOS file ownership/ACLs: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html
- Node 22 `fs` constants/permissions: https://nodejs.org/download/release/v22.18.0/docs/api/fs.html
- Node 22 TTY behavior: https://nodejs.org/download/release/v22.18.0/docs/api/tty.html
- Apple `getpeereid` exists for native UNIX sockets but Node.js does not expose it as an officially documented `net.Socket` credential API; do not rely on this API without a dedicated native adapter: https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html

## Selection and constraints for planning

1. Prefer a **same-UID owner-only file handoff** for the opt-in helper and running parent, rather than an HTTP `localhost` callback. No browser API may mint grants; request IDs are not grants. Use a host-operator directory outside the project root (on macOS, a per-user Application Support directory can be considered), and prove this location is absent from all agent file access roots.
2. The local helper checks `stdin.isTTY`, reads an explicit answer and securely updates a one-shot, exact-scope operator grant. The running parent re-validates the grant before profile commit and each start; it must not rely on a startup-wide cached true bit. **TTY is not physical presence.**
3. Store grants and Fleet state separately from API-visible data. Use `open` with no-follow/exclusive flags, descriptor `stat`, correct owner/mode/link count, symlink defense and explicit ownership checks. Refuse unsupported mount/ACL conditions; do not overclaim macOS POSIX permission checks as proof of same-UID isolation.
4. Journal multi-file updates under lock. Never describe two distinct renames as atomic. Test directory sync and APFS write ordering explicitly; if fsync or durable renames cannot satisfy the approved recovery invariant, use a single authoritative manifest/pointer with deterministic regeneration of YAML, **requiring amendment and reapproval of the written spec** before product implementation diverges.
5. macOS **real-user interactive acceptance** (not the hosted CI probe) remains a merge-blocking external gate. Before any product merge verify denied remote-only grant minting and a local owner confirmation on a real Mac, then apply/read-back and revoke. Without that evidence: `MACOS_OPERATOR_ACCEPTANCE=UNVERIFIED`, release blocked.
6. No global `terminal.sandbox.requireInDanger: false` auto-write, no untrusted HTTP approval endpoint, no public tunnel auto-elevation and no automatic stopping of active jobs.

## Verdict

**Pre-plan platform primitive feasibility: PASS WITH EXPLICIT LIMITATIONS.** Sufficient to choose a file-backed local consent design and draft a TDD implementation plan; **not sufficient to execute, approve or ship** the product. The product execution plan must start with another macOS operator-channel engineering gate and stop if the actual host behavior or crash consistency differs from the approved spec.

This report is a research/evidence artifact, not a product feature or claim that owner consent already works.
