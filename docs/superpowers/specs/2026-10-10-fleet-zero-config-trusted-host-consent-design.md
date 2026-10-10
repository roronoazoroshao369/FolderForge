# Fleet Zero-Manual-Config Trusted Host — Operator Consent Design

**Date:** 2026-10-10
**Status:** WRITTEN SPEC FOR REVIEW — NOT APPROVED FOR IMPLEMENTATION
**Repository:** `roronoazoroshao/FolderForge`
**Baseline:** `main@560391e0817ae2ef0f1893533595570dfbc76967` (historical npm tag `v3.0.1` is `7104f75f8784423ae2680a9ab80f8ac5a972eef4`)
**Scope:** Fleet instance configuration in Mission Control and local operator consent. **Does not change G59 PRs #71/#72/#74, the existing release, or MCP protocol semantics.**

## 1. User intent and successful outcome

The owner wants to choose **Tool preset = full**, **Policy mode = danger**, and **Terminal execution = Trusted host** for a Fleet instance (e.g. `flt_62699dd5`) through Mission Control, without locating, creating or hand-editing `folderforge.yaml`. The system should save a consistent configuration, arrange a safe restart/apply, and display the effective state. Because trusted host commands run with the **parent FolderForge OS account's permissions**, the owner explicitly approved **one local, on-host operator confirmation**, rather than allowing a remote Dashboard session to self-authorize host execution.

Success:
- No manual YAML editing and no requirement to make the entire parent process default to unsandboxed danger execution.
- An authenticated Dashboard user can **request** the change, but never grant it solely over HTTP, through a bearer token, SSH-tunneled `localhost`, or via MCP tools.
- A local operator confirms the *specific instance, canonical workspace, target profile and machine* once. The app then persists and enforces the authorization for that exact scope until revoked or materially changed.
- The triple selection saves **all-or-nothing**; both pending and effective states are visible; failures are truthful and restart handling does not silently interrupt live work.
- Existing defaults, standalone CLI, Docker/Podman configurations, legacy Fleet records, credentials, and `main` behavior stay intact unless the operator expressly opts in.

## 2. Current verified behavior and root cause

At v3.0.1 and the above main baseline:
- `src/runtime/config.ts` defaults `terminal.sandbox` to `{ mode: 'process', requireInDanger: true }`.
- `src/runtime/container.ts` constructs `FleetManager({ allowTrustedHostExecution: config.terminal.sandbox?.mode === 'process' && config.terminal.sandbox.requireInDanger === false })`.
- `FleetManager.setTerminalExecution()` rejects `trusted-host` without this **parent-startup-wide boolean**, even when the child has authentication. It rewrites the generated `.folderforge/fleet/flt_*.yaml`.
- `packages/mission-control/src/screens/Fleet.tsx` makes up to **three independent** calls (`/fleet/:id/preset`, `/policy`, `/terminal`): it can persist `full` and `danger` before rejecting trusted host. The UI does not show live parent eligibility.
- `/runtime/settings` intentionally accepts **only** command timeout and output size; adding an unsafe `requireInDanger: false` write to this endpoint is not acceptable.
- The user's `.folderforge/fleet/*.yaml` are **generated child-instance files**, not the parent's startup configuration. The product should not ask users to hand-edit either.

The issue is an **operator UX and trust-boundary design limitation**, not a missing dropdown choice or proof that the v3.0.1 security check is defective.

## 3. Options and decision

| Approach | Ease | Safety / limitations | Verdict |
| --- | --- | --- | --- |
| A. Dashboard rewrites global parent YAML and restarts itself | Few clicks | Remote operator may self-elevate, risks restart/secret loss and enables **all** Fleet instances | **Reject** |
| **B. Per-instance local operator consent + automatic generated Fleet config** | One request in UI, one local confirmation, no manual YAML | Requires a small explicit on-host interaction; platform-specific file/OS access checks | **Choose** |
| C. OS-native desktop broker (macOS authorization/biometric, Linux polkit, Windows UAC) | Polished native prompt | Adds signed/native executables, packaging and OS-specific security review; not portable as an immediate patch | Defer to separate qualification |

