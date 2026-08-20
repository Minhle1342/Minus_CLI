# 🏗️ CODING_AGENT_ARCHITECTURE: Kiến Trúc Của Một Autonomous Coding Agent

Tài liệu này giải thích chi tiết toàn bộ kiến trúc bên trong của một **Autonomous Coding Agent** viết bằng TypeScript + Node.js không phụ thuộc framework, giúp người học hiểu rõ cơ chế vận hành từ nguyên lý cơ bản.

---

## 🗺️ 1. Sơ Đồ Kiến Trúc Tổng Thể

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
                                       │                                        │
                                       ▼                                        │
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

## 🔑 2. Sự Khác Biệt Giữa "Trí Tuệ Agent" và "Trí Tuệ Tool"

Một trong những sai lầm phổ biến nhất khi mới tiếp cận AI Agent là cố gắng nhồi nhét logic suy luận phức tạp vào bên trong Tool.

| Thành phần | Trách nhiệm cốt lõi | Ví dụ |
| :--- | :--- | :--- |
| **Agent / LLM (Bộ não suy luận)** | • Hiểu mục tiêu của user<br>• Lập kế hoạch hành động<br>• Quyết định tool nào cần gọi và tham số gì<br>• Đọc và phân tích lỗi từ terminal<br>• Xác định khi nào công việc đã hoàn thành | *"Tôi thấy test thất bại với mã lỗi TypeError ở dòng 18. Tôi cần đọc file auth.ts và thêm lệnh kiểm tra `if (!user)`."* |
| **Tool (Cảm biến & Cơ cấu chấp hành)** | • Hoạt động tất định (deterministic)<br>• Thực thi chính xác lệnh hệ thống<br>• Kiểm tra tính hợp lệ của tham số đầu vào<br>• Trả về kết quả hoặc thông báo lỗi thô | • `read_file`: Đọc nội dung file từ đĩa.<br>• `replace_text`: Thay thế chuỗi text gốc.<br>• `run_command`: Chạy process và bắt stdout/stderr. |

> **Nguyên tắc vàng:** Tool chỉ thay đổi hoặc thu thập trạng thái hệ thống. LLM là bên duy nhất diễn giải trạng thái đó.

---

## 🛡️ 3. Quy Trình 5 Giai Đoạn Của Tool Execution Pipeline

Khi LLM yêu cầu gọi một tool, request không được chuyển thẳng vào hàm thực thi mà phải đi qua **5 chốt kiểm soát an toàn** trong [src/tools/tool-runner.ts](file:///D:/AgentLearn/CodingAgent/src/tools/tool-runner.ts):

```text
LLM Tool Call Request (name, args)
    │
    ▼
[ Stage 1: Tool Lookup ]
- Kiểm tra xem tool có nằm trong ToolRegistry không.
- Nếu không có: Trả về lỗi UNKNOWN_TOOL kèm danh sách tool hiện có.
    │
    ▼
[ Stage 2: Input Validation ]
- Kiểm tra các tham số bắt buộc (required) theo FunctionDeclaration schema.
- Nếu thiếu: Trả về lỗi INVALID_ARGS.
    │
    ▼
[ Stage 3: Workspace & Safety Policy ]
- Rà soát đường dẫn (resolveSafePath): Chặn đứng mọi hành vi thoát workspace (../../).
- Kiểm tra file bảo vệ: Chặn sửa đổi các file nhạy cảm (.env).
- Lệnh an toàn: Đối với run_command, chỉ chấp nhận các tiền tố trong allowlist (npm test, npm run, git diff,...).
    │
    ▼
[ Stage 4: Sandboxed Execution & Timeout ]
- Thực thi tool trong khối try/catch an toàn.
- Áp dụng timeout 30s đối với các tiến trình chạy ngoài.
    │
    ▼
[ Stage 5: Output Normalization ]
- Cắt ngắn output nếu stdout/stderr vượt quá 50KB để bảo vệ context LLM.
- Đóng gói dữ liệu thành JSON Record gửi về Session.
```

---

## ✂️ 4. Chiến Lược Sửa Code: Vì Sao `replace_text` Tốt Hơn `write_file`?

Khi Coding Agent cần sửa một đoạn code 3 dòng trong file dài 500 dòng:

### Cách 1: Dùng `write_file` (Viết lại cả file)
* **Nhược điểm lớn:**
  1. Tốn token: LLM phải sinh lại toàn bộ 500 dòng code.
  2. Dễ lỗi: LLM rất dễ "quên", tự ý cắt bớt các hàm không liên quan hoặc sinh mã giả `// ... existing code ...`.
  3. Mất dấu vết git diff sạch.

### Cách 2: Dùng `replace_text` (Surgical Search & Replace)
* **Ưu điểm vượt trội:**
  1. Tiết kiệm token tối đa: Chỉ truyền đoạn `oldText` cần sửa và `newText` thay thế.
  2. Bắt buộc LLM phải đọc file thật: Nếu LLM ảo giác hoặc bịa đặt code gốc, `replace_text` sẽ báo lỗi `"Không tìm thấy đoạn text gốc"`.
  3. Chống sửa nhầm vị trí: Nếu `oldText` xuất hiện nhiều hơn 1 lần, tool sẽ từ chối và yêu cầu LLM cung cấp thêm các dòng ngữ cảnh xung quanh.

---

## 🔄 5. Vòng Lặp Xác Thực Thực Nghiệm (The Verification Loop)

Một Coding Agent thực thụ **không bao giờ tin tưởng tuyệt đối vào code mình vừa viết**. Sau khi chỉnh sửa, Agent luôn bước vào vòng lặp xác thực:

```text
┌────────────────────────────────────────────────────────┐
│                   INSPECT CODEBASE                     │
│               (search_text, read_file)                 │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│                   MODIFY CODEBASE                      │
│              (replace_text, write_file)                │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│                   RUN VERIFICATION                     │
│             (run_command: "npm test")                  │
└──────────────────────────┬─────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      [ Exit Code != 0 ]          [ Exit Code == 0 ]
   (Test Failed / Build Error)     (Tests Passed!)
             │                           │
             ▼                           ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│      OBSERVE ERROR       │   │       INSPECT DIFF       │
│  (Read stderr / stack)   │   │(run_command: "git diff") │
└────────────┬─────────────┘   └──────────┬───────────────┘
             │                            │
             ▼                            ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│      REPAIR EDIT         │   │       FINAL ANSWER       │
│ (replace_text new fix)   │   │  (Summarize changes &    │
└────────────┬─────────────┘   │   verified evidence)     │
             │                 └──────────────────────────┘
             └───────────► (Re-run Verification)
```

---

## 📊 6. Danh Mục 6 Tools Cốt Lõi

| Tool | Nhóm | Công dụng |
| :--- | :--- | :--- |
| **`read_file`** | Khảo sát | Đọc file trong workspace, hỗ trợ đọc theo dòng (`startLine`/`endLine`). |
| **`list_files`** | Khảo sát | Liệt kê file và thư mục, tự động lọc `node_modules`, `.git`, `dist`. |
| **`search_text`** | Khảo sát | Tìm kiếm từ khoá trong toàn bộ code với giới hạn 50 matches. |
| **`replace_text`** | Chỉnh sửa | Thay thế chính xác 1 khối text duy nhất trong file. |
| **`write_file`** | Chỉnh sửa | Tạo file mới hoặc ghi đè toàn bộ (tự động tạo thư mục cha). |
| **`run_command`** | Thực thi | Chạy lệnh kiểm thử (`npm test`, `npm run build`, `git diff`) an toàn có timeout. |
