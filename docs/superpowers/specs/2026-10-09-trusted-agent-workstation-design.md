# Trusted Agent Development Workstation — Program Architecture

- **Ngày:** 2026-10-09
- **Trạng thái:** DRAFT FOR MAINTAINER REVIEW — chiến lược B/North Star đã được duyệt; **spec này chưa được duyệt, không cho phép implement**
- **Dự án:** FolderForge — `roronoazoroshao369/FolderForge`
- **Baseline đọc trực tiếp:** `main@3337d714f8d75c9e7586f99c5a37b3f446141116`, CI `37880351065` SUCCESS 6/6 matrix jobs, npm `@musashishao/folderforge@3.0.1`
- **Nguyên tắc vận hành:** `docs/stability-policy.md` vẫn có hiệu lực; số hiệu 4.0 chỉ là **North Star**, không phải quyết định nâng major hay chấp thuận release.

## 1. Ý định đã được duyệt và giả định cần kiểm chứng

Người duyệt chọn chiến lược B thay vì xây một MCP gateway thuần túy hoặc một all-in-one enterprise AI platform. FolderForge phải trở thành **local-first Trusted Agent Development Workstation**: một tầng thực thi/kiểm soát cho nhiều AI coding clients, có thể hoàn thành nhiệm vụ phát triển thực tế một cách có kiểm chứng, dưới quyền hạn được giới hạn, có thể truy vết và phục hồi sau lỗi.

**Người dùng chính:** developer cá nhân làm việc với ChatGPT, Claude, Codex, Cursor hoặc MCP client tương đương; kế đến là nhóm phát triển nhỏ muốn kiểm soát và xem lại kết quả của AI. Enterprise/multi-tenant và marketplace không nằm trong phạm vi giai đoạn này.

**Giả định thiết kế (cần beta chứng minh):** giá trị sản phẩm đến từ *correct, safe and reviewable task completion* hơn là số tool; người dùng ưu tiên luồng first-task ngắn, trạng thái rõ ràng, rollback an toàn, log dễ hiểu. Chưa có dữ liệu người dùng độc lập xác nhận các giả định này.

**North Star Metric đề xuất:** `verifiedTaskCompletionRate = accepted_end_to_end_tasks / eligible_attempted_tasks`, với denominator định nghĩa trước khi chạy thử; báo cáo thêm tỷ lệ unwanted mutations, uncertain outcomes, mean time to recover, unaided first-task completion và chính xác mức độ external-evidence. Không làm đẹp mẫu bằng loại bỏ thất bại.

## 2. Các hướng đã cân nhắc

| Phương án | Giá trị | Rủi ro | Quyết định |
| --- | --- | --- | --- |
| A — Governance engine | Hẹp, đơn giản hóa tuân thủ bảo mật | Ít khác biệt với các MCP gateways, chưa giải quyết phát triển trọn vòng | Dùng làm nền |
| B — Trusted Agent Development Workstation | Reuse policy/audit/capsule/isolation/workflow/proof; sản phẩm tập trung vào kết quả | Cần E2E thật và UX nhất quán | **Được người dùng duyệt làm chiến lược** |
| C — All-in-one agent platform | Rộng về thị trường và tính năng | Bùng nổ scope, khó kiểm soát third-party/hosting/HA | Không theo đuổi ở giai đoạn này |

Chiến lược B **không** đồng nghĩa với việc người dùng đã phê duyệt mọi thay đổi kỹ thuật, security posture, UI hoặc public release.

## 3. Existing building blocks và trust boundaries

