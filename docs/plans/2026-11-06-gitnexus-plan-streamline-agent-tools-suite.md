# GitNexus Engineering Plan

> Task: Lập kế hoạch tinh gọn số lượng tool đang có xuống mức thấp nhất nhưng đảm bảo vẫn cung cấp đủ khả năng explore file, edit file, create file và delete cho Agent (tái sử dụng run-command); giữ tool liên quan đến subagent, web_search, web_fetch có điều kiện (gated theo intent regex); ĐỒNG THỜI bổ sung bước chuẩn hóa Kernel, Tool Advisory (ToolSynergyAdvisor & ToolUseGuardian) và các Gate Evidence hiện hữu để triệt tiêu hoàn toàn xung đột giữa Harness và Agent trong quá trình thực thi task.
> Evidence verified at commit 35979bc81eb7efa2eb1e96abeed7936473296940; GitNexus index fresh (indexed at commit 35979bc81eb7efa2eb1e96abeed7936473296940).
> Evidence provenance schema 2; global dirty digest b2d0c4acdf055a7e8000231c248b5afb42fd2a39cd9f43ef3120511a9b88e08c; cited-path manifest 15 sorted entries; exact generated plan path excluded.

## 1. Objective

Thiết kế kiến trúc tinh gọn và đồng bộ hóa toàn diện bộ tool (Tool Suite) của MinusCLI:
1. **Core Minimal Tools:** Rút gọn các công cụ thao tác codebase thường trực xuống đúng **4 canonical tools** cốt lõi: `run_command`, `read_file`, `replace_text`, `write_file` [verified]. Tái sử dụng `run_command` làm execution backbone cho tìm kiếm (`rg`/`grep`), duyệt thư mục (`ls`/`dir`), và xóa tệp (`rm`/`del`) nhờ các bộ emulator có sẵn (`executeRipgrepEmulation`, `executeRmEmulation`).
2. **Intent-Gated Conditional Tools (Subagent + Web):**
   - **Giữ lại đầy đủ** các tool liên quan đến Subagent/Orchestration (`spawn_agent`, `wait_agent`, `get_agent_result`, `stop_agent`, `resume_agent`, `message_agent`, `allocate_agent_task`, `schedule_dag_parallel`, `verify_subagent_quality`, `brainstorm_design`) và Web (`web_search`, `web_fetch`).
   - **Chỉ gợi ý / đưa vào tool declarations của Agent khi intent regex match đúng prompt của user**:
     - *Subagent Tools:* Chỉ expose khi user prompt khớp regex ý định ủy quyền / chia việc đa agent (`hasDelegationIntent`), giúp tiết kiệm ~8,000 token schema cho các turn thông thường.
     - *Web Search & Web Fetch Tools:* Chỉ expose khi user prompt khớp regex ý định tra cứu mạng / URL / fetch tài liệu ngoài (`hasWebIntent` / `hasNetworkIntent`), tránh làm nhiễu không gian quyết định của LLM trong các tác vụ offline/codebase thuần túy.
3. **Chuẩn hóa Kernel, Tool Advisory & Evidence Gates (Tránh xung đột Harness vs Agent):**
   - **Kernel & Event Surface:** Đồng bộ `WorkspacePlugin` (`FILE_MUTATION_TOOLS`), snapshot rollback và checkpointing với 4 core tools + aliases.
   - **Tool Advisory & Navigation:** Cập nhật `ToolSynergyAdvisor`, `ToolUseGuardian` (`DEFAULT_TOOL_ALTERNATIVES`), `ReliableToolOrchestrator` (`RELIABLE_CONTEXT_TOOL_NAMES`) để không gợi ý hoặc ép buộc Agent gọi các tool đã demote (như `list_files`, `search_text`), thay bằng chỉ dẫn `run_command` (`ls`/`rg`) và `read_file`.
   - **Gate Evidence & Completion Invariants:** Cập nhật `CompletionEvidenceGate`, `CriticGate`, `classifyToolEvidence`, `observedMutationFiles`, và `extractInspectedFilesFromSession` để công nhận các bằng chứng exploration (duyệt/tìm kiếm code qua `run_command`), ngăn chặn tình trạng Harness phạt điểm hoặc từ chối hoàn thành task (Completion Blocker) khi Agent tuân thủ 4 core tools mới.
