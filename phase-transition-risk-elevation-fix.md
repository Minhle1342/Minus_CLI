# Kế hoạch khắc phục triệt để lỗi "Lệch pha khi gọi tool" và kẹt Risk Floor R0

## Goal
Khắc phục triệt để hiện tượng kẹt `risk: R0` sau khi chuyển sang phase `implement`/`verify` khiến các công cụ đột biến mã nguồn (`create_file`, `write_file`, `replace_text`, v.v.) bị từ chối quyền, đồng thời chuẩn hóa nhận diện intent tiếng Việt trong `ClassificationEngine`.

## Tasks
- [x] **Task 1: Cập nhật `applyPhaseAuthority` nâng Risk Floor & Reversibility**
  - Sửa đổi [`src/agent/phase-lifecycle.ts`](file:///D:/AgentLearn/CodingAgent/src/agent/phase-lifecycle.ts): Khi `authority.phase` là `'implement'` hoặc `'verify'`, tự động nâng `risk: 'R0'` lên tối thiểu `'R1'` và chuyển `reversibility` từ `'read-only'` sang `'reversible'`.
  - → Verify: Kiểm tra hàm `applyPhaseAuthority` với input `{ risk: 'R0', phase: 'explore' }` và session có `phase/transitionAccepted(implement)` trả về `{ phase: 'implement', risk: 'R1', reversibility: 'reversible' }`.

- [x] **Task 2: Mở rộng từ khóa nhận diện Coding Intent tiếng Việt trong `ClassificationEngine`**
  - Sửa đổi [`src/control/classification-engine.ts`](file:///D:/AgentLearn/CodingAgent/src/control/classification-engine.ts): Bổ sung các cụm từ như `viet code`, `lap trinh`, `xay dung`, `tao trang web`, `viet script` vào `mutationIntent`.
  - → Verify: Chạy unit test kiểm tra prompt `"Viết code cho index.html"` và `"Hãy lập trình ứng dụng..."` được phân loại đúng `taskClass: 'feature'` thay vì `question`.

- [x] **Task 3: Viết Unit Tests kiểm chứng trong `phase-lifecycle.test.ts`**
  - Sửa đổi [`src/agent/phase-lifecycle.test.ts`](file:///D:/AgentLearn/CodingAgent/src/agent/phase-lifecycle.test.ts): Thêm test case xác nhận chuyển pha từ `plan`/`explore` (với `risk: R0`) sang `implement` sẽ mở khóa đầy đủ quyền hạn sửa mã.
  - → Verify: Chạy `npx tsx --test src/agent/phase-lifecycle.test.ts` đạt 100% pass (5/5 tests).

- [x] **Task 4: Viết Integration Tests kiểm chứng `ThisTurnToolGate` & `create_file`**
  - Sửa đổi [`src/control/this-turn-tool-gate.test.ts`](file:///D:/AgentLearn/CodingAgent/src/control/this-turn-tool-gate.test.ts): Thêm test case kiểm tra `ThisTurnToolGate.decide()` cấp phép cho `create_file`, `write_file`, `replace_text` ngay sau khi apply authority của phase `implement`.
  - → Verify: Chạy `npx tsx --test src/control/this-turn-tool-gate.test.ts` đạt 100% pass (8/8 tests).

- [x] **Task 5: Chạy kiểm thử hồi quy toàn bộ hệ sinh thái Tool Gating & Phase Lifecycle**
  - Chạy toàn bộ 7 test suites liên quan: `npx tsx --test src/control/this-turn-tool-gate.test.ts src/agent/phase-lifecycle.test.ts src/agent/step-prompt-policy.integration.test.ts src/agent/pareto-evidence-policy.test.ts src/control/classification-evidence-gate.test.ts src/control/runtime-recovery-policy.test.ts src/agent/completion-policy.test.ts`.
  - → Verify: Toàn bộ 51/51 tests vượt qua thành công với 0 lỗi rò rỉ hoặc chặn nhầm tool.

## Done When
- [x] Khi ở phase `plan` hoặc `explore`, các tool đột biến (`create_file`, `replace_text`) bị chặn đúng thiết kế.
- [x] Sau khi gọi `request_phase_transition(targetPhase: 'implement')` được chấp thuận, `create_file` và toàn bộ công cụ sửa mã được cấp phép đầy đủ và thực thi thành công ở phase `implement`.
- [x] Toàn bộ 51/51 unit & integration tests liên quan đến phase lifecycle, tool gating, completion policy và prompt policy đều pass 100%.