| Capability có thật | Vị trí hiện tại | Vai trò trong North Star | Giới hạn hiện tại |
| --- | --- | --- | --- |
| MCP transport, tool registry, policy | `src/server/*`, `src/tools/registry.ts`, `src/policy/*` | Entry point và **một** execution authorization pipeline | SDK cài đặt `1.32.1`, latest protocol trong SDK `2025-11-25` |
| Workspace/Capsule | `src/workspace/*`, `src/capsule/*` | Principal/project/session/task/expiry/scope/budget | Enforcement mặc định optional, cần cấu hình đúng |
| Worktree isolation | `src/isolation/worktree-manager.ts` | Không sửa source tree chưa được đồng ý; apply/rollback/discard thuộc operator | 2 historical entries báo active/sourceDirty, worktree path vắng mặt |
| Durable workflow/task | `src/workflows/*` | Plan DAG rõ ràng, checkpoint, ownership, pause/resume | Chưa có compiler NL→plan và không tự replay mutation uncertain |
| Verification + Proof Pack | `src/verification/*`, `src/proof/*` | Passed/failed/skipped/unavailable + immutable local proof | Local proof không phải external CI hay độc lập attestation |
| Operator/Mission Control | `src/operator/*`, `src/dashboard/*` | Monitoring, approvals, frozen writes, containment | Chưa có human usability validation đủ mạnh |
| Child MCP, browser, Godot | `src/adapters/*`, `src/browser/*`, `packages/adapter-godot/*` | Tích hợp mở rộng có policy | Maturity theo `docs/maturity-and-proof.md`; không ép features chưa thành production |
| Distribution | `.github/workflows/*` | CI, artifacts, future trusted publishing | npm 3.0.1 published manual; soak/OIDC/SBOM missing; release.yml failed as designed |

**Security invariants:**
1. Không một tool/task/AI client nào được trực tiếp gọi handler để vượt `ToolRegistry`, `PolicyEngine`, approval, audit hoặc Capsule.
2. `danger` không được chuyển thành implicit host-shell permission; container containment và explicit opt-in vẫn bắt buộc, denylist/root boundary luôn tồn tại.
3. Mọi thay đổi destructive, push, publish, external deployments phải có xác thực, authorization và operator consent phù hợp.
4. `sourceDirty` là dữ liệu *lúc isolation được tạo*, không phải chứng cứ hiện tại của worktree; `active` lifecycle không chứng minh sự tồn tại vật lý.
5. Không tự động retry hoặc replay mutation có `outcome_uncertain` sau timeout, restart hoặc transport disconnect.
6. Approval/cache identity phải gắn tool + canonical args + principal + workspace + client/task/capsule; tránh confused deputy và cross-tenant leakage.
7. Local file checksum/hash chain chưa phải external witness, và CI PASS không biến steps NOT_RUN thành đã qua.

## 4. Kiến trúc đích (reuse-first)

```text
AI Client (planner/judgment; không tạo model mới trong FolderForge)
  |
  | MCP stdio / HTTP (legacy protocol adapter; future modern adapter)
  v
Protocol Adapter & Principal Identity (G59)
  |
  v
Task Intake: objective, acceptance criteria, explicit bounded plan
  |
  v
One ToolRegistry + Policy / Capsule / Approval / Audit (EXISTING)
  |
  +--> Worktree lifecycle & read-only health diagnostics (G58)
  |         |
  |         +--> observed PRESENT | MISSING | UNVERIFIED
  |         +--> immutable identities and recovery evidence
  |
  +--> WorkflowManager + verification + ProofPack (G60)
  |         |
  |         +--> explicit checkpoints / no unsafe replay
  |         +--> result statuses passed / failed / skipped / unavailable
  |         +--> reviewable diff and bounded redacted evidence
  |
  +--> Mission Control operator read/approve/freeze/stop (G61)
  |
  +--> Conformance/security/release evidence (G62)
  |
  +--> Independent beta telemetry on consented evidence (G63)
```

**Không tạo execution engine mới.** WorkflowManager hiện có là hệ thống persistence và step execution duy nhất. AI client bên ngoài tạo/judges plan, FolderForge chỉ nhận plan rõ ràng có validation/authorization. Nếu một context compiler tự động được đề xuất trong G60 thì phải làm một spec riêng trước khi implement, không tự thêm hidden LLM call.

**Execution profiles:** observe là read-only; develop yêu cầu policy/approvals; propose/autopilot trong isolated workspace chỉ có khả năng command execution sau khi đã chứng minh sandbox enforcement + capsule binding. Cho đến lúc đó giữ fail-closed semantics.

