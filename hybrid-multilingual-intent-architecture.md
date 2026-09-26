# Kế hoạch Thực thi Kiến trúc Nhận diện Ý định Đa ngôn ngữ Lai (Hybrid Intent Architecture)

## Goal
Chuyển đổi cơ chế nhận diện ý định và cấp quyền công cụ sang Kiến trúc Lai (Language-Agnostic Gateway + Model Self-Directed Transition), hỗ trợ 100% mọi ngôn ngữ (Anh, Việt, Nhật, Pháp, v.v.) mà không phụ thuộc vào từ điển từ khóa thủ công.

## Tasks
- [x] **Task 1: Chuẩn hóa `ClassificationEngine` thành Language-Agnostic Intent Gateway**
  - Sửa đổi [`src/control/classification-engine.ts`](file:///D:/AgentLearn/CodingAgent/src/control/classification-engine.ts): Chuyển logic phân loại sang mô hình phủ định an toàn (Negative Safety Constraints): Mọi yêu cầu không có chỉ định cấm sửa code mặc định được coi là tác vụ coding hợp lệ (`taskClass: 'feature'`), khởi đầu ở phase an toàn (`explore`/`plan`), loại bỏ việc rơi nhầm vào `question`.
  - → Verify: Kiểm tra các prompt đa ngôn ngữ (Anh, Việt, Pháp, Nhật) đều được phân loại `taskClass: 'feature'` hoặc `'bugfix'`, sẵn sàng cho chu trình chuyển pha.

- [x] **Task 2: Mở rộng khả năng chấp nhận chuyển pha trong `phase-lifecycle.ts`**
  - Sửa đổi [`src/agent/phase-lifecycle.ts`](file:///D:/AgentLearn/CodingAgent/src/agent/phase-lifecycle.ts): Đảm bảo `requestPhaseTransition` hỗ trợ chuyển pha linh hoạt cho mọi tác vụ phát sinh nhu cầu sửa mã khi đã có `evidenceRefs`.
  - → Verify: Kiểm tra hàm `requestPhaseTransition` chấp thuận yêu cầu chuyển sang `implement` cho cả các tác vụ khởi đầu đa dạng khi có bằng chứng.

- [x] **Task 3: Cập nhật chỉ dẫn chuyển pha trong `CognitiveHarness` & Dynamic Prompting**
  - Sửa đổi [`src/agent/cognitive-harness.ts`](file:///D:/AgentLearn/CodingAgent/src/agent/cognitive-harness.ts): Thêm chỉ dẫn phổ quát trong scaffold hướng dẫn LLM chủ động gọi `request_phase_transition` khi đã hoàn thành khảo sát và sẵn sàng tạo/sửa tệp.
  - → Verify: Kiểm tra chuỗi prompt scaffold được sinh ra chứa chỉ dẫn chuyển pha rõ ràng, mạch lạc.

- [x] **Task 4: Xây dựng bộ Unit Tests kiểm chứng Đa ngôn ngữ (Multilingual Test Suite)**
  - Sửa đổi [`src/control/classification-evidence-gate.test.ts`](file:///D:/AgentLearn/CodingAgent/src/control/classification-evidence-gate.test.ts) và [`src/control/this-turn-tool-gate.test.ts`](file:///D:/AgentLearn/CodingAgent/src/control/this-turn-tool-gate.test.ts): Thêm test cases kiểm thử các ngôn ngữ: Tiếng Anh, Tiếng Việt, Tiếng Pháp, Tiếng Nhật, Tiếng Tây Ban Nha, Tiếng Đức.
  - → Verify: Chạy `npx tsx --test src/control/classification-evidence-gate.test.ts src/control/this-turn-tool-gate.test.ts` đạt 100% pass.

- [x] **Task 5: Chạy kiểm thử hồi quy toàn diện hệ sinh thái**
  - Chạy toàn bộ 7 test suites: `npx tsx --test src/control/this-turn-tool-gate.test.ts src/agent/phase-lifecycle.test.ts src/agent/step-prompt-policy.integration.test.ts src/agent/pareto-evidence-policy.test.ts src/control/classification-evidence-gate.test.ts src/control/runtime-recovery-policy.test.ts src/agent/completion-policy.test.ts`.
  - → Verify: Toàn bộ 52/52 test cases đạt kết quả 100% pass, không còn bất kỳ lỗi lệch pha hay kẹt quyền hạn nào.

## Done When
- [x] Mọi prompt bằng bất kỳ ngôn ngữ nào (Anh, Việt, Pháp, Nhật, Tây Ban Nha, Đức...) đều được nhận diện chính xác và khởi tạo vòng đời tác tử an toàn.
- [x] LLM tự chủ chuyển sang phase `implement` thông qua `request_phase_transition` trên mọi ngôn ngữ mà không cần thêm từ khóa regex mới.
- [x] Toàn bộ 52/52 test suites đơn vị và tích hợp vượt qua 100%.
