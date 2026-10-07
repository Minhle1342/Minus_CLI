# GitNexus Engineering Plan: 4 Cơ Chế Điều Hướng LLM Khám Phá Trước Khi Triển Khai (Explore-Before-Implement)

> Task: Thiết kế và tích hợp 4 cơ chế điều hướng LLM khám phá mã nguồn chuyên sâu trước khi thực hiện thêm, sửa hoặc xóa code trong Minus CLI.
> Context: Nghiên cứu đối chuẩn (Benchmarking) từ Claude Code (Plan Mode & Subagent Context Isolation), Aider (Tree-sitter Repo Map & PageRank), SWE-agent (ACI Pre-Mutation Inspection Barrier), và Cursor (Checklist-based CoT & Dynamic Anchors).
> Repository: Minus_CLI (GitNexus knowledge graph bound).

---

## 1. Objective

Triển khai đồng bộ **4 cơ chế điều hướng khám phá (Explore-Before-Implement Framework)** vào Minus CLI nhằm giải quyết triệt để 3 vấn đề cố hữu của coding agent:
1. **Chấm dứt hiện tượng "Sửa mù" (Blind Mutation)**: Ngăn chặn triệt để tình trạng model gọi `replace_text` / `apply_patch` lên các file chưa từng được đọc, dẫn đến lỗi kinh điển `contentHash mismatch` và `oldText not found`.
2. **Cưỡng chế phân tách 2 pha (Explore ➔ Implement Phase Enforcement)**: Học tập từ Claude Code Plan Mode, khi ở pha khám phá (`explore`), mô hình **vật lý không thể gọi công cụ sửa đổi** (Tool Masking) và buộc phải chuyển đổi pha có chủ đích.
3. **Rút ngắn số vòng lặp định vị (Zero-Turn Architectural Awareness)**: Học tập từ Aider Repo Map, tận dụng đồ thị tri thức sẵn có của GitNexus để tự động nạp "Bản đồ kiến trúc liên đới" (Warm-Start Topo-Map) ngay từ Turn 1, giúp model thấy ngay vị trí bug mà không phải tốn 2–3 turn gõ lệnh search dò dẫm.
4. **Chuẩn mực hóa quy trình sửa lỗi (SWE-bench Reproduction-First)**: Đảm bảo các tác vụ `bugfix` luôn có bằng chứng tái hiện lỗi thực nghiệm (reproduction failure) trước khi can thiệp vào mã nguồn sản phẩm.

---

## 2. Current Behaviour & Root Cause Analysis

### Hiện trạng trong Minus CLI:
1. **Về Phase Authority ([src/agent/phase-lifecycle.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/phase-lifecycle.ts))**:
   - Minus CLI đã có phân chia `capabilitiesForPhase`:
     - `explore`: `['inspect', 'search', 'memory']`
     - `implement`: `['inspect', 'search', 'memory', 'plan', 'edit', 'execute', 'verify', 'git-read', 'complete']`
   - *Lỗ hổng*: Trong [src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts), danh sách `activeToolDeclarations` gửi đến Gemini/LLM API đôi khi vẫn mở rộng đầy đủ các công cụ đột biến hoặc chỉ dựa vào prompt nhắc nhở, khiến model vẫn nhìn thấy `replace_text`, `write_file` và có thể gọi tùy tiện dù đang ở phase `explore`.
2. **Về Pre-Mutation Inspection ([src/tools/tool-use-guardian.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-use-guardian.ts))**:
   - `ToolUseGuardian` đã có thuộc tính `targetInspected` kiểm tra xem file đã nằm trong `gateContext.inspectedFiles` chưa.
   - *Lỗ hổng*: Cơ chế này vừa qua được chuyển sang dạng `UNVERIFIED_MUTATION_ADVISORY` (chỉ cảnh báo, không chặn cứng). Khi model bỏ qua cảnh báo và gọi `replace_text` mù với hash cũ hoặc code hallucinated, công cụ `replace_text` sẽ ném lỗi `FILE_CONTENT_CHANGED` hoặc `TEXT_NOT_FOUND` làm lãng phí token và thời gian của turn.
