use napi_derive::napi;
use regex::Regex;
use std::sync::OnceLock;

static ERROR_PATTERN: OnceLock<Regex> = OnceLock::new();

fn get_error_regex() -> &'static Regex {
    ERROR_PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(error:|exception:|failed|failure|panic|assert|traceback|syntaxerror|typeerror|referenceerror|fatal)").unwrap()
    })
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsTruncateResult {
    pub text: String,
    pub original_bytes: u32,
    pub truncated_bytes: u32,
    pub was_truncated: bool,
    pub lines_retained: u32,
}

/// Cắt ngắn thông minh output của command/tool trong Rust:
/// - Giữ lại phần đầu (Head) và phần cuối (Tail)
/// - Trích xuất các dòng chứa lỗi nếu có
/// - Cực kỳ tiết kiệm RAM do thao tác trực tiếp trên UTF-8 slices
pub fn truncate_tool_output_native(
    content: &str,
    max_lines: u32,
    max_bytes: u32,
    preserve_head_tail: bool,
) -> RsTruncateResult {
    let original_bytes = content.len() as u32;
    let max_b = max_bytes as usize;
    let max_l = max_lines as usize;

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();

    // Nếu kích thước đã nằm trong giới hạn, không cần cắt
    if original_bytes <= max_bytes && total_lines <= max_l {
        return RsTruncateResult {
            text: content.to_string(),
            original_bytes,
            truncated_bytes: original_bytes,
            was_truncated: false,
            lines_retained: total_lines as u32,
        };
    }

    if !preserve_head_tail || total_lines <= 10 {
        // Cắt đơn giản theo byte slice UTF-8 hợp lệ
        let mut end_idx = max_b.min(content.len());
        while !content.is_char_boundary(end_idx) && end_idx > 0 {
            end_idx -= 1;
        }
        let truncated = &content[..end_idx];
        let message = format!(
            "{}\n\n[... Đã cắt bớt {} bytes bởi minus_core ...]",
            truncated,
            original_bytes.saturating_sub(end_idx as u32)
        );
        let retained_lines = message.lines().count() as u32;
        let final_len = message.len() as u32;
        return RsTruncateResult {
            text: message,
            original_bytes,
            truncated_bytes: final_len,
            was_truncated: true,
            lines_retained: retained_lines,
        };
    }

    // Giữ phần đầu và phần cuối (Head & Tail retention)
    let head_line_count = (max_l / 2).max(5).min(total_lines);
    let tail_line_count = (max_l / 2).max(5).min(total_lines.saturating_sub(head_line_count));

    let head_lines = &lines[..head_line_count];
    let tail_lines = &lines[total_lines.saturating_sub(tail_line_count)..];

    // Quét tìm các dòng lỗi ở phần giữa bị cắt
    let middle_lines = &lines[head_line_count..total_lines.saturating_sub(tail_line_count)];
    let err_re = get_error_regex();
    let mut extracted_errors: Vec<&str> = Vec::new();

    for line in middle_lines {
        if err_re.is_match(line) {
            extracted_errors.push(line);
            if extracted_errors.len() >= 15 {
                break;
            }
        }
    }

    let mut result = String::with_capacity(max_b.min(original_bytes as usize) + 512);

    for line in head_lines {
        result.push_str(line);
        result.push('\n');
    }

    let omitted_lines = total_lines.saturating_sub(head_line_count + tail_line_count);
    result.push_str(&format!(
        "\n--- [... Cắt bớt {} dòng output (~{} bytes) ...",
        omitted_lines,
        original_bytes.saturating_sub(result.len() as u32)
    ));

    if !extracted_errors.is_empty() {
        result.push_str(" | Trích xuất dấu vết lỗi phát hiện được:\n");
        for err_line in &extracted_errors {
            result.push_str("  > ");
            result.push_str(err_line);
            result.push('\n');
        }
        result.push_str("---]\n\n");
    } else {
        result.push_str(" ---]\n\n");
    }

    for line in tail_lines {
        result.push_str(line);
        result.push('\n');
    }

    // Nếu chuỗi kết quả vẫn quá giới hạn byte, cắt bớt an toàn
    if result.len() > max_b {
        let mut end_idx = max_b;
        while !result.is_char_boundary(end_idx) && end_idx > 0 {
            end_idx -= 1;
        }
        result.truncate(end_idx);
        result.push_str("\n[... Giới hạn dung lượng tối đa đạt ngưỡng ...]");
    }

    let final_bytes = result.len() as u32;
    let retained_lines = result.lines().count() as u32;

    RsTruncateResult {
        text: result,
        original_bytes,
        truncated_bytes: final_bytes,
        was_truncated: true,
        lines_retained: retained_lines,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_within_limit() {
        let text = "Line 1\nLine 2\nLine 3";
        let res = truncate_tool_output_native(text, 10, 1000, true);
        assert!(!res.was_truncated);
        assert_eq!(res.text, text);
    }

    #[test]
    fn test_truncate_with_errors_extracted() {
        let mut text = String::new();
        for i in 1..=50 {
            if i == 25 {
                text.push_str("Error: Failed to bind port 8080\n");
            } else if i == 30 {
                text.push_str("Panic: thread panicked at assertion failed\n");
            } else {
                text.push_str(&format!("Log line {}\n", i));
            }
        }

        let res = truncate_tool_output_native(&text, 10, 5000, true);
        assert!(res.was_truncated);
        assert!(res.text.contains("Error: Failed to bind port 8080"));
        assert!(res.text.contains("Panic: thread panicked"));
        assert!(res.text.contains("Log line 1"));
        assert!(res.text.contains("Log line 50"));
    }
}
