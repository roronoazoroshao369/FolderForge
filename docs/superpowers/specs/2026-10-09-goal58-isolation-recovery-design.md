# G58 — Managed Isolation Health & Safe Recovery Design

- **Ngày:** 2026-10-09
- **Trạng thái:** DRAFT FOR MAINTAINER REVIEW; không cho phép implementation hoặc xóa dữ liệu
- **Phụ thuộc:** `2026-10-09-trusted-agent-workstation-design.md`; `docs/adr-0011-workspace-capsules-and-isolation.md`; `docs/task-isolation.md`
- **Baseline xác minh:** `main@3337d714f8d75c9e7586f99c5a37b3f446141116`. Mô tả dưới đây chưa phải kết quả root-cause forensic hay kết quả sửa lỗi.

## 1. Bug report và user harm

`isolation_list` trả về hai record historical:

| id | taskId | lifecycle | sourceDirty lúc tạo | working directory quan sát |
| --- | --- | --- | --- | --- |
| `iso_b158d434167e4eb8b283` | `mission-control-agent-loop` | `active` | `true` | không tồn tại trong checkout hiện tại |
| `iso_0e1294c275b34225a61f` | `canonical-path-identity` | `active` | `true` | không tồn tại trong checkout hiện tại |

`git worktree list --porcelain` chỉ thấy worktree `main`. Hai record tạo từ tháng 8–9/2026. Trạng thái "active" là **lifecycle metadata**, không xác nhận path/branch hiện tồn tại; `sourceDirty` mô tả thời điểm tạo, không xác nhận source hiện dirty.

**User harm:** UI/client dễ hiểu nhầm recovery task khả dụng, `status`/`diff` có thể lỗi muộn khi đường dẫn không còn; một operator có thể thao tác nhầm nếu hệ thống coi persisted metadata là chứng cứ vật lý. Không khẳng định ai đã xóa thư mục, dữ liệu đã mất hay các nhánh đã được merge nếu chưa điều tra.

## 2. Current behavior và giới hạn thực tế

- `WorktreeManager.list()` hiện lấy các record persisted, không chứng minh worktree hiện hữu.
- `WorktreeManager.status()` gọi `assertWorktreePresent` và từ chối khi missing. Đây là fail-closed *cho status*, nhưng không giải thích đầy đủ trong summary/list.
- `WorktreeManager.apply()` dùng `status` và kiểm tra source fingerprint; `rollback()` dùng applied journal.
- `WorktreeManager.discard()` có lifecycle safety checks, nhưng hỗ trợ trường hợp worktree không tồn tại. Cần nghiên cứu nhánh còn tồn tại, commit unmerged, dữ liệu recovery và source fingerprint **trước** khi coi đường dẫn missing là safe-to-discard.
- Metadata hiện lưu dưới Git common directory ở `.git/folderforge/isolations.json`, có digest và mode 0600. Đây là record quan trọng, không xóa/sửa tay.

## 3. Design choices đã cân nhắc

| Phương án | Ưu | Rủi ro | Quyết định đề xuất |
| --- | --- | --- | --- |
| A — Auto-prune missing entries on startup | Ít trạng thái thừa | Có thể làm mất task history/recovery và báo false clean | Từ chối |
| B — Quan sát health tách biệt khỏi lifecycle, operator recovery rõ ràng | Preserve compatibility, truthful UX, dễ regression | Có thêm trạng thái và guard | **Đề xuất chọn** |
| C — Tự dựng lại worktree tại branch hiện có | Có thể phục hồi nhanh | Không biết dirty/untracked bytes, dễ ghi đè hoặc giả vờ recovered | Chỉ nghiên cứu trong operator workflow riêng, không tự động |

## 4. Health model và contract

**Tách 2 trục:**

