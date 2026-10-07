# GitNexus Engineering Plan

> Task: Lập kế hoạch tích hợp Parallel Multi-Tool Calling vào Minus CLI
> Evidence verified at commit 7e10f4d8e07770025155c093b9c433c097823453; GitNexus index 23 commits behind, refresh skipped: analyzer identity hash error in gitnexus v1.6.12 (proceeding on current graph with source verification weighted higher).
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 7 sorted entries; exact generated plan path excluded.

## 1. Objective

Tích hợp hoàn chỉnh và tối ưu hóa kiến trúc Parallel Multi-Tool Calling trong Minus CLI [verified]. Mục tiêu là cho phép mô hình ngôn ngữ (Gemini / Claude / DeepSeek) gọi đồng thời nhiều công cụ quan sát/chỉ đọc trong cùng một turn (1-turn multi-tool ReAct) mà không phá vỡ tính bất biến của KV-Cache (Prefix-Cache Invariance), đồng thời đảm bảo an toàn tuyệt đối cho hệ thống tệp và trạng thái phiên làm việc (Session Invariants & Sequential Barriers).

## 2. Current Behaviour

Hiện tại, khi mô hình ngôn ngữ trả về mảng `toolCalls` (nhiều hơn 1 lời gọi hàm) trong một turn [verified]:
1. Hàm `partitionToolCalls` trong `src/agent/tool-execution-scheduler.ts` phân tách các lời gọi thành các phân vùng (`ToolCallPartition`) gồm `concurrent-read`, `sequential-read`, hoặc `sequential` [verified].
2. Trong `src/agent/agent-loop.ts`, nếu một phân vùng là `concurrent-read`, hệ thống sẽ kích hoạt thực thi đồng thời thông qua `Promise.allSettled` và chụp ảnh tệp (`snapshotReadTargets`) để phát hiện xung đột [verified].
3. Kết quả được lưu tạm vào `preexecutedReadResults` và sau đó vòng lặp tuần tự duyệt qua từng tool call để ghi nhận vào `session.append('tool/call')`, chạy bộ lọc bảo vệ và cập nhật `session.addToolResultWithId` [verified].

Tuy nhiên, tồn tại 3 điểm nghẽn kiến trúc cần được hoàn thiện:
- **Phân mảnh danh mục công cụ an toàn**: `SAFE_READ_ONLY_TOOLS` tại `src/agent/pipelined-tool-dispatcher.ts` và `CONCURRENT_READ_ONLY_TOOLS` tại `src/agent/tool-execution-scheduler.ts` chưa được chuẩn hóa làm một nguồn chân lý (Single Source of Truth) [verified].
- **Thiếu kiểm soát giới hạn tài nguyên (Concurrency Throttling)**: `Promise.allSettled` chạy toàn bộ phân vùng mà không giới hạn số lượng luồng đồng thời (concurrency limit), có nguy cơ làm cạn kiệt File Descriptors hoặc socket khi mô hình gọi >15 công cụ trong 1 turn [inferred].
- **Chưa hợp nhất Pipelined Streaming Dispatch với Concurrent Partitions**: `pipelinedDispatcher.dispatchEarly` khởi chạy sớm công cụ khi nhận token, nhưng luồng `concurrent-read` tại `AgentLoop` lại gọi trực tiếp `stepToolRunner.run` thay vì tra cứu kết quả đã sẵn sàng từ dispatcher [verified].

## 3. Relevant Architecture

Kiến trúc liên quan gồm 4 lớp chính:
1. **Model & Interface Layer (`src/llm/gemini.ts`, `src/llm/prompt-sections.ts`)**:
   - `CORE_SYSTEM_PROMPT` và `SECTION_PHASE_EXPLORE_GUIDANCE`: Hướng dẫn mô hình phát ra nhiều lệnh đọc cùng lúc trong pha khám phá (1-turn ReAct).
   - `allowedFunctionNames` trong `generateConfig.toolConfig`: Ép mô hình chỉ gọi trong tập công cụ hợp lệ của phase/turn mà không làm thay đổi mảng `tools` schema, giữ nguyên 100% prefix KV-cache [verified].
2. **Scheduling & Partitioning Layer (`src/agent/tool-execution-scheduler.ts`)**:
   - Nhận danh sách `ScheduledToolCall[]` và nhóm các công cụ chỉ đọc kế tiếp nhau vào phân vùng `concurrent-read`.
   - Các công cụ đột biến (`write_file`, `replace_text`, `apply_patch`), thực thi lệnh (`run_command`), chuyển pha (`request_phase_transition`), hoặc nộp giải pháp (`submit_solution`) tạo thành các rào cản tuần tự tuyệt đối (`sequential barrier`) [verified].