**Decision:** B is a **new per-instance capability**. Never silently translate the existing global `allowTrustedHostExecution` boolean into a remotely writable flag. Preserve the old startup opt-in as a compatibility path, while adding a separately checked, locally authorized capability only for instances meeting its exact scope.

## 4. Operator workflow and state machine

**Separate state dimensions:** (a) immutable requested tuple and expiry, (b) persisted Fleet tuple/transaction, (c) scope-bound grant and revocation, and (d) observed child/runtime state. Request = `pending | approved | expired | cancelled`; persistence = `unchanged | prepared | committed | recovery_required`; process = `stopped | running_verified | runtime_unchanged | restart_deferred | termination_uncertain`. The Dashboard must not collapse these into one ambiguous `enabled` flag.

1. Fleet > Configure offers `full + danger + trusted-host` with **one Save**, which submits an immutable **proposal** for all three values. Without authenticated operator context, a valid instance, no write freeze and no conflicting transaction, reject before any save. A proposal changes **no effective settings**.
2. The parent creates a high-entropy, single-use request ID (proposed 10-minute expiry) and a digest of the **exact tuple and instance**. The UI shows `Awaiting local operator` with a copyable, **illustrative** command such as `folderforge operator trusted-host approve --request <request-id>`; actual CLI syntax and platform adapter require feasibility validation. The request ID is not authorization.
3. An on-host helper outside HTTP/MCP displays exact instance, canonical workspace, OS account, all proposed values and risk; it requires explicit interactive confirmation, not `--yes`, piped input or an HTTP callback. **TTY is not proof of physical presence or of immunity to malicious processes running as the same UID** (see §5).
4. The parent validates request freshness/non-replay, current instance revision, OS account, installation ID, workspace identity, auth mode, **exact approved tuple digest** and current lease. Under a single lock it commits generated Fleet YAML and Fleet state using crash-recoverable journaling. Two file renames are **not filesystem-atomic**, but no API reader or process start may observe half-recovered state.
5. UI statuses distinguish `Persisted; runtime unchanged`, `Approved; restart required`, `Restart deferred` and `Running and verified`. Automatic graceful restart only if **positive** quiescence evidence covers active tasks, tunnels, children, PID and lease. Otherwise require explicit `Stop and apply`, without disrupting live work.
6. Re-saving an **identical already committed tuple** is idempotent. Any changed preset, policy, terminal profile, auth mode, OS service account, instance or canonical workspace creates a **new intent and new local consent**. A remote actor cannot reuse a grant on an altered request. Cancelling an intent or revoking a grant never renews it.
7. Revocation prevents **future starts immediately**. Existing process enters `revocation_pending`; only confirmed termination produces `revoked_stopped`. If not verified, show `revoked_execution_uncertain` and a persistent alert, block further elevated starts and conflicting updates.

**Grant lifetime:** one consent **per instance and exact tuple**, durable across ordinary restarts until revoked or material scope changes. Never a global/root grant.

## 5. Authorization boundary and threat model

### Protected assets and adversaries

Assets: parent host shell privileges, project files, Fleet credentials, remote tunnel authentication, write-frozen state and audit log. Adversaries: an untrusted browser/origin, a stolen Dashboard token, a malicious MCP client (including OAuth scopes insufficient for operator actions), another tenant/principal, crafted requests and symlink/race attacks on operator files.

**Conditional guarantee:** a remote-only Dashboard/MCP attacker **without execution ability as the parent OS account** cannot create an approved host-execution grant merely by HTTP requests. Arbitrary code execution as that same UID can impersonate the user, simulate a terminal and access same-UID state; **TTY/permissions do not defend against it**. This design supplies an explicit operator UX path and remote-only elevation boundary, **not physical-presence, hardware-bound, or same-UID attacker resistance**. Stronger OS-native/broker-based attestation requires a separate reviewed design.

### Mandatory controls