- `lifecycle` (persisted, authoritative for workflow transition): `active | applying | applied | rolled_back | discarded`. Không thay thế schema hiện có nếu không bắt buộc.
- `observedHealth` (ephemeral/read-only; không tự rewrite persisted state):
  - `present_consistent`: path tồn tại, có Git registration, canonical root đúng, branch/ref và repository ownership khớp;
  - `missing_worktree`: path không tồn tại và không có registration phù hợp;
  - `identity_mismatch`: tồn tại path nhưng Git repo/branch/common dir không khớp, có symlink/path escape;
  - `unverifiable`: permission denied, Git unavailable, corrupt ref/IO hoặc kết quả quan sát không chắc chắn;
  - `terminal_record`: đã discarded; chỉ để xem audit lịch sử nếu API hiện có cho phép.

**Quy tắc:** health là kết quả snapshot tại một thời điểm, không phải quyền apply hoặc discard. Bất kỳ mutation nào phải kiểm tra lại authoritative identity và fingerprint ngay sát hành động (TOCTOU). Nếu health khác `present_consistent` thì không có apply/discard/rollback destructive tự động.

**API hướng additive:** bổ sung optional `observedHealth` và `observedAt` trong kết quả `isolation_list`/Mission Control, giữ nguyên `state` và các legacy fields. `isolation_status`/`isolation_diff` trên missing path phải trả structured failure với stable error code, không trả fake clean/empty diff. Không tăng số native tools mặc định; nếu cần operator recovery endpoint phải có spec+security review riêng.

**Operator diagnostic:** trả sanitized lý do, đường dẫn canonical dưới repo và trạng thái registration/refs; không lộ raw secrets hoặc file contents, không tự động sửa index Git; sử dụng read-only Git queries, bounded timeouts/outputs. `missing` khác `unverifiable`; không biến IO error thành missing.

## 5. Safe recovery decision tree (v1 không destructive)

1. **Read-only inventory:** kiểm tra state digest/schema, `git common-dir`, real/canonical path, linked worktree registration, actual branch ref, task base/source commit, source current head + changes, rollback journal (nếu có), audit/proof references.
2. **Freeze unsafe action:** nếu bất kỳ identity/IO check nào không chắc chắn, trả `unverifiable`; cấm destructive operations trong nhánh đó.
3. **Classify**, nhưng không tự ý sửa dữ liệu:
   - missing directory + branch exists: có thể có task commit; show recovery candidate, yêu cầu operator review; không mặc định checkout lại.
   - missing directory + branch missing: giữ metadata, ghi recovery unavailable / needs investigation; không giả định task đã merge.
   - path exists nhưng mismatch: hard fail và báo security/identity anomaly.
   - applying/applied với journal missing/corrupt: fail closed; không reverse patch suy đoán.
   - dirty-at-creation hoặc source drift: không cho apply onto source; không stash/reset.
4. **Evidence snapshot (trước mọi action tương lai):** record hashes của state file và rollback artifacts, time/commit/ref observations, approval identity, explicit recovery intent; không sao chép secrets.
5. **Recovery command** (future sub-goal, nếu forensic cho phép): operator-authenticated, explicit confirmation + preflight, không overwrite path/ref đang có; có rollback strategy và regression proof. Không làm trong diagnostic MVP nếu chưa cần thiết.

## 6. Mappings và nơi được phép sửa khi implementation được duyệt

- `src/isolation/worktree-manager.ts` — health inspection helper, bounded read-only observations, mutation-time guard.
- `src/tools/isolation-tools.ts` (kiểm tra exact location khi lập plan) — optional additive fields and stable tool errors; no new high-count tool.
- `src/dashboard/server.ts` và Mission Control frontend — translate present/missing/unverifiable to honest operator labels; no direct Git destructive endpoint.
- `src/doctor/index.ts` — expose aggregate health with remediation text, if compatible with diagnostics version.
- `tests/unit/worktree-manager.test.ts` và `tests/integration/isolation-tools.test.ts` — TDD and contract regression.
- `docs/task-isolation.md`, `docs/mission-control.md`, `docs/CURRENT_FRONTIER.md` — clarify terminology, recovery and migration.

