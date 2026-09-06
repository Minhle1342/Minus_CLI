use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsHistoryStats {
    pub total_chars: u32,
    pub total_bytes: u32,
    pub estimated_tokens: u32,
}

/// Tính toán thống kê ký tự và ước lượng token của toàn bộ session trong 1 lần gọi (Bulk Analysis)
/// Tuân thủ quy tắc 2: Truyền danh sách payload text hoặc json chunks và đếm trong Rust,
/// tránh việc JavaScript phải cấp phát chuỗi khổng lồ ' '.repeat(...) hoặc tính toán lặp.
pub fn compute_history_stats_native(payload_chunks: &[String]) -> RsHistoryStats {
    let mut total_chars: usize = 0;
    let mut total_bytes: usize = 0;

    for chunk in payload_chunks {
        total_bytes += chunk.len();
        total_chars += chunk.chars().count();
    }

    // Heuristic: 1 token ~ 3.8 chars
    let estimated_tokens = ((total_chars as f64) / 3.8).ceil() as u32;

    RsHistoryStats {
        total_chars: total_chars as u32,
        total_bytes: total_bytes as u32,
        estimated_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_history_stats() {
        let chunks = vec![
            "Hello world".to_string(),
            "This is a test message with some content".to_string(),
        ];
        let stats = compute_history_stats_native(&chunks);
        assert_eq!(stats.total_chars, 51);
        assert_eq!(stats.total_bytes, 51);
        assert_eq!(stats.estimated_tokens, 14); // 51 / 3.8 = 13.42 -> ceil = 14
    }
}
