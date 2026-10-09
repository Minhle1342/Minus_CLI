# GitNexus Engineering Plan

> Task: Tích hợp 5 vệ tinh tối ưu hóa ngữ cảnh và chống tràn Rate-Limit (TPM) vào Agent Harness
> Evidence verified at commit 3629a0dff1153fffde6118cd4473d1ae1370338d; GitNexus index 12 commits behind, refresh skipped: runner identity lock on analyzer types.d.ts (source-weighted limitation).
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 6 sorted entries; exact generated plan path excluded.

## 1. Objective

Triển khai đồng bộ 5 cơ chế vệ tinh (Satellites) vào Agent Harness của MinusCLI trực tiếp trên nhánh `develop` hiện tại (không tạo nhánh riêng) nhằm giải quyết triệt để 2 vấn đề chí mạng:
1. **Triệt tiêu hiện tượng phình to token mất kiểm soát (Context Ballooning)** trong các task phức tạp và session dài do log công cụ khổng lồ (`npm test`, `build`, file reads lớn).
2. **Chặn đứng lỗi Rate-Limit (TPM / 429 Resource Exhausted)** do gửi dồn dập các payload token lớn trong thời gian ngắn, bảo vệ vòng lặp agent khỏi các cơn bão thử lại vô ích (retry storms).

Năm vệ tinh bao gồm:
- **Vệ tinh 1 (Observation Virtualization / Spill-to-Disk):** Trích xuất output lớn ra file tạm trên đĩa, chỉ trả về bản rút gọn Head/Tail kèm hướng dẫn truy hồi.
- **Vệ tinh 2 (In-Turn Microcompaction):** Thu gọn có chọn lọc các tool outputs từ các step cũ ($1 \dots N-2$) ngay trong active turn, chỉ giữ nguyên vẹn 2 step gần nhất.
- **Vệ tinh 3 (Token Pacer & Leaky-Bucket Rate Limiter):** Điều tiết nhịp độ gọi API theo sliding-window 60s, chủ động sleep ngắn khi chạm 85% TPM thay vì bị API phạt 429.
- **Vệ tinh 4 (Dynamic Harness Zero-Base Trimming):** Tự động cắt bỏ Graph Repo Map và Scaffold cồng kềnh khi context bắt đầu chạm ngưỡng 50% ngân sách.
- **Vệ tinh 5 (Task Delegation sang Sub-Agent):** Thêm công cụ ủy quyền tác vụ đồng bộ (`delegate_task`) chạy trong sandbox cô lập, chỉ trả về bản tóm tắt tinh gọn (≤500 tokens).

## 2. Current Behaviour