**Proof semantics:** task result và Proof Pack bao gồm objective, owner/project, base SHA, worktree identity/health, diff, exact commands/check status, provenance của browser/child outputs, approvals, audit reference và missing/uncertain gaps; kết quả `complete` chỉ khi acceptance predicates đều đạt. Proof Pack không có external signature thì không nhận là attested.

## 5. End-to-end Golden Path đề xuất (G60)

1. User trong client nêu bug trong một repository **disposable** và tiêu chí nghiệm thu; FolderForge `project_analyze` / `code_context` cung cấp bằng chứng để client tạo bounded plan.
2. Một `WorkspaceCapsule` + worktree được tạo; verify path, identity và health trước khi ghi.
3. Client tạo patch transaction có preview; chỉ sau policy + exact approval mới apply.
4. Chạy typecheck/lint/tests/build với bound command sandbox; `project_verify` lưu kết quả; browser test bổ sung **nếu** task có UI.
5. Client review diff và test evidence; failed/skipped/unavailable/uncertain được thể hiện rõ, không bị gán thành passed.
6. Operator quyết định apply/rollback/PR/push. Bước giao GitHub chỉ xảy ra khi integration và quyền thực tế tồn tại; không coi proof pack là PR tự động.
7. Task xuất reviewable outcome, Proof Pack và recovery hint; audit kiểm được cho từng mutation.

**Failure-path bắt buộc:** denied approval, stale capsule, worktree missing, source fingerprint drift, audit storage unavailable, child MCP crash, unknown terminal outcome, duplicate mutation, restart giữa verify, workflow handoff mismatch, transport reconnect. Không silent data loss/replay hoặc output `success` không có bằng chứng.

## 6. Epic partition và phụ thuộc

| Goal | Deliverable của epic | Dependency | Bằng chứng đóng goal |
| --- | --- | --- | --- |
| **G58 — Integrity & Recovery** | Health contract, missing-worktree truthful state, non-destructive operator diagnostic/recovery; giải quyết 2 historical records theo quy trình | Không phụ thuộc epic khác | RED→GREEN regression; fail-closed destructive paths, preserved metadata/identity evidence; không mất dữ liệu |
| **G59 — Protocol Modernization** | Compatibility profile và conformance cho MCP `2025-11-25` + `2026-07-28`; migration không phá client cũ | Có thể nghiên cứu song song G58; implementation sau phân tích interface | Legacy client green + modern schema/transport tests green; negative auth/capability tests |
| **G60 — Golden Path** | One canonical repo bugfix E2E through existing workflow/capsule/verification/proof; no hidden LLM backend | G58 safe isolation, G59 compatibility decision | Public MCP transport E2E + deterministic failure matrix + operator review and proof |
| **G61 — Mission Control UX** | Task timeline, approval/recovery/error explanations, proof navigation, honest health and missing-evidence labels | G58 health + G60 stable outcome contract | Operator scenarios + accessibility/visual tests + external UX evidence |
| **G62 — Reliability/Supply Chain** | CI matrix closure for actual steps, fault injection, 2026 conformance, future reproducible trusted release artifacts | Can incrementally proceed with others; cannot claim certified release before proof | All declared gates actually RUN/PASS; SBOM/provenance/soak on exact **future** release; security sign-offs |
| **G63 — External Beta Validation** | Clean-machine installation, unaided task success, independent client/plugin/protocol reports | G60 stable path; G61 usability; G62 external-release readiness | Verifiable participant records, 3 real MCP clients, ≥30 installations and graduation thresholds from `docs/beta-program.md` |

**G58 first for implementation.** G59 protocol research can run concurrently with G58 *read-only*. No overlapping product implementation without isolated ownership and exact-head CI. G60/G61/G62 each get a separate design review and written implementation plan before execution. G63 requires **real humans**; synthetic agents are useful for regression only, never counted as participants.

### Các epics khác chưa có implementation spec được duyệt

