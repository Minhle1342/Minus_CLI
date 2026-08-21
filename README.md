# 🛠️ Autonomous Coding Agent (TypeScript + Node.js)

Một dự án mẫu giáo khoa giúp người học hiểu bản chất bên trong của một **Autonomous Coding Agent** — có khả năng tự động khảo sát codebase, sửa code, chạy lệnh kiểm thử/build, quan sát lỗi và xác minh kết quả mà không cần framework cồng kềnh (không dùng LangChain, CrewAI, AutoGen).

---

## 🎯 Kiến Trúc Vận Hành Khép Kín

```text
                                  USER
                                    │
                                    ▼
                         ┌────────────────────┐
                         │   CLI (index.ts)   │
                         └──────────┬─────────┘
                                    │
                                    ▼
                         ┌────────────────────┐
                         │     AgentLoop      │◄─────────────────────────────┐
                         └──────────┬─────────┘                              │
                                    │                                        │
                         Session + Tool Schemas                              │
                                       │                                     │
                                       ▼                                     │
                         ┌────────────────────┐                              │
                         │     GeminiLLM      │                              │
                         │ (System Prompt +   │                              │
                         │  Function Calling) │                              │
                         └──────────┬─────────┘                              │
                                    │                                        │
                        Decision: Tool Call or Final                         │
                                    │                                        │
                 ┌──────────────────┴──────────────────┐                     │
                 ▼                                     ▼                     │
            Final Answer                        Tool Call Request            │
                 │                                     │                     │
                 ▼                                     ▼                     │
           Print & Exit                        ┌──────────────┐              │
                                               │ ToolRegistry │              │
                                               └───────┬──────┘              │
                                                       │                     │
                                                       ▼                     │
                                           ┌──────────────────────┐          │
                                           │     Tool Runner      │          │
                                           │ (Validation Pipeline)│          │
                                           └───────────┬──────────┘          │
                                                       │                     │
                               ┌───────────────────────┼────────────────────┐│
                               ▼                       ▼                    ▼│
                        Inspect Tools              Edit Tools         Execute Tools
                        - read_file               - replace_text      - run_command
                        - list_files              - write_file
                        - search_text
                               │                       │                    │
                               └───────────────────────┼────────────────────┘│
                                                       │                     │
                                                       ▼                     │
                                               Normalized Result             │
                                                       │                     │
                                                       ▼                     │
                                           ┌──────────────────────┐          │
                                           │       Session        │──────────┘
                                           │ (addToolResult)      │  (Next Step)
                                           └──────────────────────┘
```

---

## 🧠 Session State + Memory Architecture

Hệ thống hiện tại đã tách rõ ba lớp trạng thái:

- **Session event log**: nguồn sự thật append-only cho message, tool call/result, plan, goal, queued input, fork và delegation state; được lưu dưới `.codingagent/sessions/*.jsonl`.
- **Working projection**: `Session.getHistory()` dựng lại context gửi cho LLM; compaction chỉ thay projection, không xóa raw events.
- **Memory architecture**: `ProjectMemoryManager` lưu insight theo scope `project/session/goal`, kèm source và confidence để retrieval có provenance.

Delegation có lifecycle durable (`running/completed/failed/stopped`). Sau restart, delegation đang `running` được chuyển thành `stopped`; chỉ `/agents resume <id>` hoặc `resume_agent` mới tạo lần chạy lại. Quy tắc này tránh tự nhân đôi side effect của tool.

Side-effect tools (`write_file`, `replace_text`, `run_command`) có effect ledger durable: `prepared → committed/failed → rolledback`. Nếu crash xảy ra sau `prepared`, recovery đánh dấu `outcome: unknown` để operator không vô tình retry một action có thể đã chạy.

Session operator commands: `/sessions`, `/sessions open <id>`, `/sessions new [id]`, `/sessions inspect [id]`.

Flow của một request:

```text
submit → input/queued → input/claimed → turn/start
       → pre-step/request hooks → LLM request
       → step/start → tool/call → tool/result → step/end
       → turn/end → session persistence
```

Subagent chạy trong child session riêng, dùng tool scope được giới hạn; parent nhận handle và các event `agent/delegation`.

---

## 🔑 6 Công Cụ Cốt Lõi Của Coding Agent

1. **`read_file`**: Đọc nội dung file text trong workspace (hỗ trợ chỉ định khoảng dòng `startLine`/`endLine`).
2. **`list_files`**: Liệt kê danh sách file & thư mục con (tự động bỏ qua `node_modules`, `.git`, `dist`).
3. **`search_text`**: Tìm kiếm từ khoá/hàm trên toàn bộ codebase với giới hạn tối đa 50 kết quả.
4. **`replace_text`**: Sửa đổi code chính xác (surgical edit) bằng cách thay thế duy nhất 1 đoạn text gốc (`oldText` $\rightarrow$ `newText`).
5. **`write_file`**: Tạo file mới hoặc ghi đè file hoàn chỉnh (tự động tạo thư mục cha).
6. **`run_command`**: Thực thi các lệnh kiểm thử và build an toàn (`npm test`, `npm run build`, `git diff`,...).