1. **Tool Output thô nạp nguyên vẹn vào Session:**
   - Tại [src/tools/tool-runner.ts:658-735](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-runner.ts#L658-L735), sau khi thực thi tool, toàn bộ `rawResult` được lưu trữ trực tiếp vào `normalizedResult`.
   - Khi một lệnh `run_command` chạy test hoặc `read_file` trả về 30,000 - 50,000 ký tự (8,000 - 15,000 tokens), toàn bộ lượng chuỗi này được ghi nguyên văn vào `session.addToolResultWithId` [agent-loop.ts:3265](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L3265).
2. **Miễn trừ nén 100% cho Active Turn (Active Turn Immunity):**
   - Tại [src/agent/agent-loop.ts:2465-2475](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L2465-L2475), `prepareRequest` cấu hình `protectActiveTurn: true` và đưa toàn bộ message của turn hiện tại vào `protectedMessages`.
   - Tại [src/agent/context-compactor.ts:1220](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/context-compactor.ts#L1220): `if (protectedMessages.has(msg)) return msg;`.
   - Hậu quả: Toàn bộ tool outputs sinh ra trong turn hiện tại (dù turn kéo dài 10-15 steps) được giữ nguyên vẹn 100%, tích lũy theo cấp số cộng làm payload mỗi step tăng phi mã: Step 1 (10k) → Step 4 (40k) → Step 8 (80k tokens).
3. **Active Turn Text Compaction quá hẹp:**
   - [src/agent/active-turn-compaction.ts:16-30](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/active-turn-compaction.ts#L16-L30) chỉ nhắm vào assistant text `role === 'model'` với điều kiện ≥ 12,000 ký tự, không chứa code blocks, và chỉ collapse các dòng lặp liên tiếp. Nó **hoàn toàn không chạm vào Tool Outputs**.
4. **Bị động trước lỗi Rate-Limit 429 (TPM):**
   - Hệ thống không có cơ chế đo lường sliding-window TPM trước khi dispatch request. Khi gửi 3-4 request liên tiếp dung lượng 60,000+ tokens trong 1 phút, hệ thống vượt ngưỡng TPM của Provider (ví dụ Anthropic Tier 1: 40k TPM, Tier 2: 80k TPM; Gemini: 250k TPM).
   - API trả về lỗi 429; `runInternalWithCircuitBreakerRetry` kích hoạt retry nhưng với cùng payload khổng lồ, dẫn đến chuỗi retry storm bế tắc.
5. **Gánh nặng Token từ Harness Dynamic Sections:**
   - Tại [src/agent/agent-loop.ts:2316-2350](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L2316-L2350), `arbitrationInputs` nạp cố định hơn 20 mục (Repo Map ~1,600 tokens, Cognitive Scaffold, Reflection, Memory...) ngốn từ 4,000 - 8,000 tokens overhead ở mỗi request ngay cả khi lịch sử đã bắt đầu chật chội.
6. **Subagent Delegation chưa có dạng đồng bộ cô lập:**
   - [src/tools/subagent-tools.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/subagent-tools.ts) hiện chỉ có `delegate_agent` và `spawn_agent` dạng background async (cần polling qua `wait_agent` / `get_agent_result`), thiếu công cụ thực thi subtask khép kín (run-to-completion) trả kết quả tóm tắt trực tiếp cho agent cha trong 1 turn.

## 3. Relevant Architecture

```
                                 KIẾN TRÚC TÍCH HỢP 5 VỆ TINH
                                 
  [Tool Execution Layer]
    ToolRunner.executeTool() 
       │
       ▼
    [VỆ TINH 1: Spill-to-Disk] ──► Output > 4,000 chars?
       │                            ├─ YES: Ghi .minus/scratch/tool_outputs/{id}.log
       │                            │       Chỉ trả về Head 30 dòng + Notice + Tail 50 dòng
       │                            └─ NO:  Trả về inline bình thường
       ▼
  [Active Turn Management]
    ContextCompactor & ContextBudgetManager
       │
       ▼
    [VỆ TINH 2: In-Turn Microcompaction]
       ├─ Step N & Step N-1: Giữ nguyên vẹn (Sliding window 2 steps)
       └─ Step 1..N-2: Mask tool outputs thành Compact Stubs, lưu payload vào MaskedObservationRecord
       ▼
  [Dynamic Context Arbitration]
    AgentLoop & DynamicContextArbiter
       │
       ▼
    [VỆ TINH 4: Harness Zero-Base Trimming]
       └─ History tokens >= 50% budget?
            ├─ YES: Tắt Graph Repo Map (-1,600 tokens), tắt Cognitive Scaffold, thu gọn Playbooks
            └─ NO:  Giữ đầy đủ hướng dẫn rich context
       ▼
  [Pre-Request Rate Limiter]
    [VỆ TINH 3: RateLimitPacer]
       ├─ Sliding Window 60s: TokensUsedLast60s + NextEstimatedTokens > 0.85 * TPM_Limit?
       │    ├─ YES: Chủ động sleep/delay ngắn (2-6s) kèm log cảnh báo TUI
       │    └─ NO:  Bắn request ngay lập tức
       └─ Ghi nhận token thực tế sau response (usage metadata)
       ▼
  [Task Offloading Layer]
    [VỆ TINH 5: delegate_task Tool]
       └─ SubagentManager chạy child AgentLoop trong Sandbox cô lập
          Chỉ trả về 1 báo cáo tóm tắt (<= 500 tokens) cho Agent cha
```

- **Ranh giới module:**
  - Vệ tinh 1 can thiệp tại chốt chặn cuối của `ToolRunner` trước khi trả kết quả cho AgentLoop.
  - Vệ tinh 2 mở rộng `ContextCompactor` và điều chỉnh bộ lọc `protectedMessages` trong `agent-loop.ts`.
  - Vệ tinh 3 bổ sung module mới `src/agent/rate-limit-pacer.ts` độc lập, được tiêm vào trước lời gọi LLM stream trong `agent-loop.ts`.
  - Vệ tinh 4 tích hợp vào khối tính toán ngân sách và dynamic context trong `agent-loop.ts`.
  - Vệ tinh 5 mở rộng `subagent-tools.ts` và `subagent-manager.ts`.

## 4. GitNexus Findings

- **Primary Symbols:**
  - `ToolRunner` ([src/tools/tool-runner.ts:159](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-runner.ts#L159)) `[verified]`: Caller blast radius = 64 nodes, Risk = `CRITICAL`. Điều phối mọi tool call.
  - `ContextCompactor` ([src/agent/context-compactor.ts:270](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/context-compactor.ts#L270)) `[verified]`: Caller blast radius = 72 nodes, Risk = `CRITICAL`. Quyết định chính sách nén session.
  - `ContextBudgetManager` ([src/agent/context-budget-manager.ts:375](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/context-budget-manager.ts#L375)) `[verified]`: Caller blast radius = 60 nodes, Risk = `HIGH`. Đánh giá ngưỡng kích hoạt compaction.
  - `AgentLoop` ([src/agent/agent-loop.ts:430](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L430)) `[verified]`: Vòng lặp điều phối chính.
  - `SubagentManager` ([src/agent/subagent-manager.ts:80](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/subagent-manager.ts#L80)) `[verified]`: Quản lý vòng đời child subagents.
- **Related Tests:**
  - `src/tools/tool-runner.test.ts`
  - `src/agent/compaction-optimization.test.ts`
  - `src/agent/context-budget-manager.test.ts`
  - `src/test-latency-optimization.ts`
- **Call Relationships & Key Axes:**
  - `AgentLoop` gọi `ToolRunner.executeTool(...)` để chạy tool.
  - `AgentLoop` gọi `ContextBudgetManager.prepareRequest(...)` trước mỗi step request.
  - `ContextBudgetManager` gọi `ContextCompactor.compact(...)` khi chạm `triggerRatio`.

## 5. Statement-Level PDG Findings

- **ToolRunner.executeTool:**
  - *Control dependence:* Khối Stage 5 Output Normalization [tool-runner.ts:657](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-runner.ts#L657) chạy sau khi vòng lặp `while (attempt)` kết thúc thành công `[verified]`.
  - *Data flow:* `rawResult` → `normalizedResult` → `resultSnapshot`.
  - *Constraint:* Việc ảo hóa output (Spill-to-Disk) phải diễn ra TRƯỚC `resultSnapshot` và TRƯỚC `session.addToolResultWithId` để dữ liệu nạp vào session đã là bản rút gọn an toàn `[inferred]`.
  - *Guard requirement:* Phải bảo toàn tuyệt đối các trường trạng thái: `exitCode`, `success`, `error`, `errorCode`, `processStarted` để Evidence Gate và Tool Gate không bị sai lệch `[verified]`.
- **ContextCompactor.compact & protectedMessages:**
  - *Control dependence:* Vòng lặp quan sát [context-compactor.ts:1219](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/context-compactor.ts#L1219) duyệt `workingMessages`:
    `if (protectedMessages.has(msg)) return msg;`
  - *Data flow:* `protectedMessages` bắt nguồn từ `agent-loop.ts:2473` lọc toàn bộ message của `turn`.
  - *Constraint:* Đổi logic bảo vệ thành sliding window 2 step trong turn: chỉ những message thuộc 2 step gần nhất mới vào `protectedMessages`, các step cũ hơn trong active turn được chuyển sang nhánh `microcompactActiveTurnObservations` `[inferred]`.
- **AgentLoop LLM Dispatch Loop:**
  - *Ordering constraint:* `RateLimitPacer.throttleBeforeRequest` phải được gọi ngay trước `this.llm.generateStream(...)` [agent-loop.ts:2650](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L2650) và sau khi `requestFootprint` đã tính xong `estimatedTokens` `[verified]`.

## 6. Proposed Changes

### Vệ tinh 1: Observation Virtualization / Spill-to-Disk
- **File:** `src/tools/tool-runner.ts`
- **Thay đổi:**
  - Thêm hằng số:
    `export const MAX_INLINE_TOOL_CHARS = 4_000;` (~1,000 tokens)
    `export const MAX_INLINE_HEAD_LINES = 30;`
    `export const MAX_INLINE_TAIL_LINES = 50;`
  - Thêm helper `virtualizeToolOutput(rawText, toolName, toolCallId, workspaceRoot)`:
    - Nếu độ dài chuỗi output vượt quá `MAX_INLINE_TOOL_CHARS`:
    - Tạo thư mục `.minus/scratch/tool_outputs/` trong workspace.
    - Ghi toàn bộ nội dung thô ra `.minus/scratch/tool_outputs/{toolCallId}.log`.
    - Cắt Head 30 dòng, chèn thông báo `[STDOUT TRUNCATED: X characters spilled to .minus/scratch/tool_outputs/...log]`, Tail 50 dòng, kèm Tip hướng dẫn đọc log.
  - Áp dụng cho các trường chuỗi lớn (`stdout`, `stderr`, `output`, `content`) trong kết quả tool, giữ nguyên các metadata trạng thái (`exitCode`, `success`, `error`, `errorCode`).

### Vệ tinh 2: In-Turn Microcompaction
- **Files:** `src/agent/context-compactor.ts`, `src/agent/agent-loop.ts`
- **Thay đổi:**
  - Trong `context-compactor.ts`: Thêm phương thức `microcompactActiveTurnObservations(...)` tự động rút gọn các tool outputs của các step $1 \dots N-2$ trong active turn thành observation stubs, lưu bản gốc vào `MaskedObservationRecord`.
  - Trong `agent-loop.ts:2473`: Thay đổi việc truyền `protectedMessages`: Chỉ đưa các message thuộc `step >= currentStep - 1` của turn hiện tại vào danh sách bảo vệ.

### Vệ tinh 3: Token Pacer & Leaky-Bucket Rate Limiter
- **File mới:** `src/agent/rate-limit-pacer.ts`
- **File chỉnh sửa:** `src/agent/agent-loop.ts`
- **Thay đổi:**
  - Xây dựng class `RateLimitPacer`:
    - Lưu trữ danh sách request trong sliding window 60 giây: `Array<{ timestamp: number, tokens: number }>`.
    - Hạn mức mặc định theo provider: Anthropic (40,000 / 80,000 TPM), Gemini (250,000 / 1,000,000 TPM), OpenAI (30,000 / 200,000 TPM); hỗ trợ ghi đè qua `MINUS_TPM_LIMIT`.
    - Phương thức `throttleBeforeRequest(provider, model, estimatedTokens, signal, onPace)`: nếu tổng token trong 60s qua + ước tính token bước tới vượt 85% hạn mức TPM, chủ động delay một khoảng thời gian vừa đủ trượt cửa sổ thời gian (kèm thông báo TUI).
    - Phương thức `recordActualUsage(tokens)`: cập nhật số token thực tế từ response usage metadata.
  - Tích hợp vào `AgentLoop`: Khởi tạo `rateLimitPacer`, gọi trước `llm.generateStream`, và cập nhật sau khi hoàn tất stream.

### Vệ tinh 4: Dynamic Harness Zero-Base Trimming
- **File:** `src/agent/agent-loop.ts`
- **Thay đổi:**
  - Trước khi chuẩn bị `arbitrationInputs`:
    Tính toán tỷ lệ áp lực token lịch sử: `historyPressureRatio = historyTokens / targetUsableInputTokens`.
    Nếu `historyPressureRatio >= 0.50`:
    - Đặt `shouldRenderRepoMap = false;` (tiết kiệm ~1,600 tokens).
    - Đặt `effectiveScaffoldText = undefined;` (tắt System 2 cognitive scaffold lặp lại).
    - Đặt `effectiveAdvicePrompt = undefined;` (tắt tool playbooks tĩnh).
    - Giữ lại chỉ dẫn quan trọng nhất: `instructionHierarchyAnchor`, `phaseGuidance`, `activeTask`, `verificationDirective`.

### Vệ tinh 5: Task Delegation sang Sub-Agent (Synchronous Subtask Tool)
- **Files:** `src/tools/subagent-tools.ts`, `src/agent/subagent-manager.ts`
- **Thay đổi:**
  - Thêm tool `delegate_task` trong `subagent-tools.ts`:
    - Tham số: `task` (mô tả mục tiêu), `allowedTools` (danh sách công cụ cho phép), `maxSteps` (mặc định 6), `verificationCommand`.
    - Thực thi: Gọi `SubagentManager.executeIsolatedTask(...)`.
  - Trong `subagent-manager.ts`: Thêm hàm `executeIsolatedTask(...)`:
    - Tạo `AgentLoop` con với `Session` riêng biệt trong bộ nhớ.
    - Cho subagent chạy độc lập đến khi có final answer hoặc hết step budget.
    - Trích xuất tóm tắt kết quả (tối đa 400 tokens) và danh sách file đã chạm.
    - Trả về cho Agent cha payload gọn gàng `{ success: true, summary: resultSummary, filesModified, durationMs }` mà không làm ô nhiễm context của Agent cha.

## 7. Implementation Sequence

Các bước triển khai độc lập, kiểm thử tuần tự trực tiếp trên nhánh `develop`:

1. **Step 1: Triển khai Vệ tinh 1 (Observation Virtualization / Spill-to-Disk)**
   - Thêm hằng số và logic ảo hóa trong `src/tools/tool-runner.ts`.
   - Viết unit test mới `src/tools/observation-spill.test.ts` kiểm chứng việc cắt Head/Tail và ghi file log cho output > 4,000 ký tự.
   - Chạy regression test `npm run test:completion`.

2. **Step 2: Triển khai Vệ tinh 2 (In-Turn Microcompaction)**
   - Bổ sung hàm rút gọn step cũ trong `src/agent/context-compactor.ts`.
   - Điều chỉnh scope `protectedMessages` trong `src/agent/agent-loop.ts`.
   - Viết test trong `src/agent/in-turn-compaction.test.ts`.

3. **Step 3: Triển khai Vệ tinh 3 (Token Pacer & Leaky-Bucket Rate Limiter)**
   - Tạo file mới `src/agent/rate-limit-pacer.ts`.
   - Viết test `src/agent/rate-limit-pacer.test.ts` kiểm thử tính năng sliding window 60s và throttling.
   - Tích hợp vào `src/agent/agent-loop.ts` trước lời gọi `llm.generateStream`.

4. **Step 4: Triển khai Vệ tinh 4 (Dynamic Harness Zero-Base Trimming)**
   - Cập nhật logic điều tiết tại `src/agent/agent-loop.ts` khi `historyPressureRatio >= 0.50`.
   - Kiểm thử với bài test `npx tsx src/test-latency-optimization.ts`.

5. **Step 5: Triển khai Vệ tinh 5 (Synchronous Task Delegation Tool)**
   - Mở rộng `src/agent/subagent-manager.ts` với `executeIsolatedTask`.
   - Đăng ký công cụ `delegate_task` trong `src/tools/subagent-tools.ts` và `src/index.ts`.
   - Viết test kiểm tra tính cô lập context của subagent trong `src/tools/subagent-delegation.test.ts`.

6. **Step 6: Tổng duyệt & Kiểm thử Hồi quy Toàn diện**
   - Chạy toàn bộ test suite: `npx tsc --noEmit`, `npm run test:completion`, `npx tsx src/test-latency-optimization.ts`.

## 8. Test Strategy

- **Tests to Add:**
  - `src/tools/observation-spill.test.ts`:
    * Scenario 1: Output < 4,000 ký tự → Giữ nguyên inline, không tạo file spill.
    * Scenario 2: Output = 25,000 ký tự → Ghi đúng file log tại `.minus/scratch/tool_outputs/`, inline chỉ chứa 30 dòng đầu + 50 dòng cuối + notice.
    * Scenario 3: Lỗi và exit code khác 0 được bảo toàn nguyên vẹn trong inline payload.
  - `src/agent/in-turn-compaction.test.ts`:
    * Scenario 1: Turn có 4 step → Step 1 & 2 bị microcompact thành observation stubs, Step 3 & 4 giữ nguyên vẹn.
  - `src/agent/rate-limit-pacer.test.ts`:
    * Scenario 1: Tổng token trong 60s < 85% TPM → Không bị delay (0ms).
    * Scenario 2: Tổng token vượt 85% TPM → Tính toán chính xác thời gian sleep cần thiết và trigger callback `onPace`.
  - `src/tools/subagent-delegation.test.ts`:
    * Scenario 1: Subagent chạy 5 bước tiêu tốn 15,000 tokens nội bộ → Agent cha chỉ nhận kết quả tóm tắt < 400 tokens, context cha không tăng đột biến.
- **Verification Commands:**
  - `npx tsc --noEmit`
  - `node --import tsx --test src/tools/observation-spill.test.ts`
  - `node --import tsx --test src/agent/rate-limit-pacer.test.ts`
  - `npx tsx src/test-latency-optimization.ts`
  - `npm run test:completion`

## 9. Risk and Impact Analysis

- **High-Risk Symbols:**
  - `ToolRunner.executeTool`: Nguy cơ làm biến dạng cấu trúc output của các tool đặc thù (`apply_patch`, `update_plan_task`). Khắc phục: Chỉ áp dụng spill đối với các trường văn bản dài của `run_command`, `read_file`, `git_command`, bỏ qua các tool điều khiển plan/transition.
  - `ContextCompactor.compact`: Nguy cơ làm mất bằng chứng cần thiết cho Evidence Gate. Khắc phục: Evidence Gate đọc trực tiếp từ `PlanManager.recordToolEvidence` tại thời điểm tool thực thi, không dựa vào chuỗi text thô trong session sau này.
- **Downstream Consumers:**
  - `AgentLoop` nhận tool result đã được ảo hóa vẫn hiểu rõ ngữ cảnh nhờ Head/Tail preview và đường dẫn file log.
- **Performance & Concurrency:**
  - Ghi file log ra disk sử dụng I/O bất đồng bộ hoặc safe stream để không làm nghẽn Event Loop.
  - RateLimitPacer chỉ tính toán số học trên mảng nhỏ (<50 phần tử), chi phí CPU < 1ms.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `src/tools/tool-runner.ts` | `ToolRunner.executeTool`, `virtualizeToolOutput` | Vệ tinh 1: Observation Spill-to-Disk |
| `src/agent/context-compactor.ts` | `ContextCompactor.compact`, `microcompactActiveTurnObservations` | Vệ tinh 2: In-Turn Microcompaction |
| `src/agent/agent-loop.ts` | `AgentLoop.prepareRequest`, `AgentLoop.runInternalWithCircuitBreakerRetry` | Vệ tinh 2, 3, 4: Scoping protected messages, Token Pacing, Zero-Base Trimming |
| `src/agent/rate-limit-pacer.ts` (Mới) | `RateLimitPacer` | Vệ tinh 3: Leaky-bucket rate limiter theo sliding window 60s |
| `src/tools/subagent-tools.ts` | `createDelegateTaskTool` | Vệ tinh 5: Synchronous task delegation tool |
| `src/agent/subagent-manager.ts` | `SubagentManager.executeIsolatedTask` | Vệ tinh 5: Isolated sandbox task runner |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: 'Tích hợp 5 vệ tinh tối ưu hóa ngữ cảnh và chống tràn Rate-Limit (TPM) vào Agent Harness trên nhánh develop'
  acceptance_criteria:
    - 'Tool outputs vượt quá 4,000 ký tự được tự động spill ra .minus/scratch/tool_outputs/*.log và trả về Head/Tail preview an toàn'
    - 'Tool outputs từ các bước cũ (1..N-2) trong active turn được tự động microcompact thành stub'
    - 'RateLimitPacer đo lường token cửa sổ 60s và chủ động delay khi đạt 85% TPM limit thay vì dính lỗi 429'
    - 'Khi token lịch sử đạt >= 50% ngân sách, tự động tắt Repo Map và Cognitive Scaffold'
    - 'Công cụ delegate_task cho phép chạy subtask độc lập và chỉ trả về bản tóm tắt <= 500 tokens'
    - 'Toàn bộ bài test hiện có và bài test mới pass 100%'

  evidence_provenance:
    schema_version: 2
    head_commit: '3629a0dff1153fffde6118cd4473d1ae1370338d'
    generated_plan_path: 'docs/plans/2026-10-09-gitnexus-plan-harness-satellite-integration.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd'
    cited_path_manifest:
      - path: 'src/agent/agent-loop.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:3faca02780b91cb915595f259a9f07a06f52443b0ae142903a52bf0c5299a79f'
        index_digest: 'sha256:3faca02780b91cb915595f259a9f07a06f52443b0ae142903a52bf0c5299a79f'
        worktree_digest: 'sha256:75613c8f3a7ab2a6b60546acf67544a1e4b3e1cf0634743722a0c989c44037d8'
        untracked_digest: 'absent'
      - path: 'src/agent/context-budget-manager.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:7c7367f98e9aad6757b757a0b54350a77c09206ed3815bd80837b82931f8a31c'
        index_digest: 'sha256:7c7367f98e9aad6757b757a0b54350a77c09206ed3815bd80837b82931f8a31c'
        worktree_digest: 'sha256:1a5b78b00bb3d956945e813c23b0d14b0cdb6c418b94710b24f6abf74132f0c5'
        untracked_digest: 'absent'
      - path: 'src/agent/context-compactor.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:3a1a697fff2f68f4789248527f091a0274386d60c580db323de2e17d8c15e57e'
        index_digest: 'sha256:3a1a697fff2f68f4789248527f091a0274386d60c580db323de2e17d8c15e57e'
        worktree_digest: 'sha256:1b91a3f2093b54db75d284f9c03471b2fb00552654a67e4c15a0504ad00928a1'
        untracked_digest: 'absent'
      - path: 'src/agent/subagent-manager.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:94c7389bcf3f577af6c8ab4bfd6de7db3a478327c875e3b1a40ea18ccf3d987f'
        index_digest: 'sha256:94c7389bcf3f577af6c8ab4bfd6de7db3a478327c875e3b1a40ea18ccf3d987f'
        worktree_digest: 'sha256:d0397b0d5b92723a66a7829058157ebe54f7d5ce54b75a7bb6fd7b451699aa08'
        untracked_digest: 'absent'
      - path: 'src/tools/subagent-tools.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:94422147eecafef5ea64062411d9beb51c6366305d52feb885e30cc051c189aa'
        index_digest: 'sha256:94422147eecafef5ea64062411d9beb51c6366305d52feb885e30cc051c189aa'
        worktree_digest: 'sha256:1faa85e95ad676c0a5e5c9284a72655546f55d11b0bd3d5c9a28b3ae8855e390'
        untracked_digest: 'absent'
      - path: 'src/tools/tool-runner.ts'
        object_kind:
          head: 'regular'
          index: 'regular'
          worktree: 'regular'
          untracked: 'absent'
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:f9507f53a68480780832207ca8011b87d1712a7124c4c3f00b5ce9a2465bbae5'
        index_digest: 'sha256:f9507f53a68480780832207ca8011b87d1712a7124c4c3f00b5ce9a2465bbae5'
        worktree_digest: 'sha256:d97845495867380e97d979a02696f4a880d95e0f5c5adc0f76c973476cd39f16'
        untracked_digest: 'absent'

  primary_symbols:
    - symbol: 'ToolRunner'
      file: 'src/tools/tool-runner.ts'
      lines: '159-755'
      role: 'Thực thi và chuẩn hóa kết quả tool calls'
    - symbol: 'ContextCompactor'
      file: 'src/agent/context-compactor.ts'
      lines: '270-1528'
      role: 'Động cơ nén ngữ cảnh và quản lý ngân sách lịch sử'
    - symbol: 'ContextBudgetManager'
      file: 'src/agent/context-budget-manager.ts'
      lines: '375-664'
      role: 'Đánh giá ngân sách và kích hoạt compaction'
    - symbol: 'AgentLoop'
      file: 'src/agent/agent-loop.ts'
      lines: '430-5494'
      role: 'Vòng lặp agent chính'
    - symbol: 'RateLimitPacer'
      file: 'src/agent/rate-limit-pacer.ts'
      lines: '1-120'
      role: 'Module điều tiết nhịp độ request chống lỗi 429 TPM'
    - symbol: 'SubagentManager'
      file: 'src/agent/subagent-manager.ts'
      lines: '80-500'
      role: 'Điều phối subagents cô lập'

  related_symbols:
    - symbol: 'ExactTokenizer'
      relationship: 'CALLS'
      relevance: 'Đếm token chính xác cho các model khác nhau'
    - symbol: 'DynamicContextArbiter'
      relationship: 'CALLS'
      relevance: 'Phân xử ngân sách token cho dynamic sections'
    - symbol: 'PlanManager'
      relationship: 'RECORDS'
      relevance: 'Ghi nhận evidence không phụ thuộc vào chuỗi text thô'

  execution_path:
    - '1. ToolRunner thực thi công cụ'
    - '2. Nếu output > 4,000 ký tự -> virtualizeToolOutput ghi disk và cắt Head/Tail'
    - '3. AgentLoop.prepareRequest kiểm tra ngân sách'
    - '4. ContextCompactor microcompact các bước cũ (1..N-2) của active turn'
    - '5. AgentLoop kiểm tra tỷ lệ lịch sử >= 50% -> tắt Repo Map và Scaffold'
    - '6. RateLimitPacer kiểm tra cửa sổ 60s -> throttle nếu vượt 85% TPM'
    - '7. LLM generateStream thực thi an toàn không bị 429'
    - '8. Nếu cần phân nhánh tác vụ nặng -> gọi delegate_task sang subagent cô lập'

  pdg_constraints:
    - description: 'Tool output virtualization phải bảo toàn 100% các thuộc tính exitCode, success, error, errorCode'
      affected_statements:
        - 'src/tools/tool-runner.ts:658'
        - 'src/tools/tool-runner.ts:727'
      implementation_consequence: 'Chỉ thu gọn trường text (stdout/stderr/output/content), không bọc lại toàn bộ object kết quả'
    - description: 'RateLimitPacer phải được await trước khi khởi tạo generateStream'
      affected_statements:
        - 'src/agent/agent-loop.ts:2650'
      implementation_consequence: 'Tránh race condition khi nhiều request bắn đồng thời'

  architectural_patterns:
    - pattern: 'Spill-to-Disk & Head/Tail Preview'
      example_location: 'src/tools/tool-runner.ts'
      usage_guidance: 'Dùng cho mọi công cụ sinh output văn bản dài'
    - pattern: 'Sliding Window Token Bucket Pacer'
      example_location: 'src/agent/rate-limit-pacer.ts'
      usage_guidance: 'Dùng cho tầng LLM dispatch chống lỗi 429'

  files_to_modify:
    - file: 'src/tools/tool-runner.ts'
      symbols: ['ToolRunner.executeTool']
      intended_change: 'Tích hợp virtualizeToolOutput với ngưỡng MAX_INLINE_TOOL_CHARS = 4,000'
    - file: 'src/agent/context-compactor.ts'
      symbols: ['ContextCompactor.compact']
      intended_change: 'Hỗ trợ nén vi mô các step cũ trong active turn'
    - file: 'src/agent/agent-loop.ts'
      symbols: ['AgentLoop.prepareRequest', 'AgentLoop.runInternalWithCircuitBreakerRetry']
      intended_change: 'Scoping protectedMessages, tích hợp RateLimitPacer, cắt tỉa Zero-Base Harness khi ngữ cảnh đầy'
    - file: 'src/agent/rate-limit-pacer.ts'
      symbols: ['RateLimitPacer']
      intended_change: 'Module điều tiết tốc độ token sliding window 60s mới'
    - file: 'src/tools/subagent-tools.ts'
      symbols: ['createDelegateTaskTool']
      intended_change: 'Thêm công cụ delegate_task cho subagent chạy đồng bộ cô lập'
    - file: 'src/agent/subagent-manager.ts'
      symbols: ['SubagentManager.executeIsolatedTask']
      intended_change: 'Hàm thực thi subtask cô lập và trích xuất tóm tắt ngắn'

  tests:
    - file: 'src/tools/observation-spill.test.ts'
      scenarios:
        - 'Output nhỏ < 4,000 chars -> giữ nguyên inline'
        - 'Output lớn 25,000 chars -> ghi file log disk và cắt Head/Tail preview'
    - file: 'src/agent/rate-limit-pacer.test.ts'
      scenarios:
        - 'Token dưới ngưỡng -> không delay'
        - 'Token vượt 85% TPM -> delay chính xác thời gian hồi phục cửa sổ'
    - file: 'src/agent/in-turn-compaction.test.ts'
      scenarios:
        - 'Step 1..N-2 trong turn hiện tại được nén thành observation stub'
        - 'Step N-1 và N giữ nguyên vẹn'

  verification_commands:
    - 'npx tsc --noEmit'
    - 'node --import tsx --test src/tools/observation-spill.test.ts'
    - 'node --import tsx --test src/agent/rate-limit-pacer.test.ts'
    - 'npx tsx src/test-latency-optimization.ts'
    - 'npm run test:completion'

  risks:
    - 'Nguy cơ LLM không đọc được đầy đủ error log nếu phần lỗi nằm ở giữa Head và Tail'
    - 'Nguy cơ RateLimitPacer delay quá lâu nếu hạn mức TPM cấu hình quá thấp'

  assumptions:
    - 'Hệ thống file cục bộ có quyền ghi vào .minus/scratch/tool_outputs/'
    - 'User đồng ý tích hợp trực tiếp trên nhánh develop hiện tại không mở branch mới'

  open_questions:
    - 'Có cần cung cấp thêm tùy chọn lệnh /pacer status để xem lưu lượng token 60s qua TUI không? (Đề xuất: có trong phase follow-up)'

  avoid:
    - 'Không tạo git branch mới, implement trực tiếp trên develop'
    - 'Không can thiệp hoặc làm vỡ KV Cache prefix của static system prompt'
    - 'Không cắt ngắn các mã lỗi hoặc exit code trong tool result'
    - 'Không xóa bản log gốc khi spill ra đĩa'
```

## 12. Assumptions and Open Questions

### Assumptions (Đã kiểm chứng / Giả định làm việc)
1. **Quyền ghi thư mục scratch:** Workspace luôn có quyền tạo và ghi vào thư mục `.minus/scratch/tool_outputs/` (đã kiểm chứng qua cơ chế session snapshot hiện có).
2. **Khả năng tự hồi phục TPM:** Việc chủ động sleep 2-6 giây khi chạm 85% TPM hiệu quả hơn gấp nhiều lần so với việc để dính mã lỗi 429 và bị nhà mạng API phạt backoff cấp số nhân (30-60 giây).
3. **Tính độc lập của Evidence Gate:** Evidence Gate kiểm tra evidence từ `PlanManager`, không phụ thuộc vào độ dài hay cấu trúc văn bản thô của tool output trong session history, do đó việc ảo hóa output ra đĩa hoàn toàn an toàn đối với các gate kiểm định.

### Explicitly Deferred Follow-ups (Công việc kế tiếp ngoài phạm vi chính)
1. Bổ sung lệnh CLI `/pacer` hiển thị biểu đồ đo lưu lượng token TPM theo thời gian thực trên giao diện TUI.
2. Thêm tính năng cấu hình động `MAX_INLINE_TOOL_CHARS` theo từng loại công cụ riêng biệt qua file cấu hình `.minus/config.json`.

## 13. Definition of Done

1. Toàn bộ 5 vệ tinh được hiện thực hóa đầy đủ trên mã nguồn nhánh `develop`:
   - [x] Vệ tinh 1: Observation Spill-to-Disk hoạt động tại `src/tools/tool-runner.ts` với ngưỡng 4,000 ký tự.
   - [x] Vệ tinh 2: In-Turn Microcompaction thu gọn các step cũ trong active turn tại `src/agent/context-compactor.ts`.
   - [x] Vệ tinh 3: `RateLimitPacer` tại `src/agent/rate-limit-pacer.ts` bảo vệ request trước ngưỡng 85% TPM.
   - [x] Vệ tinh 4: Dynamic Harness Zero-Base Trimming tự động kích hoạt khi token lịch sử >= 50% ngân sách.
   - [x] Vệ tinh 5: Công cụ `delegate_task` cho phép chạy subtask cô lập và trích xuất kết quả tinh gọn.
2. Tất cả các file test mới (`observation-spill.test.ts`, `rate-limit-pacer.test.ts`, `in-turn-compaction.test.ts`, `subagent-delegation.test.ts`) pass 100%.
3. Toàn bộ các bài test hồi quy hiện hữu (`tsc --noEmit`, `test:completion`, `test-latency-optimization.ts`) pass 100% không phát sinh bất kỳ lỗi regression nào.