1. **Remote-only fail-closed:** authenticated HTTP/UI can create/cancel **immutable pending intents only**, never approve, edit/rebind a digest or replay a grant for changed settings. A repeated Save of an identical committed tuple is idempotent; any new tuple requires independent local consent. Preserve the `/runtime/settings` sandbox restriction.
2. **Local consent with stated limitations:** an on-host helper verifies interactive input, expected service user and owner-only operator state outside the project workspace, with symlink and hard-link checks. These measures prevent remote-only HTTP credential elevation but **not malicious same-UID programs**. Fail closed with `LOCAL_CONFIRMATION_UNAVAILABLE` when OS prerequisites cannot be proven. A browser request to `localhost` is not proof of an on-host human.
3. **Scope-bounded capability:** grant includes exact installation identity, service OS account, instance ID, canonical `realpath` workspace identity, **entire exact three-setting tuple digest**, child authentication mode, approving operator identity, time and revocation generation. No reuse across other instances, altered tuples, copied state, workspace relocation or service account changes. A changed OS service user must confirm again and cannot inherit a prior grant.
4. **Single-use and expiry:** consent request has CSPRNG identity, fixed TTL, one-time consumption, bounded parallel pending requests and denial/replay audit. For a successfully applied grant, persistence is explicit until revocation or material profile/identity change; a stale pending request cannot approve a newer proposal.
5. **Authenticated execution:** trusted host cannot start if child auth is `none`, token/OAuth/gateway requirements are missing, or parent authorization/grant verification fails. A pre-existing running instance is never silently upgraded; actual child `terminal.sandbox` must match the approved profile at start. Existing hard-denies, worktree policy, workspace authorization for native tools, audit, rate limits and ordinary OS file permissions remain enforced. The parent checks consent again on every start/restart and must not use a last-known-true cached answer.
6. **No privilege via remote helpers:** no general `shell_exec`/admin HTTP/MCP tool can invoke an authorization bypass or mint a valid grant. Do not build authorization by merely adding a writable flag to `fleet.json` or `.folderforge/fleet/flt_*.yaml`. All new operator state is excluded from agent-accessible file APIs, logs and exports; acknowledge that same-UID arbitrary shell access defeats process-local filesystem isolation.
7. **Dashboard and CSRF:** sensitive intent endpoints require authenticated operator privileges, explicit same-origin CSRF defense, strict method/content type and bounded payload; lack of a dashboard token/verified admin session must block elevation with actionable setup UI, not auto-enable it. Do not accept a query-string token as sufficient proof for approving a host grant. Reuse the existing policy/audit operator dispatch for allowed configuration changes.
8. **Integrity and audit:** bind challenge to canonical settings and instance fingerprint, perform authorization check *at commit and start*, redact secrets and full sensitive payloads; record request, local approval, apply success/failure, revoke, start and denied replay with causally linked IDs and truthful outcome. If high-risk audit durability is unavailable, fail closed.
9. **Write freeze and shutdown:** write freeze blocks new elevated intents, approvals, applies and starts. Revocation blocks **future elevated starts immediately**; an existing process enters `revocation_pending` until verified terminated. If termination is uncertain, retain `revoked_execution_uncertain` / `OUTCOME_UNCERTAIN`, block further elevated starts and conflicting updates, alert operator; do not claim the process stopped. Preserve orphan/tunnel lease fencing.
10. **Existing explicit-startup opt-in:** retain documented compatibility for existing host-owned startup YAML, but do not propagate it automatically to instances that choose `sandbox-required`. Do not weaken the default `requireInDanger: true` for unconsented instances.

## 6. Interfaces and data ownership (design, not implementation)

