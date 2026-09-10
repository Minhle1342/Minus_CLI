# Findings: Phân tích Điểm yếu & Giải pháp Cải tiến Codebase Intelligence Tools

## 1. Các điểm yếu đã nhận diện qua khảo sát
- **`search_codebase_fast`:** Dựa hoàn toàn trên từ khóa (BM25/lexical), dễ bị nhiễu bởi các từ phổ biến và thiếu độ nhạy ngữ nghĩa AST.
- **`get_symbol_context_360`:** Giới hạn xử lý đơn symbol mỗi lần gọi, thiếu khả năng phân tích hàng loạt (batch).
- **`read_file`:** Giới hạn 800 dòng/lần nhưng chưa có cơ chế phản hồi phân trang tự động (`nextStartLine`, `hasMore`).
- **`query_call_graph`:** Thiếu giới hạn số lượng node tối đa (`maxNodes`), dễ gây bùng nổ payload token khi đồ thị gọi quá sâu.
- **`read_compressed_code`:** Lược bỏ toàn bộ thân hàm (bodyless) qua Tree-sitter, hữu ích cho cấu trúc nhưng gây khó khăn khi cần tra cứu chi tiết logic thực thi.

## 2. Quyết định kiến trúc & Hướng khắc phục
- Áp dụng phương pháp tiếp cận tiến hóa (evolutionary, backward-compatible): Không phá vỡ API hiện có, bổ sung các tùy chọn mở rộng (như `symbols?: string[]`, `maxNodes?: number`, phân trang `nextStartLine`).
- Duy trì nguyên tắc bảo vệ test hiện có (Strict Anti-Tampering).