3. **Về Khởi đầu ngữ cảnh (Warm-Start Context)**:
   - Khi nhận prompt từ user, `DynamicContextArbiter` nạp các thông tin về memory, git status, playbook. Nhưng **không tự động phân tích thực thể trong prompt để truy vấn GitNexus**.
   - Model buộc phải tự phát sinh tool calls (`search_codebase_fast`, `find_by_name`, `list_files`) trong 1-2 turn đầu tiên chỉ để tìm xem file cần sửa nằm ở đâu.

---

## 3. Architecture of the 4 Mechanisms

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        MINUS CLI: EXPLORE-BEFORE-IMPLEMENT ARCHITECTURE                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  [TURN 1: USER PROMPT]                                                                 │
│         │                                                                              │
│         ▼                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────┐     │
│  │ Cơ chế 3: GitNexus Warm-Start Topo-Map (Aider Pattern)                       │     │
│  │ - Entity/Keyword Extractor trích xuất symbol từ prompt                       │     │
│  │ - GitNexus cached query -> Trích xuất 3-5 file trung tâm & callers/callees   │     │
│  │ - Nạp vào DynamicContextArbiter: [WORKSPACE TOPOLOGY WARM-START] (~200 toks) │     │
│  └──────────────────────────────────────┬───────────────────────────────────────┘     │
│                                         │                                              │
│                                         ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────┐     │
│  │ PHASE: EXPLORE                                                               │     │
│  │                                                                              │     │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │     │
│  │  │ Cơ chế 2: Strict Phase Tool Masking (Claude Code Plan Mode Pattern)    │  │     │
│  │  │ - activeToolDeclarations CHỈ gồm: read_file, search_*, codegraph_*,    │  │     │
│  │  │   gitnexus_*, get_diagnostics, request_phase_transition.              │  │     │
│  │  │ - TOÀN BỘ tool mutating (replace_text, apply_patch, write_file) BỊ ẨN! │  │     │
│  │  └────────────────────────────────────────────────────────────────────────┘  │     │
│  │                                                                              │     │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │     │
│  │  │ Cơ chế 4: Reproduction-First Checklist (SWE-bench SOTA)                │  │     │
│  │  │ - Nếu taskClass == 'bugfix': Tiêm Scaffold 3 bước:                     │  │     │
│  │  │   [REPRODUCE (Red)] ➔ [ISOLATE & FIX] ➔ [VERIFY PASS (Green)]          │  │     │
│  │  └────────────────────────────────────────────────────────────────────────┘  │     │
│  └──────────────────────────────────────┬───────────────────────────────────────┘     │
│                                         │ Model gọi request_phase_transition          │
│                                         ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────┐     │
│  │ PHASE: IMPLEMENT                                                             │     │
│  │                                                                              │     │
│  │  ┌────────────────────────────────────────────────────────────────────────┐  │     │
│  │  │ Cơ chế 1: Pre-Mutation Inspection Barrier (SWE-agent Pattern)          │  │     │
│  │  │ - Trước khi replace_text/apply_patch: Kiểm tra targetInspected.        │  │     │
│  │  │ - Nếu CHƯA đọc trong session: Chặn nhẹ kèm Actionable Guided Hint:     │  │     │
│  │  │   "Chưa đọc file X. Hãy gọi read_file('X') để lấy hash & anchor trước" │  │     │
│  │  └────────────────────────────────────────────────────────────────────────┘  │     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Specification of the 4 Mechanisms

### Cơ chế 1: Pre-Mutation Inspection Barrier & Auto Read-Anchor Guide
* **Mục tiêu**: Tuyệt đối không cho phép model mutate một file mà chưa từng gọi `read_file` trên file đó trong phiên làm việc.
* **Vị trí can thiệp**:
  - [src/tools/tool-use-guardian.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-use-guardian.ts) trong hàm `validatePreExecution`.
  - [src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts) theo dõi tập `sessionInspectedFiles: Set<string>`.