- **`src/operator/trusted-host-consent.ts`** (new) — pending intents, local operator verification, scoped grants, revocation, durable/audited state, platform-specific protected storage adapter. No remote code execution.
- **`src/runtime/container.ts`** — inject a **per-instance authorization resolver** into FleetManager alongside legacy startup opt-in; expose only redacted effective status to the Dashboard. Do not mutate the global `config.terminal.sandbox`.
- **`src/provisioner/fleet-manager.ts`** — add a single `updateProfileAtomically(instanceId, proposal, approvedCapability)` boundary and enforce consent on every trusted-host start. A staged transaction/journal is required because Fleet state JSON and generated instance YAML are two files; a crash must deterministically recover/rollback before allowing execution. Existing separately exposed setters remain compatible but cannot be used to sidestep the new capability.
- **`src/dashboard/server.ts`** — proposed `POST /fleet/:id/profile-intents`, `GET /fleet/:id/profile-intents/:requestId`, `DELETE /fleet/:id/profile-intents/:requestId` and redacted `GET /fleet/:id/execution-authority`. These endpoints manage **intent/status, not grant approval**. Preserve existing `/fleet/:id/*` compatibility; make UI use the atomic flow.
- **`src/main.ts` / operator CLI (illustrative, not a chosen API)** — possible local `folderforge operator trusted-host approve|revoke ...` entrypoints, subject to **macOS-first** feasibility review of the on-host adapter; Linux needs its own gate and Windows is **UNSUPPORTED / fail-closed** until independently proven. If macOS cannot satisfy the conditional contract, revise and reapprove this spec before planning.
- **`packages/mission-control/src/screens/Fleet.tsx`** — clear approved / pending / blocked / unsupported / restart required / running status; one Save operation; explicit threat warning; copyable local command; stable polling while modal open; never present a pending proposal as saved configuration.
- **`docs/mission-control.md`, `docs/sandbox.md`, `docs/security.md`** — reproducible zero-YAML flow, remote tunnel limitations, threat model, platform availability and rollback.

**Wire sketch (subject to implementation-plan pinning):**

```text
Dashboard admin session  --POST intent-->  parent pending store
                                                     |
Local operator terminal --approve request--> guarded local consent adapter
                                                     |
                                             scoped durable grant
                                                     |
                                        atomic fleet profile transaction
                                                     |
                                          supervised stop/start gate
                                                     |
                                         read-back + runtime verification
```

No CLI prompt request token or locally authenticated consent proof is logged in full. Expose structured status and bounded error categories, not grant secrets.

## 7. Transaction, concurrency, failures and rollback

- Immutable proposal includes `{toolsPreset,policyMode,terminalExecution}` and instance revision, auth mode, OS service account, installation, canonical workspace and revocation generation. Only a grant matching that **exact digest** authorizes commit; creating a new remote intent does not extend a grant.
- **Crash-consistent, not a multi-file atomic rename:** one per-instance lock covers **all** existing Fleet readers, setters and child starts. Stage generated YAML and Fleet JSON with 0600 permissions. Write/fsync a two-phase `PREPARED` journal containing old state, authorized new hashes and recovery policy; fsync staged files/directories; rename under lock; fsync directories; durably mark `COMMITTED`; read both files back. If interrupted, recover to old **or fully approved new tuple** before Fleet reads/starts. On unrecoverable ambiguity, set `RECOVERY_REQUIRED` and prevent starts. A response claiming success requires a durable commit and verified read-back.
- Protect credential-bearing YAML: preserve auth details, reject symlink/hard-link substitution, prevent temp data exposure and redact sensitive diagnostics.
- Disk full, failed audit, crash, concurrent edits, write freeze, stale identity, invalid journal or revoked/expired consent **must never produce a reported successful partial update**. Where rollback cannot be proved, prevent execution and surface recovery required.
- **Persisted settings and runtime execution are distinct.** For running children without proven quiescence, leave process unchanged and display `Persisted; runtime unchanged` / `restart_deferred`. Unknown leases, open tunnels or unfinished tasks prohibit automatic restart. Failed restart cannot undo already executed host commands; show observed process and persisted config separately.
- **Revocation is asynchronous for running processes:** deny new starts immediately, enter `revocation_pending`, and transition to `revoked_stopped` only on verified termination; on failure persist `revoked_execution_uncertain` and require operator containment.

## 8. Security and TDD qualification (required before any implementation merge)

All tests must use **RED → GREEN**, deterministic fake OS/platform seams, verified raw HTTP and live Fleet process behavior; not solely pure unit tests.