4. **100% Backward Compatibility:** Các tool đã nghỉ hưu (`delete_file`, `list_files`, `search_text`, và các alias `search_web`, `read_url_content`, v.v.) được giữ nguyên trong `TOOL_ALIASES` để bảo đảm các benchmark, script, harness bên ngoài không bị gãy vỡ.

## 2. Current Behaviour & Root Causes of Harness-Agent Conflicts

Hiện tại, MinusCLI đăng ký 16 tool files và compatibility aliases trong `src/tools/` [verified].
`src/tools/registry.ts` cấu hình `CANONICAL_MODEL_TOOL_NAMES` gồm 9 canonical tools:
- `read_file`, `write_file`, `replace_text`, `list_files`, `search_text`, `run_command`, `delete_file`, `web_search`, `web_fetch`.
Và nhóm Orchestration tools được đăng ký linh hoạt trong `AgentLoop` thông qua `createSpawnAgentTool`, v.v.

**Các xung đột tiềm tàng giữa Harness và Agent nếu chỉ refactor Tool Registry mà bỏ quên Kernel/Advisory/Gates:**
1. **Xung đột ở Tool Advisory (`ToolSynergyAdvisor`, `ToolUseGuardian`):**
   - `ToolSynergyAdvisor` hiện tại đang hardcode hướng dẫn: `"Explore with list_files and search_text..."` và gợi ý `suggestedTools: ['list_files', 'search_text', 'read_file']`.
   - Nếu Agent không thấy `list_files` và `search_text` trong declarations (chỉ có `run_command`), nhưng Advisory liên tục nhắc nhở và `ReliableToolOrchestration` ép buộc `selectedTool: 'search_text'`, Agent sẽ bị ảo giác gọi tool không tồn tại trong schema hoặc rơi vào trạng thái bối rối (oscillation loop).
   - `DEFAULT_TOOL_ALTERNATIVES` trong `ToolUseGuardian` vẫn map fallback sang `list_files` và `search_text`.
2. **Xung đột ở Evidence & Completion Gates (`CompletionEvidenceGate`, `CriticGate`):**
   - `CriticGate.evaluateExplorationExhaustion` kiểm tra `extractInspectedFilesFromSession`, chỉ lọc qua các quan sát `read_file`. Nếu Agent dùng `run_command("rg ...")` hoặc `run_command("ls")` để tìm kiếm file nhưng Harness không gắn nhãn `inspection` tương ứng, CriticGate có thể phạt điểm `EXPLORATION_EXHAUSTED_ZERO_EVIDENCE` hoặc `PREMATURE_SEARCH_CLOSURE`.
   - Trong `CompletionEvidenceGate`, hàm `classifyToolEvidence` phân loại `run_command` chạy `rg`/`grep`/`find` thành `other` thay vì `inspection`, khiến Agent thiếu bằng chứng khám phá khi bước vào phase kiểm chứng/hoàn thành.
3. **Xung đột ở Kernel Checkpointing & Mutation Tracking (`WorkspacePlugin`, `diff-generator`):**
   - `WorkspacePlugin` và `FILE_MUTATION_TOOLS` lắng nghe event `tool:before` để tự động chụp Snapshot Rollback trước khi sửa file. Nếu việc xóa file chuyển sang `run_command("rm ...")`, Kernel phải nhận biết được lệnh `rm` trong `run_command` để kích hoạt checkpoint bảo vệ, tránh mất dữ liệu không thể hoàn tác (`/undo`).

## 3. Relevant Architecture & GitNexus Call Graphs

Hệ thống điều phối của MinusCLI được liên kết chặt chẽ qua 5 tầng:
- **Tầng 1: Registration & Projection (`src/tools/registry.ts`):** Quản lý `CANONICAL_MODEL_TOOL_NAMES`, `MODEL_HIDDEN_TOOL_NAMES`, và `TOOL_ALIASES`.
- **Tầng 2: Intent Classification & Gating Engine (`src/control/request-intent.ts`, `src/control/this-turn-tool-gate.ts`, `src/agent/agent-loop.ts`):** 
  - `hasDelegationIntent`: Lọc và expose nhóm `ORCHESTRATION_TOOL_NAMES` khi user prompt yêu cầu chia task/subagent.
  - `hasWebIntent` & `hasNetworkIntent`: Lọc và expose `web_search` / `web_fetch` khi user prompt yêu cầu tra cứu web hoặc dán URL.
  - Turn Gate: Chỉ expose 4 canonical core tools (`run_command`, `read_file`, `replace_text`, `write_file`) cho các tác vụ thông thường.
