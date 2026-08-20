# 🚶 CODING_AGENT_WALKTHROUGH: Hành Trình Của Một Tác Vụ Coding Thực Tế

Tài liệu này theo dõi chi tiết từng bước (step-by-step trace) diễn ra bên trong hệ thống khi người dùng giao một nhiệm vụ lập trình thực tế cho Autonomous Coding Agent:

> **User Prompt:** *"Endpoint `/login` bị lỗi 500 khi người dùng không tồn tại. Hãy tìm nguyên nhân, sửa lỗi và chạy test để kiểm chứng."*

---

## 🗺️ Toàn Cảnh Chu Trình Thực Thi 6 Bước

```text
[USER PROMPT] ──► Session.addUserMessage()
                        │
                        ▼
                 AgentLoop.run()
                        │
 ┌──────────────────────┼──────────────────────┐
 ▼                      ▼                      ▼
[STEP 1: KHẢO SÁT]     [STEP 2: ĐỌC CODE]     [STEP 3: SỬA LỖI]
search_text("login")   read_file("auth.ts")   replace_text(old, new)
        │                      │                      │
        ▼                      ▼                      ▼
[STEP 4: XÁC THỰC]     [STEP 5: SOI DIFF]     [STEP 6: TỔNG KẾT]
run_command("npm test") run_command("git diff") Final Answer
```

---

## 🔍 Chi Tiết Từng Bước (Deep Dive)

### Bước 0: Tiếp nhận nhiệm vụ
* **Trạng thái Session:**
  ```json
  [
    {
      "role": "user",
      "parts": [{ "text": "Endpoint `/login` bị lỗi 500 khi người dùng không tồn tại. Hãy tìm nguyên nhân, sửa lỗi và chạy test để kiểm chứng." }]
    }
  ]
  ```

---

### Bước 1: Khảo sát vị trí code liên quan (`step = 1 / 10`)
* **Hành vi LLM:** Mô hình nhận thấy cần xác định file nào xử lý logic `/login`.
* **Tool Call:** `search_text`
  ```json
  {
    "query": "login",
    "path": "src"
  }
  ```
* **Tool Result trả về:**
  ```json
  {
    "query": "login",
    "matches": [
      { "file": "src/controllers/auth.ts", "line": 15, "text": "export async function login(req, res) {" },
      { "file": "src/routes/auth.ts", "line": 8, "text": "router.post('/login', login);" }
    ]
  }
  ```
* **Dữ liệu mới thu được:** File xử lý chính nằm tại `src/controllers/auth.ts` quanh dòng 15.

---

### Bước 2: Đọc mã nguồn để phân tích lỗi (`step = 2 / 10`)
* **Hành vi LLM:** Cần đọc các dòng code từ dòng 10 đến dòng 30 trong `src/controllers/auth.ts`.
* **Tool Call:** `read_file`
  ```json
  {
    "path": "src/controllers/auth.ts",
    "startLine": 10,
    "endLine": 30
  }
  ```
* **Tool Result trả về:**
  ```json
  {
    "path": "src/controllers/auth.ts",
    "content": "15: export async function login(req, res) {\n16:   const { email, password } = req.body;\n17:   const user = await findUserByEmail(email);\n18:   if (user.password !== password) {\n19:     return res.status(401).json({ error: 'Invalid password' });\n20:   }\n21:   return res.json({ token: 'jwt-token', userId: user.id });\n22: }",
    "startLine": 10,
    "endLine": 30
  }
  ```
* **Phát hiện của LLM:** Dòng 18 truy cập trực tiếp `user.password` trong khi chưa kiểm tra `if (!user)`. Khi email không tồn tại trong cơ sở dữ liệu, `user` nhận giá trị `null`, làm phát sinh lỗi runtime `TypeError: Cannot read properties of null (reading 'password')` dẫn đến HTTP 500!

---

### Bước 3: Thực hiện sửa đổi phẫu thuật (`step = 3 / 10`)
* **Hành vi LLM:** Thêm điều kiện kiểm tra `if (!user)` trước khi so sánh password bằng tool `replace_text`.
* **Tool Call:** `replace_text`
  ```json
  {
    "path": "src/controllers/auth.ts",
    "oldText": "  const user = await findUserByEmail(email);\n  if (user.password !== password) {",
    "newText": "  const user = await findUserByEmail(email);\n  if (!user) {\n    return res.status(404).json({ error: 'User not found' });\n  }\n  if (user.password !== password) {"
  }
  ```
* **Tool Result trả về:**
  ```json
  {
    "path": "src/controllers/auth.ts",
    "success": true,
    "message": "Đã thay thế thành công 1 vị trí trong \"src/controllers/auth.ts\"."
  }
  ```
* **Dữ liệu mới thu được:** Code đã được ghi thành công vào đĩa.

---

### Bước 4: Chạy kiểm thử tự động để xác minh (`step = 4 / 10`)
* **Hành vi LLM:** Theo nguyên tắc `EMPIRICAL VERIFICATION`, Agent không được phép dừng lại mà phải chạy test thực tế.
* **Tool Call:** `run_command`
  ```json
  {
    "command": "npm test"
  }
  ```
* **Tool Result trả về:**
  ```json
  {
    "command": "npm test",
    "exitCode": 0,
    "stdout": "PASS test/auth.test.ts\n  ✓ trả về 404 khi email không tồn tại (14 ms)\n  ✓ trả về 200 khi đăng nhập thành công (9 ms)\n\nTest Suites: 1 passed, 1 total\nTests: 2 passed, 2 total",
    "stderr": "",
    "timedOut": false
  }
  ```
* **Bằng chứng xác thực:** `exitCode: 0` chứng minh bản sửa đổi hoạt động hoàn hảo và vượt qua bộ test.

---

### Bước 5: Soi lại Git Diff (`step = 5 / 10`)
* **Hành vi LLM:** Xem lại toàn bộ thay đổi để đảm bảo không để sót code thừa hay debug log.
* **Tool Call:** `run_command`
  ```json
  {
    "command": "git diff src/controllers/auth.ts"
  }
  ```
* **Tool Result trả về:**
  ```json
  {
    "command": "git diff src/controllers/auth.ts",
    "exitCode": 0,
    "stdout": "@@ -17,2 +17,5 @@\n   const user = await findUserByEmail(email);\n+  if (!user) {\n+    return res.status(404).json({ error: 'User not found' });\n+  }\n   if (user.password !== password) {",
    "stderr": ""
  }
  ```

---

### Bước 6: Trả về câu trả lời cuối cùng có căn cứ (`step = 6 / 10`)
* **Hành vi LLM:** Trả về Final Answer dựa trên các bằng chứng thực tế thu thập được:
  ```text
  Đã khắc phục hoàn toàn lỗi HTTP 500 trong endpoint `/login`.

  ### 1. Nguyên nhân gốc rễ
  Tại file `src/controllers/auth.ts` dòng 18, hàm `login` truy cập thuộc tính `user.password` mà không kiểm tra trước trường hợp `user` là `null`. Khi user không tồn tại, hệ thống ném ra `TypeError` dẫn đến lỗi 500.

  ### 2. Các thay đổi đã thực hiện
  - File: `src/controllers/auth.ts`
  - Thêm đoạn kiểm tra `if (!user)` trả về mã lỗi HTTP 404 (`User not found`).

  ### 3. Kết quả kiểm thử thực nghiệm
  - Đã chạy `npm test`: Toàn bộ 2/2 test case passed với `exitCode: 0`.
  - Đã kiểm tra `git diff`: Bản vá gọn gàng, đúng trọng tâm.
  ```