- **G59 contract:** protocol capability/transport adapter boundary; old `initialize`/session/Tasks mapping distinct from new per-request `_meta`, `server/discover`, MRTR, extensions and `tasks/get`/`tasks/update`. Do not map new tasks semantics onto old APIs without explicit version gating.
- **G60 contract:** explicit plan ingestion validation and guarded action lifecycle, not a new agent model.
- **G61 contract:** operator UI must not carry an authorization bypass; read-only status ≠ commit/apply permission.
- **G62 contract:** separate artifact, CI, security, release-authorization evidence; 3.0.1 historical attestation gap cannot be rewritten.
- **G63 contract:** consented minimal telemetry and reproducible tasks, no fabricated social-survey results.

These contracts are **epic charters**, not permission to code. Draft and approve a focused design spec per epic before writing an implementation plan.

## 7. Protocol compatibility research boundary (G59)

Official MCP `2026-07-28` replaces handshake sessions with per-request `_meta` and version negotiation, removes `Mcp-Session-Id`, adds `server/discover`, MRTR and cacheable lists, and relocates Tasks to an extension. Official sources:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/versioning.mdx
- https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md

**Đề xuất:** protocol adapter tách transport version và task semantics, giữ các core execution services version-agnostic. Đánh giá official SDK hiện hành và các client trước khi chọn implementation; không tự đoán API hỗ trợ từ phiên bản dependency cài đặt hiện tại.

**Migration/rollback:** dự kiến giữ legacy transport cho client cũ; modern mode opt-in và conformance-gated. Không được xoá `initialize`/`tasks/list` hoặc `Mcp-Session-Id` trên đường legacy chỉ vì spec mới bỏ chúng.

## 8. Engineering, release và đo lường

**Mỗi goal:** inspect live main → Superpowers discovery và written design approval → written implementation plan approval → RED failing behavior tests → minimal GREEN → regression/fault/security suites → full verify → exact-head CI 6/6 (and explicit NOT_RUN matrix) → reviewed PR → merge → post-merge CI → docs/handoff → branch cleanup khi an toàn.

**Validation classes:**
- Unit/integration, property/fuzz, data corruption, symlink/path escape, simulated crash/replay, audit failure.
- Public MCP transport e2e on real fixture repo; stdio and authenticated HTTP; client capability negotiation.
- Runtime isolation testing Docker + separately real Podman; Windows/macos cannot be certified from Linux jobs.
- Browser visual/accessibility screenshot tests for UI changes.
- Human usability and beta documentation separated from synthetic fixtures.

**Acceptance thresholds (proposed, not observed):** zero unauthorized side effects on deterministic security/fault suite; 100% explicit status coverage for requested verifications; zero unsafe automatic replays; per-OS and per-client clean-install raw results; first-task unaided success ≥80% within 5 minutes among at least 10 unique participants; ≥30 successful unique installations in graduation cohort and ≥95% final-cohort clean install/upgrade. Cohort arithmetic and exclusion rules frozen *before* collection.

**Release posture:** `v3.0.1` npm manually published, without exact-source 24-hour soak or protected OIDC/SBOM release provenance. Never republish it or fabricate missing attestations. Future public releases follow `docs/releasing.md` and explicit maintainer authorization; branch protection and external beta gates stay OPEN until independently fulfilled.

## 9. Explicit non-goals

No custom foundation model or new agent reasoning backend; no auto-publish/npm, remote deletion, auto-merge, forced worktree cleanup, general SaaS multitenancy, public plugin marketplace, HA/active-active worker claims, universal Godot production certification, or tool-count-driven expansion. No freeze override by implication.

## 10. Stage gates and deliverables

1. **Now:** maintainer reviews this program design and first G58 design (`2026-10-09-goal58-isolation-recovery-design.md`). Changes requested are applied to docs only.
2. **After written spec approval:** invoke Superpowers `writing-plans` separately for G58. No product implementation before the written plan is approved and execution path selected.
3. **After G58 delivery:** write and review G59 specific spec and plan, then repeat sequentially for G60–G63. The epic charters above preserve alignment, not approval.
4. **Exit program:** release-readiness and beta-evidence gates must be reported from actual observations; no claim of 4.0/production readiness without all mandatory evidence.