| Gate | Required cases and outcome |
| --- | --- |
| Config/default compatibility | Existing no-YAML parent and historical `v3.0.1` Fleet load safely. `sandbox-required` and `requireInDanger: true` are unchanged; legacy explicit startup opt-in remains. |
| Remote cannot elevate | Authenticated remote Dashboard can create intent **only**, not approve. Unauthenticated Dashboard / stolen request ID / injected localhost headers / OAuth low-scope / MCP tool calls / CSRF / CORS / query token cannot mint consent. |
| Local host consent | Genuine accepted local interactive confirmation is owner/installation/instance/digest bound; noninteractive, wrong-user, fake/expired/replayed request, symlink file, invalid ownership or unsupported ACL fail closed. State exactly what local same-UID attackers can bypass. |
| All-or-nothing persistence | Force failure on second file write, rename, journal fsync, kill during commit, revoked grant, concurrent config edit or credential rotation. Recovered state equals old or fully committed new tuple, and dashboard never shows success for partial state. |
| Execution boundary | Without consent, `danger + process` shell stays denied. With valid consent, only the selected authenticated Fleet instance may run host shell; other Fleet instances, auth=`none`, other project root, copied fleet.json, expired/revoked capability and restarted parent remain denied. Test real PID control and effect after restart. |
| Active work / lifecycle | No auto disruption of live task/tunnel, safe drained restart, stale lease, orphan, repeated Save/start race, terminal changes while running and denial when write freeze active. Revocation must verify stop or report uncertain. |
| UX and accessibility | One Save; pending local confirmation; status polling; success only after actual runtime read-back; no unexpected partial saves. Disabled states and precise errors, keyboard accessibility, no raw secrets rendered. |
| Platforms | **macOS first** real-host acceptance; **Linux** separately qualified; **Windows UNSUPPORTED** pending OS ACL/identity proof. Node 22/24 matrix green cannot certify operator presence; skipped checks remain NOT_RUN/UNVERIFIED. |
| Regression, governance | Full `npm run verify`, stdio/HTTP/auth smokes, docs/architecture checks, exact-final-head PR CI, independent security review of local proof/tenant boundary, unchanged G59 branches and isolation hashes. |

**Evidence classes:** automated RED/GREEN unit/integration tests qualify logic; real macOS interactive operator acceptance is an **external merge-blocking gate**; Linux is separate and Windows stays `UNSUPPORTED` until qualified. A fixture cannot prove physical presence or same-UID resistance. Skipped test steps remain `NOT_RUN`, never PASS.

## 9. Delivery stages and approval gates

1. **Spec gate (current):** owner reviews this written design. Only a docs PR; NO implementation code yet.
2. **Pre-plan feasibility checkpoint:** prove conditional remote-only protection and an operable on-host consent adapter on **macOS first**, then Linux. If macOS fails, revise and reapprove this spec **before writing an implementation plan**. Windows stays `UNSUPPORTED` until a separate ACL and identity gate qualifies it.
3. **Plan gate:** separate reviewed Superpowers implementation plan with ordered TDD tasks, exact touched files, rollback procedures, and Native execution choice; new security-sensitive runtime code requires this explicit approval.
4. **Product gate:** isolated product PR; deterministic RED/GREEN, full local test gate, latest exact-head CI, independent security review, compatibility proof, no release on green CI alone.
5. **Merge gate:** separately authorized merge and post-merge CI verification, then docs closeout. Never merge existing G59 Draft PRs, delete historical isolation data, expose unauthenticated host shell, tag or publish npm as a side effect.

**Explicitly deferred:** generic OS-wide approval service, hardware-backed physical-presence attestation, arbitrary browser privilege escalation, silent conversion of existing Fleet instances, remote host management, universal Windows support claims, any G59 modernization code, and production release.

## 10. Review checklist

- [x] User's no-manual-YAML intent and one-time on-host confirmation are explicit.
- [x] Default `danger` process containment remains fail-closed; no HTTP-only approval path.
- [x] Consent scope, expiry, revocation and same-UID attacker limitations are explicit.
- [x] Existing Fleet split writes, parent startup latch and generated YAML are addressed.
- [x] Crash consistency (not cross-file atomic rename), observed runtime state, active work and audit durability have acceptance gates.
- [x] Platform feasibility is flagged rather than assumed and no support is overclaimed.
- [x] G59, historical npm release and current `main` remain separate.
- [x] This document contains **no product code or implementation plan**.

**Requested decision:** approve or request revisions to this **written spec**. Approval authorizes drafting a separate implementation plan; it does **not** authorize product coding, merge or release.