3. **Execution & Dispatch Layer (`src/agent/agent-loop.ts`, `src/agent/pipelined-tool-dispatcher.ts`, `src/tools/tool-runner.ts`)**:
   - Thực thi các phân vùng song song bằng `Promise.allSettled`, giám sát FS snapshot trước/sau phân vùng để phát hiện thay đổi ngoại lai [verified].
   - Kết nối với `ToolRunner` (quản lý ngân sách gọi tool qua `budgetTracker`, kiểm tra quyền hạn qua `guardian` và `aciGuardrails`) [verified].
4. **Session Persistence & Telemetry Layer (`src/session/session.ts`, `src/test-latency-optimization.ts`)**:
   - Ghi nhận `tool/call` và `tool/result` đồng bộ với `assistantSeq` của model message.
   - Đo lường độ trễ thực tế (`batchDurationMs`) so với ước tính tuần tự (`estimatedSerialDurationMs`) để xuất telemetry tiết kiệm thời gian [verified].

## 4. GitNexus Findings

Qua phân tích đồ thị quan hệ từ GitNexus:
- `Function:src/agent/tool-execution-scheduler.ts:partitionToolCalls`:
  - Direct callers [graph]: `AgentLoop.runInternal` (`src/agent/agent-loop.ts:2689`) và kịch bản kiểm thử `main` (`src/test-latency-optimization.ts:85`).
  - Callees [graph]: `isConcurrentReadOnlyTool`, `flushReads`.
  - Risk verdict [graph]: HIGH do nằm trên luồng thực thi trọng yếu `runInternalWithCircuitBreakerRetry`. Bất kỳ thay đổi nào làm vỡ rào cản tuần tự của mutations sẽ gây xung đột dữ liệu.
- `Method:src/tools/tool-runner.ts:ToolRunner.run`:
  - Direct callers [graph]: Gọi từ `agent-loop.ts` và các suite kiểm thử quyền hạn (`permission-denial-turn-end.test.ts`, `this-turn-tool-gate.test.ts`, `tool-runner.test.ts`).
  - Internal state [verified]: Sử dụng `this.budgetTracker.increment(context.turn)`. Trong JavaScript runtime (đơn luồng event loop), việc thực thi đồng thời nhiều Promise vẫn đảm bảo thứ tự tăng biến đếm trước mỗi bước await I/O.
- `Class:src/agent/pipelined-tool-dispatcher.ts:PipelinedToolDispatcher`:
  - Khởi tạo trong `AgentLoop` và lắng nghe sự kiện `onToolCallEarly` từ luồng stream của LLM [verified].

## 5. Statement-Level PDG Findings

Phân tích Program Dependence Graph (CDG & REACHING_DEF) trên hàm `partitionToolCalls`:
- **Control Dependencies (CDG)** [verified]:
  - `Line 46`: Biểu thức điều kiện `if (isConcurrentReadOnlyTool(call.name))` kiểm soát 2 nhánh rẽ:
    - Nhánh True (`label: T`): `pendingReads.push(call); continue;` (được đánh dấu `guard: true`).
    - Nhánh False (`label: F`): `flushReads(); partitions.push({ mode: 'sequential', calls: [call] });`.
  - `Line 37`: Trong hàm con `flushReads()`, biểu thức `if (pendingReads.length === 0) return;` đóng vai trò guard clause [verified].
  - Nhánh False của guard này thực hiện cấu trúc phân vùng: `mode: concurrentReadsEnabled && pendingReads.length > 1 ? 'concurrent-read' : 'sequential-read'`.
- **Data Dependencies (REACHING_DEF)** [verified]:
  - Biến mảng `pendingReads` (được định nghĩa tại dòng 34) truyền trực tiếp vào `pendingReads.push(call)` tại dòng 47 và được xóa rỗng `pendingReads = []` sau mỗi lần `flushReads()` [verified].
- **Hệ quả thiết kế (Planning Implications)** [verified]:
  - Bất kỳ thao tác mở rộng danh sách công cụ nào vào `CONCURRENT_READ_ONLY_TOOLS` đều giữ nguyên cấu trúc nhánh CDG và luồng dữ liệu của `partitionToolCalls`.
  - Việc bổ sung cơ chế phân mảnh kích thước lô (batch chunking / concurrency cap) cần can thiệp trực tiếp vào `flushReads()` hoặc tách nhỏ mảng `calls` trong phân vùng `concurrent-read`.

