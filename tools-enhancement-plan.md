# Tools Enhancement Plan

## Goal
Tích hợp các thư viện tiện ích vừa cài đặt (`fast-glob`, `json5`, `diff`, `ts-morph`) vào các tool cốt lõi trong `src/tools/` nhằm mở rộng khả năng tìm kiếm, xử lý file cấu hình, sinh diff trực quan và phân tích AST chính xác.

## Tasks
- [x] Task 1: Nâng cấp `list-files.ts` với `fast-glob` → Bổ sung tham số `pattern` (glob) vào schema `list_files` để hỗ trợ quét tệp tin đệ quy theo biểu thức glob.  
  → **Verify**: Chạy script tsx kiểm tra `listFilesTool.execute({ path: ".", pattern: "src/**/*.ts" })` trả về đúng danh sách file TypeScript.

- [x] Task 2: Nâng cấp `typescript-service.ts` với `json5` → Thay thế cơ chế đọc thô `tsconfig.json` bằng `json5.parse()` để tránh lỗi `SyntaxError` khi file cấu hình có comment (`//`) hoặc trailing comma.  
  → **Verify**: Khởi tạo `TypeScriptService` với `tsconfig.json` giả lập chứa comment và kiểm tra options được nạp thành công.

- [x] Task 3: Nâng cấp `replace-text.ts` với `diff` → Bổ sung trường `unifiedDiff` vào kết quả thành công của `replace_text` bằng `diff.createPatch()` giúp LLM và reviewer theo dõi chính xác thay đổi.  
  → **Verify**: Thực thi `replaceTextTool.execute(...)` trên file test và kiểm tra `result.unifiedDiff` có định dạng patch chuẩn (`---`, `+++`, `@@`).

- [x] Task 4: Nâng cấp `mutation-blast-radius.ts` với `ts-morph` → Sử dụng `ts-morph` để tăng cường độ chính xác khi truy vấn cross-file references và callers của exported symbols.  
  → **Verify**: Gọi `calculateComprehensiveBlastRadius` trên một file chứa exported function và xác nhận danh sách `callers` được nhận diện đầy đủ.

- [x] Task 5: Kiểm thử hồi quy toàn bộ hệ thống tools (Regression Verification) → Chạy các test suite hiện hữu để đảm bảo tính tương thích ngược và ổn định.  
  → **Verify**: Chạy `npm run test:native-io` và các unit tests trong `src/tools/` với kết quả exit code 0.

## Done When
- [x] Cả 4 tools (`list_files`, `replace_text`, `typescript-service`, `mutation-blast-radius`) đều tận dụng tối ưu thư viện tương ứng.
- [x] Không có lỗi runtime hoặc TypeScript compilation errors (`npm run build` thành công).
- [x] Tất cả các bài kiểm thử liên quan vượt qua trọn vẹn.

## Notes
- Giữ nguyên tính tương thích ngược cho các tham số cũ của các tools (như `dirPath`, `path` trong `list_files`).
- Giới hạn kích thước `unifiedDiff` trong `replace_text` để tránh làm tràn context window khi thay thế block lớn.