* **Cơ chế hoạt động**:
  - Khi tool gọi là tool đột biến (`replace_text`, `apply_patch`, `write_file`, `delete_file`):
    - Trích xuất đường dẫn đích (`filePath`).
    - Kiểm tra `sessionInspectedFiles.has(normalizedPath)`.
    - **Nếu chưa inspect**:
      - Từ chối thực thi với mã lỗi thân thiện `PRE_MUTATION_INSPECTION_REQUIRED`.
      - Trả về payload hướng dẫn cụ thể:
        ```json
        {
          "success": false,
          "errorCode": "PRE_MUTATION_INSPECTION_REQUIRED",
          "error": "File \"src/App.tsx\" has not been inspected in this session. Modifying without reading leads to stale hash and text-drift errors.",
          "suggestedTool": "read_file",
          "suggestedArgs": { "path": "src/App.tsx" },
          "suggestion": "Call read_file for \"src/App.tsx\" first to inspect exact lines, verify indentation, and obtain current contentHash."
        }
        ```
  - **Miễn trừ an toàn (Exemptions)**:
    - Tạo file hoàn toàn mới bằng `create_file` (nếu file chưa tồn tại trên đĩa).
    - File tạm trong thư mục `.scratch/`.

---

### Cơ chế 2: Strict Phase-Based Tool Masking (Explore vs Implement)
* **Mục tiêu**: Loại bỏ hoàn toàn khả năng LLM "sửa vội" bằng cách ẩn hẳn các công cụ đột biến khỏi danh sách Function Declarations gửi tới Gemini/LLM API khi đang ở phase `explore`.
* **Vị trí can thiệp**:
  - [src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts) tại vị trí lọc `activeToolDeclarations`.
  - [src/agent/phase-lifecycle.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/phase-lifecycle.ts).
* **Cơ chế hoạt động**:
  - Định nghĩa tập công cụ chỉ đọc an toàn cho phase `explore`:
    ```typescript
    const EXPLORE_PHASE_ALLOWED_TOOLS = new Set([
      'read_file', 'list_files', 'find_by_name', 'search_text', 'search_codebase_fast',
      'grep_search', 'inspect_symbol', 'find_references', 'get_diagnostics', 'lsp_query',
      'query_call_graph', 'get_symbol_context_360', 'get_architecture_topology',
      'codegraph_explore', 'codegraph_search', 'codegraph_impact',
      'search_web', 'read_url_content',
      'request_phase_transition', 'create_plan', 'update_plan_task'
    ]);
    ```
  - Khi `currentClassification.phase === 'explore'`:
    - `activeToolDeclarations = allTools.filter(t => EXPLORE_PHASE_ALLOWED_TOOLS.has(t.name))`
  - Khi LLM đã thu thập đủ thông tin, LLM gọi `request_phase_transition({ targetPhase: 'implement', rationale: '...', evidenceRefs: [...] })`.
  - Ngay ở turn/step tiếp theo, `currentClassification.phase` chuyển thành `implement` ➔ Bộ công cụ `replace_text`, `apply_patch`, `create_file`, `run_command` lập tức được kích hoạt đầy đủ!

---

### Cơ chế 3: GitNexus Warm-Start Topo-Map (Aider Repo Map Pattern)
* **Mục tiêu**: Cung cấp sẵn "tọa độ kiến trúc" cho LLM ngay từ Turn 1, giảm thời gian định vị từ 2–3 turn xuống còn 0 turn.
* **Vị trí can thiệp**:
  - Module mới: [src/agent/warm-start-topomap.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/warm-start-topomap.ts).
  - Tích hợp vào [src/agent/dynamic-context-arbiter.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/dynamic-context-arbiter.ts).