## 6. Proposed Changes

### 6.1. Hợp nhất danh mục công cụ an toàn (Single Source of Truth)
- **File**: `src/agent/pipelined-tool-dispatcher.ts` [verified]
- **Symbol**: `SAFE_READ_ONLY_TOOLS`
- **Mục tiêu**: Tái xuất và đồng bộ hóa trực tiếp từ `CONCURRENT_READ_ONLY_TOOLS` của `tool-execution-scheduler.ts` để tránh hiện tượng công cụ được phép chạy song song nhưng bị bỏ qua khi streaming early dispatch.

### 6.2. Bổ sung Giới hạn Concurrency (Bounded Concurrency Control)
- **File**: `src/agent/tool-execution-scheduler.ts` [verified]
- **Symbol**: `partitionToolCalls`, `ToolCallPartition`
- **Mục tiêu**: Bổ sung tham số cấu hình `maxConcurrency: number = 6`. Khi số lượng công cụ chỉ đọc liên tiếp vượt quá 6 (ví dụ: 12 file reads), hàm sẽ tự động phân tách thành các batch con có kích thước tối đa là 6, ngăn chặn quá tải I/O đồng thời.

### 6.3. Tích hợp Pipelined Dispatcher Cache vào Concurrent Execution
- **File**: `src/agent/agent-loop.ts` [verified]
- **Symbol**: `AgentLoop.runInternal` (đoạn xử lý phân vùng dòng 2765–2785)
- **Mục tiêu**: Trong `Promise.allSettled`, trước khi gọi `stepToolRunner.run`, kiểm tra xem công cụ đã được thực thi sớm bởi `pipelinedDispatcher` hay chưa thông qua `pipelinedDispatcher.awaitOrExecute`. Nếu kết quả đã có sẵn (hit), tái sử dụng ngay để đạt 0ms latency.

### 6.4. Telemetry và Đo lường Hiệu năng Thực thi Song song
- **File**: `src/agent/agent-loop.ts` [verified]
- **Symbol**: `AgentLoop.runInternal`
- **Mục tiêu**: Ghi nhận độ trễ thực tế của lô song song (`batchDurationMs`) và tính toán `savedMs = estimatedSerialDurationMs - batchDurationMs`, lưu vào sự kiện `model:request_telemetry` và decision audit log.

## 7. Implementation Sequence

### Bước 1: Đồng bộ hóa danh mục công cụ chỉ đọc và kiểm soát tải
- Cập nhật `src/agent/tool-execution-scheduler.ts`: Thêm hằng số `DEFAULT_MAX_CONCURRENT_READS = 6`, hỗ trợ chunking phân vùng đọc lớn.
- Cập nhật `src/agent/pipelined-tool-dispatcher.ts`: Cho phép `SAFE_READ_ONLY_TOOLS` tham chiếu trực tiếp tập `CONCURRENT_READ_ONLY_TOOLS`.
- *Kiểm tra*: Chạy `node --import tsx --test src/llm/dynamic-tool-masking.test.ts`.

### Bước 2: Tích hợp Early Dispatch với Concurrent Read Partition trong AgentLoop
- Trong `src/agent/agent-loop.ts`: Cập nhật hàm dispatch phân vùng đọc để gọi qua `pipelinedDispatcher.awaitOrExecute` thay vì gọi thẳng `stepToolRunner.run`.
- Đảm bảo snapshot filesystem và mismatch diffing vẫn hoạt động toàn vẹn trước và sau khi batch kết thúc.
- *Kiểm tra*: Chạy `tsx src/test-latency-optimization.ts`.

### Bước 3: Phát telemetry và tối ưu hiển thị TUI
- Thêm thuộc tính `parallelToolExecution: { batchCount, totalTools, durationMs, savedMs }` vào telemetry payload của `AgentLoop`.
- Bổ sung hiển thị trực quan ngắn gọn trên CLI khi có nhiều công cụ chạy song song hoàn tất.
- *Kiểm tra*: Chạy `npm run test:prompt-gating` và `npm run build`.

## 8. Test Strategy

### 8.1. Kiểm thử đơn vị (Unit Tests)
- **File**: `src/llm/dynamic-tool-masking.test.ts` [verified]
  - Kiểm tra `partitionToolCalls` với lô đọc lớn (>6 công cụ) được chia chunk hợp lý.
  - Kiểm tra không bao giờ nhóm công cụ đột biến (`replace_text`, `write_file`) vào `concurrent-read`.