- **Tầng 3: Cognitive Advisory & Navigation (`src/agent/tool-synergy-advisor.ts`, `src/agent/reliable-tool-orchestration.ts`, `src/tools/tool-use-guardian.ts`):**
  - Đồng bộ `ToolSynergyAdvisor.advise()` và `decideReliableToolRoute()` để định hướng Agent khám phá mã nguồn bằng `run_command('ls'/'dir'/'rg')` và `read_file`.
  - Cập nhật `DEFAULT_TOOL_ALTERNATIVES` và `CANONICAL_VISIBLE_TOOLS` trong `ToolSynergyAdvisor`.
- **Tầng 4: Evidence & Completion Gates (`src/agent/completion-evidence.ts`, `src/agent/critic-gate.ts`, `src/agent/completion-observations.ts`):**
  - `classifyToolEvidence`: Ghi nhận `run_command` chứa `rg`, `grep`, `ls`, `dir`, `find` là bằng chứng `inspection`.
  - `observedMutationFiles`: Ghi nhận `run_command` chứa `rm`/`del` kèm đường dẫn file vào danh sách filesModified.
- **Tầng 5: Kernel & Checkpointing (`src/kernel/plugins/workspace-plugin.ts`, `src/workspace/checkpoint.ts`):**
  - `WorkspacePlugin`: Khi nhận `tool:before` với `run_command`, phân tích AST lệnh shell; nếu là lệnh xóa (`rm`, `del`), tự động kích hoạt Shadow Checkpoint tương tự như `delete_file` trước đây.

## 4. GitNexus Graph & PDG Insights

- **ToolSynergyAdvisor Call Graph:** `ToolSynergyAdvisor.formatAdvicePrompt` lọc `suggestedTools` qua `CANONICAL_VISIBLE_TOOLS`. Nếu `list_files` và `search_text` không bị loại bỏ hoặc thay thế trong advisory, chuỗi prompt gửi cho LLM sẽ xung đột trực tiếp với schema 4 tools.
- **ReliableToolOrchestration Flow:** `decideReliableToolRoute` trả về `preferredTool` và `fallbackTools` tham chiếu trực tiếp đến `RELIABLE_CONTEXT_TOOL_NAMES` (`search_text`, `list_files`, `read_file`). Khi chuyển sang 4 core tools, `decideReliableToolRoute` cần ưu tiên `run_command` (search/inspect) và `read_file` (view), loại bỏ hoàn toàn việc gợi ý `list_files` và `search_text`.
- **Pre-Mutation Gate & Guardian Alternatives:** `ToolUseGuardian` tra cứu `DEFAULT_TOOL_ALTERNATIVES` khi công cụ gặp lỗi (như timeout, syntax, not found). Mapping cho `read_file` hiện tại là `['list_files', 'search_text', 'run_command']` -> cần chuẩn hóa thành `['run_command']`.
- **Evidence Classification Pipeline:** Trong `CompletionEvidenceGate`, `run_command` hiện chỉ gán `inspection` cho các lệnh `git (status|diff|log)`. Việc bổ sung regex nhận diện `SEARCH_COMMAND` (`rg|ripgrep|grep|findstr|ls|dir`) thành bằng chứng `inspection` giúp `CriticGate` công nhận hoạt động tìm kiếm qua CLI của Agent, loại bỏ hoàn toàn lỗi chặn giả (False-Positive Gate Rejection).

## 5. Specification: Chuẩn hóa 4 Khối Trọng Yếu

### 5.1 Khối Core Tools & Intent Regex Gating
- **Core Canonical Set (4 tools cố định):**
  ```typescript
  export const CANONICAL_MODEL_TOOL_NAMES = new Set([
    'run_command',
    'read_file',
    'replace_text',
    'write_file',
  ]);
  ```
- **Subagent Intent Gating:** Khớp `hasDelegationIntent(userRequest)` -> Bổ sung `ORCHESTRATION_TOOL_NAMES` vào declarations của turn.
- **Web Intent Gating:** Khớp `hasWebIntent(userRequest) || hasNetworkIntent(userRequest)` -> Bổ sung `web_search` / `web_fetch` vào declarations của turn.
- **Hidden Aliases:** Mọi tool cũ (`delete_file`, `list_files`, `search_text`, `search_web`, `read_url_content`) được chuyển vào `MODEL_HIDDEN_TOOL_NAMES` và liên kết trong `TOOL_ALIASES`.