* **Cơ chế hoạt động**:
  1. **Entity Extraction**: Khi user nhập prompt (ví dụ: *"Sửa lỗi crash trong Navbar component khi click logout"*):
     - Trích xuất nhanh các định danh nghi vấn: `Navbar`, `logout`.
  2. **Fast Knowledge Graph Probe**:
     - Gọi `gitnexus.query({ search_query: "Navbar logout" })` hoặc truy vấn SQLite AST cache của GitNexus/CodeGraph.
     - Lấy top 3–5 file và các function liên đới (callers / callees).
  3. **High-Density Render**:
     - Định dạng thành một khối siêu gọn (~150-250 tokens):
       ```markdown
       🗺️ [WORKSPACE TOPOLOGY WARM-START (GitNexus Graph)]
       • src/components/Navbar.tsx: export function Navbar() -> calls useAuth()
       • src/context/AuthContext.tsx: export function logout() -> mutates session token
       • tests/navbar.test.tsx: suite 'Navbar Logout Flow'
       ```
  4. Nạp vào đầu lượt suy luận qua `DynamicContextArbiter` (có cache hit rate cao).

---

### Cơ chế 4: Reproduction-First Checklist cho Bugfix Tasks (SWE-bench SOTA)
* **Mục tiêu**: Chuẩn mực hóa tác vụ sửa lỗi theo phong cách Test-Driven Development của các agent SOTA trên bảng xếp hạng SWE-bench.
* **Vị trí can thiệp**:
  - [src/agent/step-prompt-policy.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/step-prompt-policy.ts) trong hàm `buildCognitiveScaffold`.
  - [src/agent/completion-evidence.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/completion-evidence.ts).
* **Cơ chế hoạt động**:
  - Khi `classification.taskClass === 'bugfix'`:
  - Hệ thống tự động kích hoạt **Reproduction Workflow Protocol**:
    ```markdown
    🧪 [BUGFIX REPRODUCTION PROTOCOL (MANDATORY WORKFLOW)]:
    Step 1 [Observe & Reproduce]: Run an existing test or execute a minimal command reproducing the bug. Confirm baseline failure (RED).
    Step 2 [Isolate & Inspect]: Use read_file to examine the root-cause implementation.
    Step 3 [Surgical Fix]: Transition to implement phase and apply minimal code changes.
    Step 4 [Verify Green]: Re-run the reproduction test and confirm exit code 0 (GREEN).
    ```
  - Cung cấp advisory rõ ràng nếu agent chuẩn bị gọi `submit_solution` mà chưa từng có lệnh test nào chạy thành công.

---

## 5. Implementation Roadmap & Milestones

### Milestone 1: Pre-Mutation Inspection Barrier (Cơ chế 1) — Độ ưu tiên cao nhất
* **Files**: [src/tools/tool-use-guardian.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/tools/tool-use-guardian.ts), [src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts)
* **Nội dung**:
  - Thêm `inspectedFilesThisSession` vào `Session` hoặc `AgentLoop`.
  - Khi `read_file` thành công, thêm đường dẫn chuẩn hóa vào `sessionInspectedFiles`.
  - Trong `ToolUseGuardian`, kiểm tra trước khi thực thi `replace_text` / `apply_patch`. Nếu chưa inspect, trả về lỗi `PRE_MUTATION_INSPECTION_REQUIRED` kèm gợi ý gọi `read_file`.
* **Rủi ro**: Không ảnh hưởng đến các lệnh tạo file mới (`create_file`).

### Milestone 2: Strict Phase-Based Tool Masking (Cơ chế 2) — Độ ưu tiên cao
* **Files**: [src/agent/agent-loop.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/agent-loop.ts), [src/agent/phase-lifecycle.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/phase-lifecycle.ts)
* **Nội dung**:
  - Tạo hàm `filterToolsForPhase(tools: FunctionDeclaration[], phase: TaskPhase)`.
  - Ở phase `explore`: loại trừ các tool đột biến mã nguồn (`replace_text`, `apply_patch`, `create_file`, `delete_file`, `write_file`).
  - Đảm bảo `request_phase_transition` luôn hiển thị ở phase `explore`.