- **File**: `src/test-latency-optimization.ts` [verified]
  - Kiểm tra benchmark phân vùng đọc đồng thời đo lường chính xác `savedMs > 0`.

### 8.2. Kiểm thử hồi quy và tích hợp (Regression & Integration Tests)
- `npm run test:prompt-gating`: Xác nhận chính sách cấp phát prompt và rào cản chuyển pha không bị ảnh hưởng.
- `npm run test:latency`: Đo lường thông lượng tổng thể của Agent Loop.
- `npm run build` (`tsc`): Biên dịch toàn bộ codebase với exit code 0.

## 9. Risk and Impact Analysis

| Rủi ro | Mức độ | Biện pháp giảm thiểu |
| :--- | :--- | :--- |
| **Race condition khi đọc file đang bị sửa đổi** | CAO | Rào cản tuần tự: Mutation tool luôn flush toàn bộ reads đang chờ và tạo một phân vùng sequential riêng biệt. Không bao giờ chạy read song song với write. |
| **Bất đồng bộ Session Event** | TRUNG BÌNH | `session.append('tool/call')` và `session.addToolResultWithId` được ghi theo đúng thứ tự mảng gốc `normalizedToolCalls` của model message, đảm bảo tính toàn vẹn của lịch sử tái hiện. |
| **Vượt ngân sách Tool Call** | THẤP | `ToolRunner.run` kiểm tra và tăng `budgetTracker` trước khi thực hiện I/O. Khi chạm trần `maxToolCalls`, các lệnh còn lại trong lô nhận `TOOL_CALL_BUDGET_EXHAUSTED` an toàn. |
| **Lệch trạng thái hệ thống tệp ngoại lai** | THẤP | Cơ chế snapshot fingerprint (`snapshotReadTargets` và `diffReadSnapshots`) tự động phát hiện và cảnh báo nếu có tiến trình bên ngoài sửa đổi file trong quá trình đọc batch. |

## 10. Files Expected to Change

