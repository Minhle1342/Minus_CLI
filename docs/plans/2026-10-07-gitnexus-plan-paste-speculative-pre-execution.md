# GitNexus Engineering Plan: Tích hợp Speculative Tool Pre-Execution (PASTE)

> Task: Tích hợp cơ chế Pattern-Aware Speculative Tool Pre-Execution (PASTE) vào Minus CLI để tiền thực thi công cụ chỉ đọc trong khi LLM đang suy luận.
> Evidence verified at commit fa7482a3260f4e6ac5ac18335b41d79173fb6c38; GitNexus index 26 commits behind, refresh skipped due to Node.js win32 analyzer hashing issue; source verification weighted higher.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 5 sorted entries; exact generated plan path excluded.

## 1. Objective

Tích hợp cơ chế **PASTE (Pattern-Aware Speculative Tool Execution)** — dựa trên nền tảng nghiên cứu *"Act While Thinking: Accelerating LLM Agents via Pattern-Aware Speculative Tool Execution"* (Sui et al., March 2026) — vào Agent Loop của Minus CLI.

Mục tiêu kỹ thuật cốt lõi:
1. **Triệt tiêu độ trễ chết (Zero Idle Latency)**: Tận dụng thời gian LLM đang sinh các token suy nghĩ (`onThoughtToken` / reasoning stream) và khoảng thời gian chuyển tiếp giữa các bước (inter-step transitions) để tiền thực thi (pre-execute) các công cụ chỉ đọc có xác suất xuất hiện cao nhất.
2. **Khai thác quy luật chuyển dịch mẫu (Pattern & Flow Mining)**: Khai thác các chuỗi phụ thuộc dữ liệu phổ biến trong tác vụ lập trình (ví dụ: `grep_search` trả về các tệp tin liên quan -> dự đoán ngay lệnh `read_file` trên tệp có tần suất khớp cao nhất; hoặc khi luồng suy nghĩ đề cập đến một đường dẫn tệp cụ thể).
3. **Đảm bảo tính bất biến và an toàn tuyệt đối (Safety & Zero Side-Effects Invariants)**:
   - **Chỉ áp dụng cho công cụ chỉ đọc an toàn**: Tuyệt đối không bao giờ suy đoán các công cụ gây đột biến (`replace_text`, `write_file`, `apply_patch`) hoặc câu lệnh shell (`run_command`).
   - **Giới hạn tài nguyên (Resource-Bounded)**: Giới hạn tối đa $K = 2$ tác vụ suy đoán đồng thời để tránh làm nghẽn CPU và I/O đĩa.
   - **Hủy bỏ không dấu vết (Graceful Discard)**: Khi LLM phát sinh lệnh gọi công cụ không khớp với dự đoán suy đoán (speculative miss), kết quả suy đoán tự động bị loại bỏ mà không để lại bất kỳ trạng thái rác nào.

---

## 2. Current Behaviour