### Self-hosted web search

`SearchPlugin` còn đăng ký **`web_search`**, dùng SearXNG miễn phí và tự host. Chạy instance local đi kèm bằng `npm run search:up`, cấu hình `SEARXNG_BASE_URL`, rồi xem [hướng dẫn web search](docs/WEB_SEARCH.md) để biết tham số, bảo mật và cách vận hành.

---

## 📂 Cấu Trúc Mã Nguồn

```text
CodingAgent/
│
├── src/
│   ├── index.ts                   # Entry point CLI (Khởi tạo dependencies, giao tiếp REPL)
│   │
│   ├── agent/
│   │   ├── agent-loop.ts          # Vòng lặp điều phối cốt lõi (Agent Loop)
│   │   ├── agent-hooks.ts         # Plugin hooks cho agent/* lifecycle
│   │   ├── agent-inbox.ts          # Serialized inbox và durable input replay
│   │   ├── agent-registry.ts       # Live agent registry/status trong Kernel
│   │   ├── subagent-manager.ts     # Delegated child agents, polling và cancellation
│   │   ├── goal-manager.ts         # Durable Goal lifecycle, replay và explicit resume
│   │   └── types.ts               # Interface cấu hình & trạng thái Agent
│   │
│   ├── llm/
│   │   ├── gemini.ts              # Adapter giao tiếp Google Gemini SDK (@google/genai)
│   │   ├── prompt-assembler.ts     # System-prompt sections do plugin ghép deterministic
│   │   └── prompts.ts             # System prompt định hướng Coding Agent
│   │
│   ├── session/
│   │   ├── session.ts              # Event-sourced session và message projection
│   │   ├── session-manager.ts       # Kernel capability: load/create/fork/list sessions
│   │   └── session-persistence.ts  # Append-only JSONL persistence & resume
│   │
│   ├── memory/
│   │   ├── project-memory.ts        # Project KB, scoped retrieval và provenance
│   │   └── types.ts                 # Memory scope/source/confidence contracts
│   │
│   ├── workspace/
│   │   └── workspace.ts           # Quản lý ranh giới an toàn, resolveSafePath, ignore list
│   │
│   ├── tools/
│   │   ├── types.ts               # Interface ToolDefinition chuẩn
│   │   ├── registry.ts            # Tool Registry quản lý 6 tools & xuất FunctionDeclarations
│   │   ├── tool-runner.ts         # 5-stage Tool Execution Pipeline (Validation -> Safety -> Run)
│   │   ├── subagent-tools.ts      # delegate/get/status/stop/resume agent
│   │   ├── read-file.ts           # Tool đọc file (có line range & size limit)
│   │   ├── list-files.ts          # Tool liệt kê thư mục
│   │   ├── search-text.ts         # Tool tìm kiếm chuỗi văn bản trong code
│   │   ├── replace-text.ts        # Tool sửa text chính xác 1 vị trí
│   │   ├── write-file.ts          # Tool tạo mới / ghi đè file
│   │   └── run-command.ts         # Tool thực thi lệnh CLI (có allowlist & timeout)
│   │
│   ├── skills/                    # Superpowers Skills Registry, Loader & Activator
│   │   ├── types.ts               # Định nghĩa SkillManifest & Activation types
│   │   ├── skill-loader.ts        # Parser frontmatter an toàn & SHA-256 hashing
│   │   ├── skill-registry.ts      # Quản lý danh mục kỹ năng Superpowers
│   │   ├── skill-activator.ts     # Kích hoạt xác định và nạp prompt sections
│   │   ├── superpowers-source.ts  # Bộ 8 Superpowers skills tích hợp sẵn
│   │   ├── verification-policy.ts # Ràng buộc verification-before-completion
│   │   └── workflow-map.ts        # Bản đồ quy trình Superpowers (Brainstorming -> Finishing)
│   │
│   ├── capabilities/              # Capability Catalog & Safety Policies
│   │   ├── types.ts               # Định nghĩa CapabilityDescriptor & Policy
│   │   ├── capability-catalog.ts  # Danh mục các capability của hệ thống
│   │   ├── capability-policy.ts   # Thẩm định an toàn, quyền readonly và approval
│   │   └── default-capabilities.ts # Ánh xạ chuẩn từ Tool sang Capability
│   │
│   ├── test-suite.ts              # 228 assertions kiểm tra toàn diện hệ thống
│   └── test-scenarios.ts          # Các kịch bản kiểm thử trực tiếp với Gemini
│
├── package.json                   # Khai báo dependencies & scripts
├── tsconfig.json                  # Cấu hình TypeScript NodeNext
├── docs/
│   ├── SUPERPOWERS_INTEGRATION.md # Hướng dẫn chi tiết kiến trúc Superpowers
│   └── superpowers/               # Kế hoạch & Ma trận tương thích
├── CODING_AGENT_ARCHITECTURE.md   # Giải thích chuyên sâu kiến trúc Coding Agent
├── CODING_AGENT_WALKTHROUGH.md    # Nhật ký theo dõi 6 bước giải quyết 1 bug thực tế
├── LEARNING.md                    # 10 câu hỏi nền tảng về kiến trúc Agent
└── README.md                      # Tài liệu tổng quan dự án
```