### 5.2 Khối Tool Advisory & Navigation (`ToolSynergyAdvisor`, `ToolUseGuardian`)
- **`src/agent/tool-synergy-advisor.ts`:**
  - Cập nhật thông điệp Playbook mặc định (`GENERAL`):
    - *Cũ:* `"Explore with list_files and search_text, inspect implementation details with read_file..."`
    - *Mới:* `"Explore workspace with run_command (ls, dir, rg), inspect implementation details with read_file, edit with replace_text or write_file, and verify with run_command."`
  - Cập nhật `CANONICAL_VISIBLE_TOOLS`: Loại bỏ `list_files`, `search_text`, `delete_file` khỏi set hiển thị mặc định; thêm quy tắc mapping trong `ADVICE_TOOL_MAP`:
    ```typescript
    list_files: 'run_command',
    search_text: 'run_command',
    delete_file: 'run_command',
    ```
- **`src/tools/tool-use-guardian.ts`:**
  - Cập nhật `DEFAULT_TOOL_ALTERNATIVES`:
    ```typescript
    export const DEFAULT_TOOL_ALTERNATIVES: Record<string, string[]> = {
      search_codebase_fast: ['run_command', 'read_file'],
      search_text: ['run_command', 'read_file'],
      list_files: ['run_command'],
      read_file: ['run_command'],
      replace_text: ['write_file'],
      write_file: ['replace_text'],
      web_search: ['run_command'],
      web_fetch: ['run_command'],
    };
    ```
- **`src/agent/reliable-tool-orchestration.ts`:**
  - Cập nhật `RELIABLE_CONTEXT_TOOL_NAMES` thành `Set(['run_command', 'read_file'])`.
  - Cập nhật `decideReliableToolRoute`: Thay thế các khuyến nghị `preferredTool: 'search_text'` thành `preferredTool: 'run_command'` kèm gợi ý args mẫu `{ command: 'rg -n "<symbol>"' }` hoặc `preferredTool: 'read_file'`.

### 5.3 Khối Evidence & Completion Gates (`CompletionEvidenceGate`, `CriticGate`)
- **`src/agent/completion-evidence.ts`:**
  - Cập nhật `classifyToolEvidence` cho `run_command`:
    ```typescript
    if (toolName === 'run_command') {
      if (result.processStarted === false || result.exitCode !== 0
        || (result.commandOutcome !== undefined && result.commandOutcome !== 'succeeded')) return [];
      const cmd = extractCommandString(args, result);
      if (isScratchCommand(cmd)) return ['reproduction'];
      if (isVerificationCommand(cmd)) return ['verification'];
      if (/\bgit\s+(?:status|diff|log|show|branch|tag)\b/i.test(cmd)) return ['inspection', 'git'];
      // Bổ sung: Ghi nhận tìm kiếm & duyệt file bằng CLI là bằng chứng inspection
      if (/^(?:rg|ripgrep|grep|findstr|find|ls|dir)\b/i.test(cmd.trim())) return ['inspection'];
      return ['other'];
    }
    ```
  - Cập nhật `INSPECTION_TOOLS`: Giữ nguyên các alias cũ để phân tích lịch sử, đồng thời bổ sung logic công nhận `run_command` inspection.
- **`src/agent/completion-observations.ts`:**
  - Trong `hasObservedMutation`: Nhận diện khi `run_command` chạy thành công lệnh `rm`/`del` và có `result.deleted` hoặc target path thì coi như đã xảy ra mutation, bảo đảm hệ thống theo dõi trạng thái thay đổi đồng bộ.
- **`src/agent/critic-gate.ts`:**
  - Trong `evaluateExplorationExhaustion`: Cho phép bằng chứng tìm kiếm qua `run_command` (với `classifyToolEvidence === 'inspection'`) được tính vào điểm số đánh giá độ đầy đủ của quá trình khảo sát (`hasExplorationEvidence`), tránh phạt điểm oan khi Agent không dùng `list_files` mà dùng `ls`/`rg`.

