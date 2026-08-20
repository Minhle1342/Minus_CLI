# 🧠 LEARNING: Các Câu Hỏi Nền Tảng Về Kiến Trúc AI Coding Agent

Tài liệu này giải thích bản chất tư duy kiến trúc và các quyết định thiết kế quan trọng nhất khi xây dựng một **Autonomous Coding Agent**.

---

### 1. Sự khác biệt cốt lõi giữa "Chatbot hỗ trợ viết code" và "Autonomous Coding Agent"?
* **Chatbot (như ChatGPT thông thường):** Chỉ nhận prompt của bạn, sinh ra một khối code trong khung chat và kết thúc lượt phản hồi. Bạn phải tự copy code vào dự án, tự chạy test, tự đọc log lỗi và tự copy log lỗi gửi lại cho AI.
* **Autonomous Coding Agent:** Tự động hóa toàn bộ chu trình kỹ thuật phần mềm:
  1. Tự tìm kiếm các file liên quan trong codebase.
  2. Tự đọc nội dung file để hiểu bối cảnh.
  3. Tự chỉnh sửa trực tiếp vào file trên đĩa.
  4. Tự kích hoạt lệnh test/build trên terminal.
  5. Tự quan sát mã lỗi `exitCode` và `stderr` để sửa lại nếu test thất bại.
  6. Chỉ thông báo hoàn thành khi đã có bằng chứng thực nghiệm rõ ràng.

---

### 2. Vì sao `replace_text` lại an toàn và hiệu quả hơn `write_file` khi sửa code?
Khi AI cần sửa 2 dòng trong một file mã nguồn 400 dòng:
* **Nếu dùng `write_file` (ghi đè cả file):**
  - LLM phải sinh lại 400 dòng code $\rightarrow$ Tốn token, độ trễ phản hồi cao.
  - LLM có xu hướng "lười", tự ý viết `// ... rest of code unchanged ...` làm hỏng hoàn toàn file mã nguồn thật.
  - Dễ vô tình xoá mất các comment hoặc logic quan trọng ở các hàm khác.
* **Khi dùng `replace_text` (Surgical Search & Replace):**
  - Chỉ gửi đoạn `oldText` cần sửa và `newText` mới $\rightarrow$ Tiết kiệm ~95% token.
  - Bắt buộc LLM phải dùng `read_file` trước để lấy chính xác đoạn code gốc. Nếu LLM bịa đặt code, tool sẽ từ chối thực thi ngay lập tức.
  - Kiểm tra tính duy nhất: Nếu `oldText` xuất hiện ở nhiều vị trí, tool sẽ yêu cầu bổ sung dòng ngữ cảnh xung quanh để tránh sửa nhầm.

---

### 3. Vòng lặp xác thực thực nghiệm (The Verification Loop) giải quyết vấn đề gì?
* **Ảo giác khẳng định (Confirmation Bias / Hallucination):** LLM thường có xu hướng trả lời rất tự tin *"Tôi đã sửa lỗi thành công"* ngay cả khi code vừa sinh ra bị lỗi cú pháp hoặc làm gãy các luồng nghiệp vụ khác.
* **Giải pháp:** Bắt buộc Agent phải đi qua **Verification Loop** (Chạy `npm test` hoặc `npm run build` qua tool `run_command`).
* **Quy tắc cứng:** Agent chỉ được phép đưa ra Final Answer khẳng định thành công khi trong Session xuất hiện kết quả thực thi công cụ với `exitCode: 0`.

---

### 4. Tool Execution Pipeline 5 giai đoạn đóng vai trò gì?
Nếu để Agent Loop gọi trực tiếp hàm thực thi của Tool, hệ thống sẽ rất dễ đổ vỡ khi LLM truyền sai kiểu dữ liệu hoặc gọi tool nguy hiểm.
Pipeline 5 giai đoạn trong [src/tools/tool-runner.ts](file:///D:/AgentLearn/CodingAgent/src/tools/tool-runner.ts) tạo ra một lớp bảo vệ toàn diện:
1. **Tool Lookup:** Bắt lỗi gọi tool không tồn tại (`UNKNOWN_TOOL`).
2. **Input Validation:** Xác thực các trường bắt buộc theo Schema (`INVALID_ARGS`).
3. **Security Policy:** Ngăn chặn path traversal (`../../`) và chặn sửa đổi các file nhạy cảm (`.env`).
4. **Sandboxed Execution & Timeout:** Ngăn chặn các lệnh bị treo vô tận (giới hạn 30s).
5. **Output Normalization:** Cắt ngắn output nếu stdout quá 50KB để bảo vệ context LLM.

---

### 5. Vì sao nên dùng Command Allowlist thay vì Blacklist cho `run_command`?
* **Blacklist (Chặn các lệnh cấm):** Rất dễ bị vượt qua bằng các kỹ thuật như nối lệnh (`;`, `&&`), gõ đường dẫn đầy đủ, hoặc alias hệ thống.
* **Allowlist (Chỉ cho phép danh sách an toàn):** Chỉ cho phép các lệnh rõ ràng cần thiết cho công việc lập trình (`npm test`, `npm run build`, `git diff`, `git status`). Bất kỳ lệnh lạ nào ngoài danh mục đều bị chặn ngay tại cửa kiểm soát. Đây là nguyên tắc đặc quyền tối thiểu (Principle of Least Privilege).

---

### 6. Khi nào nên dùng `read_file` theo khoảng dòng (`startLine`/`endLine`)?
Trong các dự án lớn, một file có thể dài hàng nghìn dòng:
* Nếu đọc toàn bộ file, toàn bộ context window của LLM sẽ bị lấp đầy bởi mã nguồn không liên quan, dẫn đến chi phí token tăng vọt và làm giảm khả năng tập trung của mô hình vào vị trí lỗi.
* Sử dụng `search_text` để định vị số dòng $\rightarrow$ Sau đó dùng `read_file` với `startLine` và `endLine` chỉ đọc 20-30 dòng xung quanh khu vực nghi vấn là chiến thuật tối ưu nhất.

---

### 7. Tách biệt giữa Trách nhiệm của Tool và Trách nhiệm của Agent
* **Tool:** Tuyệt đối không tự suy diễn, không tự kết luận đúng/sai về mặt nghiệp vụ. Nhiệm vụ duy nhất của Tool là tương tác với hệ điều hành một cách trung thực và trả về dữ liệu thô.
* **Agent (LLM):** Là bên duy nhất chịu trách nhiệm đọc dữ liệu thô, phân tích mã lỗi từ terminal, lập giả thuyết, và đưa ra quyết định hành động tiếp theo.