Đây là **candidate paths**, phải xác minh repo live trước khi viết implementation plan. Giữ upstream call chain đi qua policy/approval/audit/Capsule. Không trực tiếp thay đổi internal state JSON từ MCP clients.

## 7. Acceptance matrix: RED trước, GREEN sau

| Fixture / tình huống | Expected observation | Mutation consequence |
| --- | --- | --- |
| Valid worktree + đúng Git registration | `present_consistent` | Legacy operations vẫn hoạt động, có preflight |
| Metadata active, worktree missing, branch exists | `missing_worktree` + branch signal | Không xóa branch, không auto-checkout, no fake clean |
| Metadata active, worktree missing, branch missing | `missing_worktree` + unavailable recovery info | Không xoá metadata |
| Metadata path exists but wrong repo/symlink | `identity_mismatch` | Tất cả destructive paths fail closed |
| Git command permission error | `unverifiable` + stable diagnostic | Không biến thành missing/present |
| Persisted digest corruption | fail-closed như hiện tại | Không auto-repair hay mất audit |
| sourceDirty true at creation | health vẫn quan sát bình thường | apply vẫn bị cấm |
| source HEAD/fingerprint drift | health observational only | mutation-time guard vẫn chặn |
| applied/applying journal missing/tampered | error explicit | Không auto replay/rollback/discard |
| restart after mid-operation | same durable lifecycle, health recomputed | Không duplicate side effect |
| concurrent directory/ref replacement | preflight repeats near mutation | TOCTOU mismatch fail closed |
| no Git repository configured | explicit unavailable | Không tạo giả isolation |

**RED test-first:** tái hiện ít nhất một `isolation_list` trả `active` thiếu truthful health trên fixture độc lập, và chứng minh test thất bại vì behavior chưa có. **GREEN:** test mới pass; source behavior legacy và critical security regressions vẫn pass. Không chỉnh tests để bỏ invariant đang có.

## 8. Operational release/rollback

- Feature gate: mặc định read-only additive health, không auto-mutating migration và không mới quyền operator.
- Data migration: không sửa schema/version persist nếu chỉ cần observation. Nếu v2 metadata cần thiết, phải có migration/rollback spec riêng; không bịa compatibility.
- Fault rollback: revert code/feature gate; giữ nguyên `isolations.json`, recovery journal, branch refs và audit data. Không chạy `git worktree prune` hoặc `git branch -D` trên user-owned/referenced state.
- Human ratification bắt buộc nếu thật sự cần restore/delete historical records. **Tuyệt đối không thực hiện destructive cleanup chỉ từ approval cho North Star.**
- Release gate: no new npm publish/tag; standard future release requirements remain.

## 9. Definition of Done cho G58

1. Failing regression bắt được chính xác inconsistency, kể cả negative/TOCTOU cases.
2. Health observable từ MCP và Mission Control/doctor mà không phá existing client schemas; accessibility/UX smoke nếu thay UI.
3. Không còn false-safe status; không mất worktrees/refs/metadata/rollback artifacts sau restart và fail injection.
4. `npm run verify`, focused security and integration, actual MCP transport smoke, docs check, architecture check và CI exact-head đều PASS; NOT_RUN được báo riêng.
5. Với **hai historical records**: có evidence-based classification; chỉ xử lý sau khi đủ preflight và operator approval; mọi unresolved entries vẫn được báo rõ, không gọi chúng là fixed.
6. PR review, merge, post-merge CI, handoff và chỉ xóa nhánh tạm đã xác minh an toàn.

## 10. Pending review boundary

Đây là **written design draft** được sinh từ chiến lược đã duyệt. Spec cần maintainer review trước khi chạy `superpowers:writing-plans`. Chỉ sau khi implementation plan được duyệt riêng mới chuyển sang TDD/product code. Quyết định chưa thể đưa ra từ audit hiện tại: root cause disappearance, commit reachability của từng branch historical, khả năng khôi phục untracked bytes, và có cần operator restore action riêng hay không; phải điều tra bằng read-only forensic và không suy đoán.
