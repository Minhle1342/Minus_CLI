# 🚶 WALKTHROUGH: Hành Trình Của Một Request Trong Agent Loop

Tài liệu này theo dõi chi tiết từng bước (step-by-step trace) diễn ra bên trong hệ thống khi người dùng gửi một yêu cầu:

> **User Prompt:** *"Kiểm tra package.json và cho tôi biết Express đang ở version nào."*

---

## 🗺️ Tổng Quan Luồng Thực Thi

```text
User Prompt
    │
    ▼
[src/index.ts] ─────────────► Session.addUserMessage()
                                    │
                                    ▼
                             AgentLoop.run()
                                    │
    ┌───────────────────────────────┴───────────────────────────────┐
    ▼                                                               ▼
[STEP 1]                                                        [STEP 2]
1. LLM nhận: Prompt + 3 Tools schemas                           1. LLM nhận: Toàn bộ lịch sử + Tool Result
2. Gemini quyết định: Tool Call "read_file"                     2. Gemini phân tích nội dung file JSON
3. ToolRegistry.execute("read_file", {path: "package.json"})    3. Gemini trả về: Final Answer
4. Tool đọc file trả về chuỗi JSON thô                         4. AgentLoop kết thúc vòng lặp
5. Session.addToolResult() lưu kết quả                          5. In kết quả ra màn hình CLI
```

---

## 🔍 Chi Tiết Từng Bước (Deep Dive)

