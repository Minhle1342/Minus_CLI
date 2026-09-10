# Task Plan: Khắc phục và Nâng cấp Công cụ Khảo sát Codebase (Code Intelligence Tools)

## Mục tiêu chiến lược
Khắc phục các điểm yếu của hệ thống công cụ đọc/khảo sát codebase hiện tại (`search_codebase_fast`, `read_file`, `read_compressed_code`, `get_symbol_context_360`, `query_call_graph`) nhằm tăng cường độ chính xác ngữ nghĩa, giảm nhiễu token, hỗ trợ batch symbol và kiểm soát kích thước payload.

---

## Phân chia giai đoạn & Công việc nguyên tử (Atomic Task Breakdown)

### Phase 1: Nâng cấp Tìm kiếm Codebase Hybrid (Lexical + AST Filtering)
- [ ] **Task 1.1:** Khảo sát `src/tools/search-codebase.ts` hoặc module tìm kiếm hiện tại để đánh giá cơ chế BM25 hiện tại.
  - *Target Files:* `src/tools/search-codebase.ts` (hoặc module tương ứng trong `src/tools/`)
  - *Concrete Code Logic:* Thêm bộ lọc ngữ nghĩa (AST symbol type filter) để loại bỏ kết quả nhiễu từ khóa phổ biến.
  - *Verification:* Chạy test suite `npm test` hoặc `npx tsc --noEmit`.
- [ ] **Task 1.2:** Tối ưu hóa điểm số xếp hạng (relevance scoring) cho `search_codebase_fast`.
  - *Target Files:* `src/tools/search-codebase.ts`
  - *Concrete Code Logic:* Ưu tiên kết quả khớp chính xác tên symbol hoặc định nghĩa lớp/hàm.
  - *Verification:* Chạy test suite.

### Phase 2: Mở rộng Hỗ trợ Batch Symbol Lookup (`get_symbol_context_360`)
- [ ] **Task 2.1:** Cập nhật interface `GetSymbolContext360Options` để hỗ trợ mảng `symbols?: string[]` thay vì chỉ 1 symbol đơn lẻ.
  - *Target Files:* `src/tools/codebase-intelligence.ts`
  - *Concrete Code Logic:* Cho phép truy vấn danh sách symbol cùng lúc để gom nhóm ngữ nghĩa.
  - *Verification:* Kiểm tra typecheck `npx tsc --noEmit`.
- [ ] **Task 2.2:** Xử lý gộp payload trả về cho batch symbol lookup mà không làm tràn context window.
  - *Target Files:* `src/tools/codebase-intelligence.ts`
  - *Verification:* Chạy test suite.

### Phase 3: Smart Chunking & Progressive Disclosure cho `read_file`
- [ ] **Task 3.1:** Thêm cơ chế tự động gợi ý dải dòng tiếp theo (`nextStartLine`) khi file vượt quá giới hạn 800 dòng.
  - *Target Files:* `src/tools/read-file.ts` (hoặc module xử lý đọc file tương đương)
  - *Concrete Code Logic:* Thêm metadata phản hồi phân trang (`hasMore: boolean`, `nextStartLine: number`) khi file bị cắt cụt.
  - *Verification:* Chạy unit test đọc file lớn.

### Phase 4: Payload Bounding & Node Pruning cho Call Graph (`query_call_graph`)
- [ ] **Task 4.1:** Thêm giới hạn số lượng node tối đa (`maxNodes: number` mặc định 50) và bộ lọc loại bỏ node lá trùng lặp trong `query_call_graph`.
  - *Target Files:* `src/tools/codebase-intelligence.ts`
  - *Verification:* Chạy kiểm tra biên độ payload và `npm run build`.