### 5.4 Khối Kernel & Checkpointing (`WorkspacePlugin`)
- **`src/kernel/plugins/workspace-plugin.ts`:**
  - Trong handler `tool:before`:
    - Với `replace_text`, `write_file`: Tạo checkpoint tự động như bình thường.
    - Với `run_command`: Kiểm tra AST lệnh shell (`parseShellAst`). Nếu lệnh chứa thao tác xóa (`rm`, `del`, `Remove-Item`), tự động ghi nhận checkpoint trước khi lệnh thực thi. Điều này bảo toàn khả năng rollback an toàn của hệ thống dù Agent dùng shell command để xóa file.

## 6. Implementation Sequence

### Bước 1: Chuẩn hóa Regex Intent & Gating Logic
- Củng cố `hasDelegationIntent` trong `src/control/request-intent.ts`.
- Bổ sung `hasWebIntent` trong `src/control/network-intent.ts` hoặc `src/control/request-intent.ts`.
- Cập nhật `src/agent/agent-loop.ts` và `src/control/this-turn-tool-gate.ts` để filter orchestration tools và web tools theo intent regex.

### Bước 2: Chuẩn hóa Tool Registry & Aliases
- Trong `src/tools/registry.ts`: Cấu hình `CANONICAL_MODEL_TOOL_NAMES` chỉ gồm 4 core tools (`run_command`, `read_file`, `replace_text`, `write_file`).
- Chuyển `list_files`, `search_text`, `delete_file` sang `MODEL_HIDDEN_TOOL_NAMES` và bổ sung mapping trong `TOOL_ALIASES`.

### Bước 3: Đồng bộ hóa Tool Advisory & Guidance Systems
- Cập nhật `src/agent/tool-synergy-advisor.ts`: Cập nhật playbook text, loại bỏ `list_files`/`search_text` khỏi `suggestedTools` và `CANONICAL_VISIBLE_TOOLS`.
- Cập nhật `src/tools/tool-use-guardian.ts`: Chuẩn hóa `DEFAULT_TOOL_ALTERNATIVES` để chỉ trỏ về các canonical tools hợp lệ.
- Cập nhật `src/agent/reliable-tool-orchestration.ts`: Điều chỉnh `RELIABLE_CONTEXT_TOOL_NAMES` và router logic theo hướng `run_command` + `read_file`.

### Bước 4: Đồng bộ hóa Evidence Gates & Critic Gate
- Trong `src/agent/completion-evidence.ts`: Mở rộng `classifyToolEvidence` để công nhận các lệnh tìm kiếm/duyệt file của `run_command` là `inspection`.
- Trong `src/agent/critic-gate.ts`: Công nhận bằng chứng inspection từ `run_command`, ngăn ngừa xung đột `EXPLORATION_EXHAUSTED_ZERO_EVIDENCE`.
- Trong `src/control/tool-descriptor-registry.ts`: Cập nhật `READ_TOOL_NAMES` và `EDIT_TOOL_NAMES` đồng bộ với 4 core tools.

### Bước 5: Đồng bộ hóa Kernel & Rollback Checkpoint
- Trong `src/kernel/plugins/workspace-plugin.ts`: Đảm bảo `run_command` chứa hành vi xóa tệp (`rm`/`del`) kích hoạt shadow checkpointing đầy đủ trước khi thực thi.

### Bước 6: Kiểm thử toàn diện & Verification
- Chạy toàn bộ test suites của Kernel, Tool Runner, Tool Use Guardian, Tool Synergy Advisor, và Evidence Gates.
- Kiểm tra không còn bất kỳ warning hay lỗi xung đột nào giữa Harness và Agent.

## 7. Test Strategy & Conflict Prevention Matrix