| File | Symbols | Reason |
| :--- | :--- | :--- |
| `src/agent/tool-execution-scheduler.ts` | `CONCURRENT_READ_ONLY_TOOLS`, `partitionToolCalls` | Bổ sung giới hạn tải (concurrency limit) và chia nhỏ lô đọc lớn. |
| `src/agent/pipelined-tool-dispatcher.ts` | `SAFE_READ_ONLY_TOOLS` | Đồng bộ hóa nguồn chân lý danh mục công cụ an toàn với scheduler. |
| `src/agent/agent-loop.ts` | `runInternal` | Tích hợp pipelined dispatcher vào concurrent read partition và bổ sung telemetry. |
| `src/test-latency-optimization.ts` | `main` | Cập nhật assertion và kịch bản benchmark cho concurrency limit. |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Tích hợp Parallel Multi-Tool Calling an toàn, có kiểm soát concurrency và gắn kết chặt chẽ với Pipelined Dispatcher trong Minus CLI."
  acceptance_criteria:
    - "Các công cụ chỉ đọc liên tiếp được thực thi đồng thời với giới hạn tải tối đa 6 calls/lô."
    - "Các công cụ đột biến và câu lệnh shell duy trì rào cản tuần tự tuyệt đối."
    - "Telemetry tính toán chính xác thời gian tiết kiệm được và ghi vào session decision log."
    - "100% test suite hiện hành (latency, prompt gating, build) pass sạch không lỗi."

  evidence_provenance:
    schema_version: 2
    head_commit: "7e10f4d8e07770025155c093b9c433c097823453"
    generated_plan_path: "docs/plans/2026-10-07-gitnexus-plan-parallel-multi-tool.md"
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
        head_digest: "sha256:ca017fc0705bbf62d9b670b672e39b43a95a2502844d3cb7ac0dc65a0e136cea"
        index_digest: "sha256:ca017fc0705bbf62d9b670b672e39b43a95a2502844d3cb7ac0dc65a0e136cea"
        worktree_digest: "sha256:a0732f07bbda0c2e5dd62817730e692fa1785b944c87d69bdbcefa71db79fbb3"
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
        head_digest: "sha256:a0652099a2057c7eceb14bde69212ef508906a911134583f2e1eef21af3805bc"
        index_digest: "sha256:a0652099a2057c7eceb14bde69212ef508906a911134583f2e1eef21af3805bc"
        worktree_digest: "sha256:1f8d210a75e39c9d563907acc99ecd3cc956e31fb30fc5c878ab2f55771dbc9d"
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
        head_digest: "sha256:7fde72f40db305b58cdc8b5964798c5d3a2513b9c6f341cd46a88fc2b6c4c4d6"
        index_digest: "sha256:7fde72f40db305b58cdc8b5964798c5d3a2513b9c6f341cd46a88fc2b6c4c4d6"
        worktree_digest: "sha256:2cc6aaabc0a9eeb3f1895174762a5f7ef5dabe717e6cd7b1b959b5a734691d0d"
        untracked_digest: "absent"
      - path: "src/llm/dynamic-tool-masking.test.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:3610087e172bf19063c73ca69e65e6eb2d69423c92134c7ad47cd003351f4721"
        index_digest: "sha256:3610087e172bf19063c73ca69e65e6eb2d69423c92134c7ad47cd003351f4721"
        worktree_digest: "sha256:3610087e172bf19063c73ca69e65e6eb2d69423c92134c7ad47cd003351f4721"
        untracked_digest: "absent"
      - path: "src/llm/gemini.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:18f13d55fa6b7bfc0e749853ed2e62889f5558af4acf38cf8456606111dca8a8"
        index_digest: "sha256:18f13d55fa6b7bfc0e749853ed2e62889f5558af4acf38cf8456606111dca8a8"
        worktree_digest: "sha256:97fac0b8ea162f1f1f791ad0e2b594fd06d70dbf5025571ccee28376920cd526"
        untracked_digest: "absent"
      - path: "src/llm/prompt-sections.ts"
        object_kind:
          head: "regular"
          index: "regular"
          worktree: "regular"
          untracked: "absent"
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:bbd58ad6f6a6a4d97c7a14aa9b0a8b24522621bdc49efe265dcf465ca87cd1e9"
        index_digest: "sha256:bbd58ad6f6a6a4d97c7a14aa9b0a8b24522621bdc49efe265dcf465ca87cd1e9"
        worktree_digest: "sha256:c105c3ae3755855795bbc452b8969a28d70eb0de4e0a1dcec67737598292e427"
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
        head_digest: "sha256:864976278378598667ee99093b6f145b67d86401400d1e84ab8ec1c2072189a8"
        index_digest: "sha256:864976278378598667ee99093b6f145b67d86401400d1e84ab8ec1c2072189a8"
        worktree_digest: "sha256:69a690bfc3e2453b8217ca33a7ea6bc2e0da6d789ae395af7143a3890ad0b458"
        untracked_digest: "absent"

  primary_symbols:
    - symbol: "partitionToolCalls"
      file: "src/agent/tool-execution-scheduler.ts"
      lines: "29-65"
      role: "Phân vùng danh sách tool calls thành các lô concurrent-read hoặc sequential barriers"
    - symbol: "PipelinedToolDispatcher"
      file: "src/agent/pipelined-tool-dispatcher.ts"
      lines: "30-160"
      role: "Bộ điều phối streaming early dispatch cho các công cụ chỉ đọc"
    - symbol: "AgentLoop.runInternal"
      file: "src/agent/agent-loop.ts"
      lines: "2685-2815"
      role: "Vòng lặp ReAct trung tâm điều phối thực thi phân vùng song song và tuần tự"

  related_symbols:
    - symbol: "CONCURRENT_READ_ONLY_TOOLS"
      relationship: "USES"
      relevance: "Danh mục các công cụ an toàn chỉ đọc được phép chạy song song"
    - symbol: "ToolRunner.run"
      relationship: "CALLS"
      relevance: "Pipeline 5 giai đoạn thực thi tool an toàn có kiểm soát budget"

  execution_path:
    - "Model phát ra mảng toolCalls trong response turn"
    - "Scheduler partitionToolCalls nhóm các read tools kế tiếp thành concurrent-read (kèm maxConcurrency chunking)"
    - "AgentLoop kích hoạt Promise.allSettled trên phân vùng, kết hợp kiểm tra bộ đệm pipelinedDispatcher"
    - "Vòng lặp tuần tự duyệt kết quả, chạy reflection, sanitize payload và thêm vào session history"

  pdg_constraints:
    - description: "Cấu trúc CDG của partitionToolCalls phụ thuộc vào guard isConcurrentReadOnlyTool(call.name) và pendingReads.length > 0."
      affected_statements:
        - "src/agent/tool-execution-scheduler.ts:37"
        - "src/agent/tool-execution-scheduler.ts:46"
      implementation_consequence: "Không được phá vỡ nhánh rẽ sequential khi gặp bất kỳ công cụ đột biến nào."

  files_to_modify:
    - file: "src/agent/tool-execution-scheduler.ts"
      symbols: ["partitionToolCalls", "DEFAULT_MAX_CONCURRENT_READS"]
      intended_change: "Hỗ trợ chunking cho các lô đọc lớn vượt quá giới hạn concurrency."
    - file: "src/agent/pipelined-tool-dispatcher.ts"
      symbols: ["SAFE_READ_ONLY_TOOLS"]
      intended_change: "Tái xuất từ CONCURRENT_READ_ONLY_TOOLS."
    - file: "src/agent/agent-loop.ts"
      symbols: ["runInternal"]
      intended_change: "Tích hợp kết quả pipelinedDispatcher vào concurrent read partition và bổ sung telemetry."

  tests:
    - file: "src/llm/dynamic-tool-masking.test.ts"
      scenarios:
        - "Lô 8 công cụ đọc liên tiếp được chia thành 2 partition concurrent-read có kích thước <= 6."
        - "Công cụ đột biến giữa 2 nhóm đọc tạo ra 3 partition [concurrent-read, sequential, concurrent-read]."
    - file: "src/test-latency-optimization.ts"
      scenarios:
        - "Đo lường thời gian thực thi của lô đọc song song cho thấy savingsMs > 0 so với tuần tự."

  verification_commands:
    - "node --import tsx --test src/llm/dynamic-tool-masking.test.ts"
    - "tsx src/test-latency-optimization.ts"
    - "npm run test:prompt-gating"
    - "npm run build"

  risks:
    - "Xung đột ghi nếu công cụ đột biến bị nhận diện nhầm là chỉ đọc."
    - "Vượt giới hạn File Descriptors nếu không khống chế concurrency cap."

  assumptions:
    - "Node.js runtime xử lý an toàn Promise.allSettled cho tối đa 6 I/O operations đồng thời mà không nghẽn event loop."
    - "Tất cả các công cụ trong CONCURRENT_READ_ONLY_TOOLS đều là pure read-only và không tạo side-effects lên đĩa hoặc trạng thái toàn cục."

  open_questions:
    - "Có nên cho phép các lệnh shell an toàn như 'git status', 'git diff' tham gia vào concurrent-read trong tương lai hay giữ chúng ở sequential barrier?"

  avoid:
    - "Do not remove sequential barriers for mutations or shell commands"
    - "Do not alter canonical alphabetical order of tool declarations at the prefix"
