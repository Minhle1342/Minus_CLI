# OpenCode LSP Hybrid Integration Plan

## Mục tiêu

Kết hợp phản hồi semantic nhanh đang có của `TypeScriptService` với các điểm mạnh của runtime LSP trong OpenCode: đa ngôn ngữ, chọn server theo extension/project root, tiến trình dùng lại lâu dài, đồng bộ phiên bản tài liệu, truy vấn semantic theo vị trí và phản hồi diagnostics ngay sau mutation.

## Bằng chứng từ OpenCode chính thức

- Tài liệu LSP mô tả luồng chọn server theo phần mở rộng, lazy-start, cấu hình server tùy chỉnh, environment và initialization options: <https://opencode.ai/docs/lsp/>
- Runtime chính thức giữ registry server, tìm root, chống spawn trùng, dùng lại client theo server/root và đóng client khi kết thúc: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/lsp/lsp.ts>
- Client dùng JSON-RPC qua stdio, đồng bộ `didOpen`/`didChange`, nhận push diagnostics, thử pull diagnostics và chờ bounded timeout: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/lsp/client.ts>
- Tool LSP cung cấp definition, references, hover, document/workspace symbols, implementation và call hierarchy: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/lsp.ts>
- Sau edit, OpenCode chờ diagnostics rồi đưa lỗi trở lại tool result: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts>

Lưu ý: trang tài liệu V2 hiện nói runtime V2 chưa hoạt động. Kế hoạch này dựa trên runtime nhánh `dev` đang được phát triển, không giả định tính năng V2 đã phát hành đầy đủ.

## Đối chiếu hệ thống hiện tại

| Khả năng | Hiện tại | OpenCode dev | Thiết kế tích hợp |
| --- | --- | --- | --- |
| TypeScript diagnostics | In-memory, nhanh | Qua external server | Giữ nguyên làm fallback/đường nhanh |
| Đa ngôn ngữ | Không | Registry nhiều server | Registry cấu hình `.minus/lsp.json` |
| Chọn project root | Một workspace | Extension + root marker | Extension bắt buộc + nearest root marker |
| Lifecycle | Một TS service dùng chung | Lazy spawn/reuse/shutdown | Client key chuẩn hóa `serverId + root`, chống spawn trùng, cooldown lỗi |
| Đồng bộ file | Đọc lại theo request | `didOpen`/`didChange` | Phiên bản tài liệu tăng đơn điệu, `didClose` khi xóa |
| Semantic operations | Symbol-name based cho TS | Position-based, rộng | Tool `lsp_query` với 9 operations |
| Feedback sau edit | Agent được gợi ý gọi diagnostics | Diagnostics gắn vào edit result | ToolRunner enrichment có timeout và giới hạn context |
| Cài server | Không | Có thể tự tải | Không auto-download; custom executable cần explicit trust |

## Kiến trúc

1. `src/lsp/config.ts`: đọc/validate `.minus/lsp.json`; extension không được rỗng để tránh server wildcard; server custom chỉ chạy khi executable thuộc allowlist hoặc `trust: true` cùng `MINUS_LSP_TRUST_CUSTOM=1`.
2. `src/lsp/json-rpc-connection.ts`: JSON-RPC 2.0 framing `Content-Length`, request timeout, notification handlers, reject pending requests khi process đóng.
3. `src/lsp/lsp-client.ts`: initialize/shutdown, document sync, push/pull diagnostics và các request semantic.
4. `src/lsp/lsp-manager.ts`: chọn server/root, lazy spawn, reuse, spawn deduplication, broken-server cooldown, diagnostics cache được lọc trong workspace.
5. `src/tools/lsp-query.ts`: một tool position-based cho hover/definition/references/symbols/implementation/call hierarchy/status.
6. `get_diagnostics`: hợp nhất diagnostics external LSP với TypeScript in-memory, loại trùng và giới hạn output.
7. `ToolRunner`: sau mutation thành công, đồng bộ các file bị tác động và gắn tối đa 20 diagnostics liên quan vào kết quả; khi không cấu hình server thì chi phí gần như bằng không.

## Ràng buộc an toàn và độ tin cậy

- Không dùng shell, không tải hay cài binary tự động.
- Không chạy command tùy ý từ repository mặc định.
- Mọi đường dẫn tài liệu và diagnostics phải nằm trong workspace.
- Timeout initialization/request/diagnostics; lỗi LSP không làm mutation thất bại.
- Không trả toàn bộ workspace diagnostics vào context; chỉ file vừa chạm và có giới hạn.
- Chuẩn hóa path/case trên Windows để tránh client trùng hoặc chọn nhầm.

## Tiêu chí nghiệm thu

- Build TypeScript sạch.
- Config hợp lệ được load; config extension rỗng/command nguy hiểm bị từ chối.
- Fake stdio LSP chứng minh initialize, didOpen/didChange, diagnostics và semantic request.
- `lsp_query` được đăng ký và giữ schema ổn định.
- `get_diagnostics` vẫn hoạt động khi không có external server.
- Mutation enrichment fail-open, bounded và không làm thay đổi permission pipeline.
- GitNexus không phát hiện import cycle mới; diff impact được rà soát.

