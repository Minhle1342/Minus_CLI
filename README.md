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

## 🔑 6 Công Cụ Cốt Lõi Của Coding Agent

1. **`read_file`**: Đọc nội dung file text trong workspace (hỗ trợ chỉ định khoảng dòng `startLine`/`endLine`).
2. **`list_files`**: Liệt kê danh sách file & thư mục con (tự động bỏ qua `node_modules`, `.git`, `dist`).
3. **`search_text`**: Tìm kiếm từ khoá/hàm trên toàn bộ codebase với giới hạn tối đa 50 kết quả.
4. **`replace_text`**: Sửa đổi code chính xác (surgical edit) bằng cách thay thế duy nhất 1 đoạn text gốc (`oldText` $\rightarrow$ `newText`).
5. **`write_file`**: Tạo file mới hoặc ghi đè file hoàn chỉnh (tự động tạo thư mục cha).
6. **`run_command`**: Thực thi các lệnh kiểm thử và build an toàn (`npm test`, `npm run build`, `git diff`,...).

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
│   │   └── types.ts               # Interface cấu hình & trạng thái Agent
│   │
│   ├── llm/
│   │   ├── gemini.ts              # Adapter giao tiếp Google Gemini SDK (@google/genai)
│   │   └── prompts.ts             # System prompt định hướng Coding Agent
│   │
│   ├── session/
│   │   └── session.ts             # Lưu trữ hội thoại & thought_signature in-memory
│   │
│   ├── workspace/
│   │   └── workspace.ts           # Quản lý ranh giới an toàn, resolveSafePath, ignore list
│   │
│   ├── tools/
│   │   ├── types.ts               # Interface ToolDefinition chuẩn
│   │   ├── registry.ts            # Tool Registry quản lý 6 tools & xuất FunctionDeclarations
│   │   ├── tool-runner.ts         # 5-stage Tool Execution Pipeline (Validation -> Safety -> Run)
│   │   ├── read-file.ts           # Tool đọc file (có line range & size limit)
│   │   ├── list-files.ts          # Tool liệt kê thư mục
│   │   ├── search-text.ts         # Tool tìm kiếm chuỗi văn bản trong code
│   │   ├── replace-text.ts        # Tool sửa text chính xác 1 vị trí
│   │   ├── write-file.ts          # Tool tạo mới / ghi đè file
│   │   └── run-command.ts         # Tool thực thi lệnh CLI (có allowlist & timeout)
│   │
│   ├── test-suite.ts              # 26 Unit Tests kiểm tra toàn diện hệ thống
│   └── test-scenarios.ts          # Các kịch bản kiểm thử trực tiếp với Gemini
│
├── package.json                   # Khai báo dependencies & scripts
├── tsconfig.json                  # Cấu hình TypeScript NodeNext
├── CODING_AGENT_ARCHITECTURE.md   # Giải thích chuyên sâu kiến trúc Coding Agent
├── CODING_AGENT_WALKTHROUGH.md    # Nhật ký theo dõi 6 bước giải quyết 1 bug thực tế
├── LEARNING.md                    # 10 câu hỏi nền tảng về kiến trúc Agent
└── README.md                      # Tài liệu tổng quan dự án
```

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
Chạy bộ 26 unit test kiểm tra Workspace, 6 Tools, ToolRunner Pipeline, và Mock Agent Loop:
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