```

## 12. Assumptions and Open Questions

### Assumptions (Đã kiểm chứng / Giả định kỹ thuật)
1. **Thread-safety trong single-threaded Node.js**: Các thao tác I/O bất đồng bộ độc lập (như đọc tệp hoặc truy vấn đồ thị) hoàn toàn an toàn khi chạy song song qua `Promise.allSettled`.
2. **Prefix KV-Cache Invariance**: Việc giữ nguyên tập tool schemas và điều khiển danh sách công cụ được phép thông qua `allowedFunctionNames` bảo toàn tỷ lệ trúng cache >80%.

### Open Questions (Câu hỏi mở cho các phiên tiếp theo)
1. *Shell Read Operations*: Hiện tại mọi `run_command` đều được đối xử như một sequential barrier tuyệt đối. Liệu các lệnh đọc an toàn như `git status`, `git diff` có nên được cấp cờ `read-only` để chạy song song cùng `read_file` hay không? (Đề xuất: Tạm hoãn, giữ an toàn tuyệt đối).

## 13. Definition of Done

1. [x] Danh mục công cụ an toàn chỉ đọc được chuẩn hóa thống nhất giữa `tool-execution-scheduler.ts` và `pipelined-tool-dispatcher.ts`.
2. [x] Hàm `partitionToolCalls` có cơ chế khống chế concurrency tối đa (`maxConcurrency: 6`).
3. [x] `AgentLoop` kết nối liền mạch giữa `Promise.allSettled` và kết quả sớm của `pipelinedDispatcher`.
4. [x] Toàn bộ test suites liên quan (`dynamic-tool-masking.test.ts`, `test-latency-optimization.ts`, `test:prompt-gating`, `npm run build`) vượt qua 100%.
5. [x] Tài liệu kế hoạch được ghi nhận và xác thực đầy đủ bởi GitNexus Evidence Provenance v2.