| Thành phần Harness | Nguy cơ xung đột cũ | Cơ chế đã chuẩn hóa & Khắc phục | File Test kiểm chứng |
| :--- | :--- | :--- | :--- |
| **ToolSynergyAdvisor** | Advisor gợi ý gọi `list_files`/`search_text`, khiến LLM hoang mang vì tool không có trong schema. | Sanitize suggestedTools sang `run_command` và `read_file`. Cập nhật playbook prompt. | `src/agent/prompt-engineering-patterns.test.ts`, `src/agent/policy-guidance-regression.test.ts` |
| **ReliableToolOrchestrator** | Enforce router ép chọn `search_text`, xung đột với turn gate schema. | Cập nhật `RELIABLE_CONTEXT_TOOL_NAMES` và router hướng về `run_command` / `read_file`. | `src/agent/reliable-tool-orchestration.test.ts` |
| **ToolUseGuardian** | Tool gặp lỗi, Guardian gợi ý alternative là `list_files`/`search_text`. | Cập nhật `DEFAULT_TOOL_ALTERNATIVES` 100% trỏ về 4 canonical tools. | `src/tools/tool-use-guardian.test.ts` |
| **CriticGate** | Agent dùng `run_command('rg ...')` khám phá nhưng CriticGate phạt vì "không đọc đủ file". | `classifyToolEvidence` nhận diện `rg`/`ls` là `inspection`; CriticGate tính vào bằng chứng hợp lệ. | `src/agent/completion-policy.test.ts`, `src/agent/critic-gate.test.ts` |
| **CompletionEvidenceGate** | Agent hoàn thành task nhưng gate từ chối vì thiếu bằng chứng thay đổi/kiểm tra. | Bằng chứng verification và inspection được đồng bộ nhất quán từ `run_command`. | `src/agent/completion-evidence.command.test.ts` |
| **WorkspacePlugin** | Agent xóa file bằng `rm` trong `run_command` nhưng kernel không chụp checkpoint `/undo`. | Bổ sung phân tích AST shell trong `tool:before` để tự động tạo checkpoint trước lệnh `rm`. | `src/kernel/plugins/workspace-plugin.test.ts` |

## 8. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Harmonize MinusCLI: Streamline to 4 core tools, conditional intent gating for subagents/web, and full alignment of Kernel, Tool Advisory, and Evidence Gates to eliminate Harness-Agent friction."
  canonical_core_tools:
    - "run_command"
    - "read_file"
    - "replace_text"
    - "write_file"
  intent_gated_tools:
    subagent_orchestration:
      tools: ["spawn_agent", "wait_agent", "get_agent_result", "stop_agent", "resume_agent", "message_agent", "allocate_agent_task", "schedule_dag_parallel", "verify_subagent_quality", "brainstorm_design"]
      intent_checker: "hasDelegationIntent"
    web_suite:
      tools: ["web_search", "web_fetch"]
      intent_checker: "hasWebIntent || hasNetworkIntent"
  advisory_alignment:
    tool_synergy_advisor:
      default_playbook_explore: "run_command (ls, dir, rg) + read_file"
      tool_map: { list_files: "run_command", search_text: "run_command", delete_file: "run_command" }
    tool_use_guardian:
      alternatives: { read_file: ["run_command"], search_text: ["run_command", "read_file"] }
    reliable_orchestrator:
      context_tools: ["run_command", "read_file"]
  gate_evidence_alignment:
    inspection_commands: ["rg", "ripgrep", "grep", "findstr", "find", "ls", "dir"]
    critic_gate_acceptance: "Recognize run_command inspection evidence alongside read_file"
  kernel_alignment:
    workspace_plugin: "Shadow checkpoint triggers on run_command containing rm/del via shell AST parsing"
```

## 9. Definition of Done

1. Schema LLM ở các turn thông thường chỉ chứa đúng **4 canonical tools** cốt lõi (`run_command`, `read_file`, `replace_text`, `write_file`).
2. Nhóm Orchestration tools chỉ xuất hiện khi user prompt kích hoạt regex `hasDelegationIntent`.
3. Nhóm Web tools (`web_search`, `web_fetch`) chỉ xuất hiện khi prompt kích hoạt `hasWebIntent` hoặc chứa URL hợp lệ.
4. `ToolSynergyAdvisor`, `ToolUseGuardian`, và `ReliableToolOrchestrator` không còn gợi ý hoặc điều hướng Agent tới bất kỳ tool nào đã bị ẩn khỏi schema.
5. `CompletionEvidenceGate` và `CriticGate` công nhận hoạt động tìm kiếm/khảo sát của Agent qua `run_command` (`rg`/`ls`), không còn xảy ra hiện tượng chặn oan (False-positive block) khi Agent hoàn thành task.
6. `WorkspacePlugin` bảo đảm an toàn dữ liệu bằng cách tự động snapshot checkpoint trước khi `run_command` thực thi lệnh xóa (`rm`/`del`).
7. 100% test suites liên quan đến registry, tool runner, advisor, guardian, và evidence gates đều vượt qua với kết quả xanh.