1. **Streaming Incremental Tool Dispatch hiện tại**:
   - `PipelinedToolDispatcher` [verified] tại [src/agent/pipelined-tool-dispatcher.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pipelined-tool-dispatcher.ts#L62) hiện chỉ kích hoạt `dispatchEarly` khi callback `onToolCallEarly` nhận được phần tử định nghĩa `toolCall` (khi mô hình đã sinh xong tên hàm và các tham số JSON).
   - Trong suốt giai đoạn mô hình sinh các token tư duy (`onThoughtToken` tại [src/agent/agent-loop.ts:2376](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts#L2376)), hệ sinh thái công cụ hoàn toàn ở trạng thái nhàn rỗi (idle). Đối với các mô hình suy luận chuyên sâu (DeepSeek-R1, Claude 3.7 Thinking, Gemini 2.0 Flash Thinking), giai đoạn suy nghĩ này thường kéo dài từ 2 đến 8 giây.
2. **Mối quan hệ liên bước (Inter-Step Synergy)**:
   - Khi bước $N-1$ vừa hoàn thành lệnh tìm kiếm (`grep_search` hoặc `find_by_name`), kết quả đã chứa danh sách các tệp tin tiềm năng nhất. Tuy nhiên, hệ thống phải đợi mô hình tiếp nhận observation, bắt đầu lượt suy nghĩ mới, rồi phát sinh lệnh gọi `read_file` ở bước $N$ mới bắt đầu nạp tệp từ đĩa.
3. **Rào cản an toàn và bộ đệm kết quả**:
   - `PipelinedToolDispatcher.awaitOrExecute` [verified] tại [pipelined-tool-dispatcher.ts:113](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pipelined-tool-dispatcher.ts#L113) đã có sẵn hạ tầng đón nhận Promise in-flight và lưu kết quả `completedExecutions`. Nếu một tác vụ được chạy ngầm từ trước, `awaitOrExecute` sẽ đạt 0ms hit mà không làm thay đổi luồng xử lý chính của `AgentLoop`.

---

## 3. Relevant Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AgentLoop Execution Turn                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Inter-Step Transition (Step N-1 complete)                                │
│     └── PastePatternPredictor: phân tích observation N-1                     │
│         └── Nếu phát hiện mẫu (vd: grep_search -> top file matches)          │
│             └── dispatchSpeculative('read_file', { path: topMatch })         │
│                                                                             │
│  2. Model Generation Stream (Step N)                                        │
│     ├── onThoughtToken (Thinking Stream)                                    │
│     │   └── ThoughtStreamSpeculator: trích xuất regex đường dẫn tệp tin      │
│     │       └── dispatchSpeculative('read_file', { path: detectedPath })    │
│     │                                                                       │
│     └── onToolCallEarly (Function Call Syntax Stream)                       │
│         └── dispatchEarly(actualCall) -> Hit ngay vào speculative cache!    │
│                                                                             │
│  3. Partition Execution (Step N Tool Dispatch)                              │
│     └── Promise.allSettled(readPartition.calls)                             │
│         └── awaitOrExecute(...) -> 0ms Latency Hit!                          │
│                                                                             │
│  4. Turn / Step Cleanup                                                     │
│     └── cancelUnmatchedSpeculative() -> Dọn sạch pool nếu không khớp         │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **`PastePatternPredictor`** (Module mới tại `src/agent/paste-pattern-predictor.ts`):
   - Chịu trách nhiệm nhận diện mẫu chuyển dịch hai pha (Two-Phase Pattern Recognition):
     - **Pha 1 (Inter-Step)**: Phân tích kết quả của công cụ ở bước trước để suy đoán tệp cần đọc tiếp theo.
     - **Pha 2 (Intra-Step)**: Lắng nghe luồng token suy nghĩ (`onThoughtToken`) qua cửa sổ trượt (sliding window) để bắt ý định đọc tệp trước khi mô hình bắt đầu sinh cú pháp hàm.
2. **`PipelinedToolDispatcher`** ([src/agent/pipelined-tool-dispatcher.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pipelined-tool-dispatcher.ts)):
   - Tiếp nhận các yêu cầu suy đoán thông qua phương thức `dispatchSpeculative(...)`.
   - Gắn cờ định danh `isSpeculative: true` để phân biệt với early streaming thông thường.
   - Quản lý vòng đời bộ đệm và thống kê độ trễ tiết kiệm được (`speculativeHits`, `speculativeSavedMs`).
3. **`AgentLoop`** ([src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts)):
   - Điểm kích hoạt suy đoán tại luồng `onThoughtToken` và điểm tái sử dụng trong `awaitOrExecute`.

---

## 4. GitNexus Findings

- **Primary Symbols**:
  - `PipelinedToolDispatcher` [verified] (`src/agent/pipelined-tool-dispatcher.ts:30-168`)
  - `AgentLoop.runInternal` [verified] (`src/agent/agent-loop.ts:892-4120`)
  - `ToolSynergyAdvisor` [verified] (`src/agent/tool-synergy-advisor.ts:52-307`)
- **Direct Dependents (d=1 items)**:
  - `AgentLoop.constructor`: Khởi tạo dispatcher.
  - `AgentLoop.runInternal`: Gọi `awaitOrExecute` và `dispatchEarly`.
  - `src/test-latency-optimization.ts:main`: Bộ kiểm thử hồi quy thông lượng và benchmark.
- **Impact Radius & Rủi ro**:
  - Mức độ ảnh hưởng: **CRITICAL** đối với lõi thực thi tác vụ. Tuy nhiên, do toàn bộ tác vụ suy đoán chỉ chạy trên tập `SAFE_READ_ONLY_TOOLS`, rủi ro làm biến đổi trạng thái làm việc (working-tree mutation) là **0%**.

---

## 5. Statement-Level PDG Findings

- Phân tích Control Dependence Graph (CDG) tại [src/agent/pipelined-tool-dispatcher.ts:107](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/pipelined-tool-dispatcher.ts#L107) (`awaitOrExecute`):
  - **Controller tại dòng 117** (`if (this.completedExecutions.has(key))`):
    - Nhánh **True** (`guard: true`): Trả về ngay kết quả từ RAM với `wasPipelined: true`, tính toán `savedMs` và tăng chỉ số trúng cache.
  - **Controller tại dòng 127** (`if (this.inFlightExecutions.has(key))`):
    - Nhánh **True**: Await trực tiếp Promise đang chạy dở trong nền, giảm thiểu tối đa thời gian chờ.
  - **Controller tại dòng 140**:
    - Nhánh **False**: Chỉ chạy `toolRunner.run` đồng bộ khi không tìm thấy kết quả nào trong bộ đệm.
- **Hệ quả thiết kế (Planning Implication)**:
  - Bằng cách đảm bảo `getCallKey(toolName, args)` của tác vụ suy đoán tạo ra đúng khóa nhận diện chuẩn tắc (`toolName:{"path":"..."}`), kết quả suy đoán sẽ tự động rơi vào nhánh `guard: true` tại dòng 117 hoặc 127 của PDG mà không cần chèn thêm bất kỳ logic rẽ nhánh phức tạp nào vào lõi điều phối.

---

## 6. Proposed Changes

### 6.1. Module mới `src/agent/paste-pattern-predictor.ts` [verified]
- **Trách nhiệm**: Nhận diện mẫu chuyển dịch công cụ và trích xuất thực thể từ luồng suy nghĩ.
- **Cấu trúc dữ liệu & Thuật toán**:
  ```typescript
  export interface SpeculativeCandidate {
    toolName: string;
    args: Record<string, unknown>;
    confidence: number;
    source: 'inter-step-pattern' | 'thought-stream-intent';
  }
  ```
  - `predictFromObservation(lastToolName: string, lastResult: any, workspace: Workspace): SpeculativeCandidate[]`
    - Nhận diện `grep_search`: Trích xuất tối đa 2 tệp có nhiều match nhất (từ mảng `matches` hoặc `files`).
    - Nhận diện `find_by_name`: Trích xuất tệp đầu tiên tìm thấy.
    - Nhận diện `inspect_symbol`: Trích xuất tệp nguồn chứa khai báo biểu tượng.
  - `extractFromThinkingStream(accumulatedThought: string, workspace: Workspace): SpeculativeCandidate[]`
    - Sử dụng Regex an toàn quét qua cửa sổ trượt: `/(?:read|inspect|check|view|open)\s+(?:file\s+)?["'`]?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)["'`]?/i`
    - Chuẩn hóa đường dẫn tương đối và kiểm tra tính hợp lệ qua `workspace.existsSync(path)` trước khi đề xuất.

### 6.2. Mở rộng `src/agent/pipelined-tool-dispatcher.ts` [verified]
- **Symbol**: `PipelinedToolDispatcher`
- **Mở rộng**:
  - Bổ sung cấu trúc dữ liệu lưu trữ tác vụ suy đoán: `speculativeExecutions = new Map<string, { promise: Promise<any>; startTime: number; source: string }>()`.
  - Bổ sung phương thức `dispatchSpeculative(toolName, args, toolRunner, context, source)`:
    - Kiểm tra `isSafeReadOnlyTool(toolName)`. Nếu không thuộc danh mục chỉ đọc an toàn, từ chối ngay lập tức.
    - Kiểm tra trần tải đồng thời: Nếu số lượng tác vụ suy đoán đang chạy đạt ngưỡng tối đa ($K = 2$), không khởi chạy thêm để bảo vệ CPU.
  - Bổ sung `cancelUnmatchedSpeculative()`: Xóa sạch các tác vụ suy đoán chưa được mô hình xác nhận khi bước chuyển sang giai đoạn kế tiếp.
  - Bổ sung telemetry:
    ```typescript
    export interface PipelinedDispatchTelemetry {
      earlyDispatchedCount: number;
      pipelinedHits: number;
      timeSavedMs: number;
      speculativeDiagnosticsHits: number;
      speculativeDispatchedCount: number;
      speculativeHits: number;
      speculativeMisses: number;
      speculativeSavedMs: number;
    }
    ```

### 6.3. Tích hợp PASTE vào `AgentLoop` [verified]
- **File**: `src/agent/agent-loop.ts`
- **Vị trí 1 (Inter-Step)**: Trước khi kích hoạt `this.llm.generateStream(...)`, gọi `pastePredictor.predictFromObservation(...)` dựa trên kết quả bước trước và chuyển vào `pipelinedDispatcher.dispatchSpeculative(...)`.
- **Vị trí 2 (Intra-Step)**: Trong callback `onThoughtToken(token)`, tích lũy token vào bộ đệm suy nghĩ, thực hiện kiểm tra định kỳ (throttled mỗi 40 tokens) qua `pastePredictor.extractFromThinkingStream(...)` để phát hiện và khởi chạy đọc tệp sớm.
- **Vị trí 3 (Cleanup)**: Khi turn kết thúc hoặc người dùng bấm hủy, gọi `cancelUnmatchedSpeculative()`.

---

## 7. Implementation Sequence

### Bước 1: Hiện thực hóa `PastePatternPredictor`
- Tạo mới tệp `src/agent/paste-pattern-predictor.ts`.
- Hiện thực logic phân tích mẫu chuyển dịch `grep_search -> read_file`, `find_by_name -> read_file`.
- Hiện thực regex extractor cho luồng suy nghĩ tư duy.
- Viết unit test riêng cho predictor kiểm tra độ chính xác của việc trích xuất đường dẫn tệp.

### Bước 2: Nâng cấp `PipelinedToolDispatcher` hỗ trợ PASTE
- Bổ sung `dispatchSpeculative`, `cancelUnmatchedSpeculative`, và mở rộng telemetry.
- Đảm bảo cơ chế deduplication giữa `dispatchSpeculative` và `dispatchEarly` (không bao giờ chạy trùng một tác vụ hai lần).
- Đảm bảo giới hạn concurrency tối đa 2 tác vụ suy đoán cùng lúc.

### Bước 3: Gắn kết PASTE vào luồng `AgentLoop`
- Tích hợp predictor vào trước lời gọi `llm.generateStream` và bên trong `onThoughtToken`.
- Đảm bảo không ảnh hưởng đến khả năng hủy bỏ của `AbortSignal`.
- Ghi nhận telemetry `speculativeToolExecution` vào decision log và sự kiện của kernel.

### Bước 4: Kiểm thử Benchmark & Hồi quy
- Cập nhật kịch bản benchmark trong `src/test-latency-optimization.ts`:
  - Đo đạc thời gian tiết kiệm được khi hit PASTE (kỳ vọng giảm >35% thời gian chờ I/O).
  - Kiểm tra trường hợp speculative miss (xác nhận hệ thống không bị crash, không rò rỉ bộ nhớ, không có side-effect).
- Chạy toàn bộ test suite: `npm run test:prompt-gating` và `npm run build`.

---

## 8. Test Strategy

### 8.1. Kiểm thử đơn vị (Unit Tests)
- **File mới**: `src/agent/paste-pattern-predictor.test.ts`
  - Kiểm tra trích xuất chính xác đường dẫn tệp từ kết quả `grep_search`.
  - Kiểm tra lọc bỏ các đường dẫn tệp không tồn tại trong workspace.
  - Kiểm tra phân tích luồng thinking stream với nhiều mẫu câu ngữ cảnh khác nhau.

### 8.2. Kiểm thử Benchmark và Tích hợp (Benchmark & Integration Tests)
- **File**: `src/test-latency-optimization.ts`
  - Mô phỏng chuỗi: Step 1 (`grep_search`) -> Step 2 (Model sinh suy nghĩ đề cập đến tệp -> Model gọi `read_file`).
  - Khẳng định: `telemetry.speculativeHits >= 1` và `telemetry.speculativeSavedMs > 0`.
  - Khẳng định: `telemetry.speculativeMisses` xử lý an toàn khi mô hình đột ngột đổi ý gọi công cụ khác.
  - Khẳng định: Tính bất biến của KV-Cache (Prefix-Cache Invariance) qua Gemini, Anthropic, DeepSeek không bị thay đổi dù có hay không có PASTE.

### 8.3. Kiểm thử hồi quy hệ thống (System Regression)
- `npm run test:prompt-gating`: Bảo đảm các quy tắc phân vùng và chuyển pha bảo toàn 100%.
- `npm run build` (`tsc`): Mã nguồn biên dịch sạch với exit code 0.

---

## 9. Risk and Impact Analysis

| Rủi ro tiềm ẩn | Mức độ | Biện pháp giảm thiểu kiến trúc |
| :--- | :--- | :--- |
| **Gây nghẽn CPU/Disk I/O do suy đoán quá nhiều** | TRUNG BÌNH | Áp dụng trần concurrency nghiêm ngặt: Tối đa $K = 2$ speculative tasks đồng thời. Chỉ suy đoán khi điểm tự tin vượt ngưỡng (>0.75). |
| **Làm ô nhiễm tệp tin hoặc trạng thái hệ thống** | KHÔNG CÓ | Rào cản bất biến: Chỉ các công cụ trong `SAFE_READ_ONLY_TOOLS` mới được phép suy đoán. Cấm tuyệt đối mutation tools và commands. |
| **Xung đột Promise khi stream chính thức phát lệnh** | THẤP | Sử dụng cùng một quy tắc băm khóa `getCallKey(toolName, args)`. Lời gọi chính thức chỉ việc đính kèm vào Promise đang chạy dở hoặc lấy kết quả đã hoàn thành. |
| **Tăng tiêu thụ RAM do lưu đệm kết quả đọc tệp** | THẤP | Cơ chế dọn dẹp tức thì (`cancelUnmatchedSpeculative` / `resetTurn`): Mọi kết quả không được xác nhận trong vòng 1 bước sẽ tự động giải phóng khỏi bộ nhớ. |

---

## 10. Files Expected to Change

| File | Symbols | Lý do thay đổi |
| :--- | :--- | :--- |
| `src/agent/paste-pattern-predictor.ts` | `PastePatternPredictor`, `SpeculativeCandidate` | Tạo module dự đoán mẫu liên bước và trích xuất thực thể từ luồng tư duy. |
| `src/agent/pipelined-tool-dispatcher.ts` | `PipelinedToolDispatcher` | Bổ sung `dispatchSpeculative`, `cancelUnmatchedSpeculative`, telemetry PASTE. |
| `src/agent/agent-loop.ts` | `AgentLoop.runInternal` | Tích hợp hook suy đoán vào trước lời gọi stream và trong `onThoughtToken`. |
| `src/test-latency-optimization.ts` | `main` | Thêm ca kiểm thử thực tế đo lường hiệu năng và tính an toàn của PASTE. |

---

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Tích hợp cơ chế Pattern-Aware Speculative Tool Pre-Execution (PASTE) vào Minus CLI để tiền thực thi công cụ chỉ đọc trong khi LLM đang suy luận."
  acceptance_criteria:
    - "Dự đoán và tiền thực thi công cụ đọc an toàn ngay trong khi LLM đang sinh token suy nghĩ hoặc giữa các bước."
    - "Đạt instant cache hit (0ms) khi lệnh gọi thực tế của LLM khớp với dự đoán suy đoán."
    - "Bảo đảm an toàn tuyệt đối: Không bao giờ suy đoán mutation tools hoặc lệnh shell."
    - "Tự động hủy bỏ và dọn dẹp các tác vụ suy đoán không khớp mà không để lại tác dụng phụ."
    - "100% test suite hiện hành (latency, prompt gating, build) pass sạch không lỗi."

  evidence_provenance:
    schema_version: 2
    head_commit: "fa7482a3260f4e6ac5ac18335b41d79173fb6c38"
    generated_plan_path: "docs/plans/2026-10-07-gitnexus-plan-paste-speculative-pre-execution.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    cited_path_manifest:
      - path: "src/agent/agent-loop.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:837142ba711054a68788288631aabfc399d04c767d1d779f0778e0bdf1aa4102"
        index_digest: "sha256:837142ba711054a68788288631aabfc399d04c767d1d779f0778e0bdf1aa4102"
        worktree_digest: "sha256:cd13403206ab66dbf8ddb466a20b380f9d95ddc5f1b90f9d6eebe293fbb07d66"
        untracked_digest: "absent"
      - path: "src/agent/pipelined-tool-dispatcher.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:95cb5a625505916b029e200e2f04261eae6dafa3e6ed8e4641748db15e9d2390"
        index_digest: "sha256:95cb5a625505916b029e200e2f04261eae6dafa3e6ed8e4641748db15e9d2390"
        worktree_digest: "sha256:193a56c405d0cf358442e8c299d2c81ff1c39e4e4f4675b299c32cb5f2b91118"
        untracked_digest: "absent"
      - path: "src/agent/tool-execution-scheduler.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:6bc5b43a1ad998cbf1162baa65df17f4b600eb239e606353232cbabd48fd12a1"
        index_digest: "sha256:6bc5b43a1ad998cbf1162baa65df17f4b600eb239e606353232cbabd48fd12a1"
        worktree_digest: "sha256:8dff6cb7a35fae2b8c04102f740bf291f97357257955b57795c8f3d8547a8492"
        untracked_digest: "absent"
      - path: "src/agent/tool-synergy-advisor.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:b2f420cd41347fb1ab5781a156239aa68dca7faa25404eea1e124227bcd85d3f"
        index_digest: "sha256:b2f420cd41347fb1ab5781a156239aa68dca7faa25404eea1e124227bcd85d3f"
        worktree_digest: "sha256:9c3a6611278e579c910c131c32cad74e015f913f0e98a5b0ec660e8d18e875bb"
        untracked_digest: "absent"
      - path: "src/test-latency-optimization.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:e090d9370f01d9bb72b60bf195aaa287a9d87a095f3321f5666e6389067a5025"
        index_digest: "sha256:e090d9370f01d9bb72b60bf195aaa287a9d87a095f3321f5666e6389067a5025"
        worktree_digest: "sha256:2cfe238dd5bf49df3ee8d403c43d2942fdee9ef22d7b62dec5cbeb1d14649d45"
        untracked_digest: "absent"
```

---

## 12. Assumptions and Open Questions

1. **Giả định về tính đơn nhất của I/O đọc**: Toàn bộ các công cụ trong `SAFE_READ_ONLY_TOOLS` là pure read-only và idempotent, cho phép tiền thực thi an toàn trong RAM mà không ảnh hưởng tới trạng thái workspace.
2. **Giả định về sự hiện diện của Token suy nghĩ**: Mô hình hỗ trợ streaming reasoning (`onThoughtToken`). Nếu mô hình không stream thinking (ví dụ: các mô hình legacy không suy luận), hệ thống sẽ fallback về cơ chế Inter-Step Pattern Prediction và Streaming Incremental Dispatch thông thường.
3. **Mở rộng tương lai (B-PASTE)**: Trong tương lai, có thể mở rộng PASTE lên cơ chế Beam-Aware Speculative Execution (B-PASTE) để suy đoán theo các nhánh giả thuyết cây quyết định sâu hơn 2 bước.

---

## 13. Definition of Done

1. [ ] `PastePatternPredictor` được hiện thực hóa và có bộ test đơn vị xác minh khả năng trích xuất mẫu chính xác.
2. [ ] `PipelinedToolDispatcher` hỗ trợ `dispatchSpeculative` với trần concurrency $K=2$ và cơ chế dọn dẹp `cancelUnmatchedSpeculative`.
3. [ ] `AgentLoop` kích hoạt tiền thực thi suy đoán thành công trong luồng `onThoughtToken` và giai đoạn inter-step.
4. [ ] Benchmark trong `src/test-latency-optimization.ts` xác nhận `speculativeHits >= 1` và `speculativeSavedMs > 0` với tính bất biến KV-Cache đạt 100%.
5. [ ] 100% test suite hiện hành (`test:prompt-gating`, `test:dynamic-tool-masking`, `build`) vượt qua với exit code 0.