### Bước 0: Tiếp nhận đầu vào
* **File liên quan:** [src/index.ts](file:///D:/AgentLearn/AgentLoop/src/index.ts) & [src/session/session.ts](file:///D:/AgentLearn/AgentLoop/src/session/session.ts)
* **Hành động:**
  1. Người dùng nhập câu lệnh từ CLI terminal.
  2. `index.ts` tạo một đối tượng `Session` mới.
  3. Gọi `session.addUserMessage("Kiểm tra package.json và cho tôi biết Express đang ở version nào.")`.
  4. Trạng thái Session lúc này:
     ```json
     [
       {
         "role": "user",
         "parts": [{ "text": "Kiểm tra package.json và cho tôi biết Express đang ở version nào." }]
       }
     ]
     ```
  5. Gọi `agentLoop.run(session)`.

---

### Bước 1: Vòng lặp Step 1 (`step = 1 / 10`)
* **File liên quan:** [src/agent/agent-loop.ts](file:///D:/AgentLearn/AgentLoop/src/agent/agent-loop.ts), [src/llm/gemini.ts](file:///D:/AgentLearn/AgentLoop/src/llm/gemini.ts), [src/tools/registry.ts](file:///D:/AgentLearn/AgentLoop/src/tools/registry.ts), [src/tools/read-file.ts](file:///D:/AgentLearn/AgentLoop/src/tools/read-file.ts)

#### 1.1. Chuẩn bị dữ liệu gửi LLM
- `AgentLoop` gọi `toolRegistry.getFunctionDeclarations()` để lấy schema 3 công cụ:
  - `read_file(path)`
  - `list_files(path)`
  - `search_text(query, path)`
- Gọi `llm.generate(session, toolDeclarations)`.

#### 1.2. Gemini đưa ra quyết định (Reasoning)
- Gemini nhận thấy để trả lời câu hỏi, nó cần biết nội dung `package.json`.
- Gemini trả về phản hồi dạng `FunctionCall`:
  ```json
  {
    "toolCalls": [
      {
        "name": "read_file",
        "args": { "path": "package.json" }
      }
    ]
  }
  ```

#### 1.3. AgentLoop ghi nhận hành động của Model vào Session
- `session.addModelMessage(...)` được gọi:
  ```json
  {
    "role": "model",
    "parts": [
      {
        "functionCall": {
          "name": "read_file",
          "args": { "path": "package.json" }
        }
      }
    ]
  }
  ```

#### 1.4. Thực thi Tool qua Tool Registry
- `AgentLoop` tìm tool `read_file` trong `ToolRegistry` và gọi:
  ```ts
  const result = await toolRegistry.execute("read_file", { path: "package.json" });
  ```
- `readFileTool` kiểm tra tính an toàn của đường dẫn (`resolveSafePath`), đọc file thực tế từ ổ đĩa và trả về:
  ```json
  {
    "path": "package.json",
    "content": "{\n  \"name\": \"my-project\",\n  \"dependencies\": {\n    \"express\": \"^4.19.2\"\n  }\n}"
  }
  ```

#### 1.5. Ghi nhận kết quả Tool vào Session
- `session.addToolResult("read_file", result)` được gọi.
- Message mới được thêm vào Session dưới dạng `functionResponse`:
  ```json
  {
    "role": "user",
    "parts": [
      {
        "functionResponse": {
          "name": "read_file",
          "response": {
            "path": "package.json",
            "content": "{\n  \"name\": \"my-project\",\n  \"dependencies\": {\n    \"express\": \"^4.19.2\"\n  }\n}"
          }
        }
      }
    ]
  }
  ```
- `AgentLoop` gặp lệnh `continue;` và chuyển sang `step = 2`.

---

### Bước 2: Vòng lặp Step 2 (`step = 2 / 10`)
* **File liên quan:** [src/agent/agent-loop.ts](file:///D:/AgentLearn/AgentLoop/src/agent/agent-loop.ts), [src/llm/gemini.ts](file:///D:/AgentLearn/AgentLoop/src/llm/gemini.ts)

#### 2.1. Gửi lại toàn bộ Session cho Gemini
- Lần này, `session.getHistory()` chứa đầy đủ 3 tin nhắn:
  1. `user`: Câu hỏi ban đầu.
  2. `model`: Yêu cầu gọi tool `read_file`.
  3. `user` (functionResponse): Nội dung file `package.json`.
- `llm.generate(session, toolDeclarations)` được gọi.

#### 2.2. Gemini đọc kết quả và tạo Final Answer
- Gemini đọc nội dung file trong `functionResponse`, tìm thấy trường `"express": "^4.19.2"`.
- Vì đã có đủ dữ liệu, Gemini không yêu cầu gọi thêm tool nào nữa.
- Gemini trả về chuỗi văn bản:
  ```text
  Project đang sử dụng Express phiên bản ^4.19.2.
  ```

#### 2.3. Kết thúc vòng lặp
- `AgentLoop` kiểm tra `response.toolCalls.length === 0`.
- Ghi nhận câu trả lời cuối cùng vào Session: `session.addModelMessage({ text: finalAnswer })`.
- In kết quả ra màn hình CLI:
  ```text
  ====================================
  STEP 2 / 10
  ====================================

  MODEL ACTION:
  Final answer

  ANSWER:
  Project đang sử dụng Express phiên bản ^4.19.2.
  ```
- `AgentLoop.run()` trả về chuỗi kết quả và kết thúc.

---

## 🎯 Bảng Phân Tách Trách Nhiệm Từng File

| File | Trách nhiệm | Điều gì sẽ hỏng nếu file này làm sai? |
| :--- | :--- | :--- |
| **`src/index.ts`** | Khởi động, tạo dependencies, giao tiếp CLI | User không nhập được lệnh |
| **`src/session/session.ts`** | Lưu mảng messages in-memory | AI sẽ "mất trí nhớ", không biết Tool Result là gì |
| **`src/llm/gemini.ts`** | Chuyển đổi định dạng & gọi Gemini API | Lỗi giao tiếp mạng hoặc sai định dạng function calling |
| **`src/tools/read-file.ts`** | Đọc dữ liệu file thô an toàn | Đọc sai file hoặc bị lỗ hổng bảo mật path traversal |
| **`src/tools/registry.ts`** | Quản lý danh bạ Tools | Agent Loop không biết tìm code thực thi tool ở đâu |
| **`src/agent/agent-loop.ts`** | Điều phối vòng lặp, kiểm tra maxSteps | Agent bị treo vô tận hoặc không đưa kết quả tool cho AI |