---

## ⚡ Tích Hợp Superpowers & Capability Catalog

Hệ thống tích hợp đầy đủ phương pháp luận và bộ kỹ năng từ **Superpowers** (`obra/superpowers`):
- **Skills as Contextual Instructions:** Các file Markdown kỹ năng (`using-superpowers`, `test-driven-development`, `writing-plans`, v.v.) được phát hiện, xác thực và nạp xác định vào System Prompt theo từng turn.
- **Explicit Capability Adapters:** Tách biệt rõ ràng giữa mô tả nghiệp vụ của kỹ năng và công cụ thực thi mã lệnh thông qua `CapabilityCatalog`.
- **An Toàn & Kiểm Soát:** Hỗ trợ tạo workspace cô lập (`create_worktree`), phê duyệt trước hành động rủi ro cao (`/approvals`), review đa vai trò (`request_review`), và bắt buộc vượt qua kiểm thử trước khi kết thúc (`VerificationPolicy`).

### Các lệnh điều hành Superpowers trên CLI:
- `/skills`: Xem danh sách tất cả các kỹ năng đã cài đặt và trạng thái kích hoạt.
- `/skills inspect <id>`: Kiểm tra chi tiết manifest, hash, và yêu cầu của 1 skill.
- `/capabilities`: Xem danh mục capabilities, phân loại side-effect và quy tắc an toàn.
- `/approvals`: Xem và duyệt/từ chối các yêu cầu chờ phê duyệt từ Agent.

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy

### 1. Cài đặt dependencies
```bash
npm install
```

### 2. Cấu hình API Key
Tạo file `.env` và điền Gemini API key của bạn:
```env
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.5-flash
```

### 3. Chạy kiểm thử tự động (Unit Tests)
Chạy bộ test kiểm tra Workspace, tools, ToolRunner Pipeline, session lifecycle, memory, hooks và subagents:
```bash
npm test
```

### 4. Build TypeScript
```bash
npm run build
```

### 5. Khởi động CLI Coding Agent tương tác
```bash
npm run dev
```

Lệnh `npm run dev` tự động chạy lifecycle script `predev`, khởi động SearXNG bằng Docker Compose ở chế độ nền trước khi mở CLI. Có thể dừng riêng search service bằng `npm run search:down`.

---

## 📖 Lộ Trình Đọc Code Cho Người Mới Học

1. **[src/workspace/workspace.ts](file:///D:/AgentLearn/CodingAgent/src/workspace/workspace.ts)**: Xem cách thiết lập ranh giới an toàn cho workspace và chống path traversal.
2. **[src/tools/types.ts](file:///D:/AgentLearn/CodingAgent/src/tools/types.ts)**: Hiểu chuẩn giao tiếp của 1 Tool.
3. **[src/tools/replace-text.ts](file:///D:/AgentLearn/CodingAgent/src/tools/replace-text.ts)** & **[src/tools/run-command.ts](file:///D:/AgentLearn/CodingAgent/src/tools/run-command.ts)**: Xem cách công cụ sửa code và chạy lệnh được thiết kế an toàn.
4. **[src/tools/tool-runner.ts](file:///D:/AgentLearn/CodingAgent/src/tools/tool-runner.ts)**: Tìm hiểu quy trình 5 giai đoạn thẩm định tool trước khi thực thi.
5. **[src/tools/registry.ts](file:///D:/AgentLearn/CodingAgent/src/tools/registry.ts)**: Xem cách quản lý danh bạ công cụ.
6. **[src/llm/prompts.ts](file:///D:/AgentLearn/CodingAgent/src/llm/prompts.ts)** & **[src/llm/gemini.ts](file:///D:/AgentLearn/CodingAgent/src/llm/gemini.ts)**: Xem cách nạp System Prompt và giao tiếp Gemini API.
7. **[src/session/session.ts](file:///D:/AgentLearn/CodingAgent/src/session/session.ts)**: Hiểu cách bộ nhớ làm việc ghi nhận lịch sử.
8. **[src/agent/agent-loop.ts](file:///D:/AgentLearn/CodingAgent/src/agent/agent-loop.ts)**: **Trọng tâm chính** — Vòng lặp điều phối khép kín của Coding Agent.
9. **[src/index.ts](file:///D:/AgentLearn/CodingAgent/src/index.ts)**: Entry point kết nối toàn bộ hệ thống.