* **Rủi ro**: Cần đảm bảo các test suite prompt-gating vẫn pass.

### Milestone 3: Reproduction-First Checklist (Cơ chế 4) — Độ ưu tiên trung bình
* **Files**: [src/agent/step-prompt-policy.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/step-prompt-policy.ts), [src/llm/prompt-sections.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/llm/prompt-sections.ts)
* **Nội dung**:
  - Thêm phần `REPRODUCTION_CHECKLIST` vào `buildCognitiveScaffold` khi `classification.taskClass === 'bugfix'`.
  - Hiển thị tiến độ checklist trực quan trong reasoning.

### Milestone 4: GitNexus Warm-Start Topo-Map (Cơ chế 3) — Độ ưu tiên cao / Tính năng lớn
* **Files**: [src/agent/warm-start-topomap.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/warm-start-topomap.ts) (mới), [src/agent/dynamic-context-arbiter.ts](file:///c:/Users/Admin/Downloads/WORKSPACE/MinusCLI/src/agent/dynamic-context-arbiter.ts)
* **Nội dung**:
  - Trích xuất keywords từ `session.getInitialRequest()`.
  - Truy vấn nhanh chỉ mục GitNexus/CodeGraph để tạo bản đồ 3–5 file quan trọng.
  - Tích hợp vào `DynamicContextArbiter` với ngân sách cố định tối đa 250 tokens.

---

## 6. Test & Verification Plan

1. **Unit Test Pre-Mutation Barrier**:
   - Test kịch bản: Gọi `replace_text` khi chưa gọi `read_file` ➔ Phải nhận lỗi `PRE_MUTATION_INSPECTION_REQUIRED`.
   - Test kịch bản: Gọi `read_file` thành công, sau đó gọi `replace_text` ➔ Được chấp thuận thực thi.
2. **Unit Test Tool Masking**:
   - Test kịch bản: Phase `explore` ➔ Mảng `activeToolDeclarations` không chứa `replace_text`, `apply_patch`.
   - Test kịch bản: Chuyển sang phase `implement` ➔ `replace_text`, `apply_patch` xuất hiện đầy đủ.
3. **Regression Tests Toàn Cục**:
   - `npm run test:latency`: Xác minh không làm tăng độ trễ phiên làm việc.
   - `npm run test:prompt-gating`: 13/13 subtests phải tiếp tục pass.
   - `npm run build`: TypeScript biên dịch 0 lỗi.

---

## 7. Rollout Readiness Checklist

- [x] Kế hoạch đã hoàn thành và được lưu trữ tại `docs/plans/2026-10-07-gitnexus-plan-explore-navigation-mechanisms.md`.
- [x] Xác định rõ 4 cơ chế độc lập, có thể thực hiện theo từng Milestone mà không làm gãy hệ thống hiện tại.
- [x] Tuân thủ triệt để nguyên tắc GitNexus & AGENTS.md (chạy impact trước khi sửa từng symbol, kiểm tra detect_changes trước khi commit).
- [x] Đã hoàn thành Milestone 1: Pre-Mutation Inspection Barrier (ToolUseGuardian + ToolRunner policy denial).
- [x] Đã hoàn thành Milestone 2: Strict Phase-Based Tool Masking (AgentLoop filterToolsForPhase).
- [x] Đã hoàn thành Milestone 3: Reproduction-First Checklist (Cognitive Harness TDD scaffold).
- [x] Đã hoàn thành Milestone 4: GitNexus Warm-Start Topo-Map (warm-start-topomap.ts + DynamicContextArbiter P1.43).
- [x] Đã hoàn thành và pass toàn bộ Verification Tests (npm run build, test:prompt-gating 13/13, test:latency, test:compaction, test:completion, explore-navigation-mechanisms unit tests 6/6).

