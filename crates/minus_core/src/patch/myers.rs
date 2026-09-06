use napi_derive::napi;
use super::levenshtein::string_similarity;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsHunkApplyResult {
    pub success: bool,
    pub matched_line_index: Option<u32>,
    pub fuzz_level_used: u32,
    pub error: Option<String>,
    pub new_content: Option<String>,
}

/// Áp dụng danh sách các dòng hunk vào chuỗi nội dung gốc với 4 cấp Fuzz Matching
pub fn apply_hunk_to_content(
    original_content: &str,
    hunk_lines: &[String],
    _expected_old_start: usize,
) -> RsHunkApplyResult {
    let mut file_lines: Vec<String> = original_content.lines().map(|s| s.to_string()).collect();
    if original_content.ends_with('\n') || original_content.ends_with("\r\n") {
        // file có trailing newline
    }

    let mut context_lines: Vec<String> = Vec::new();
    let mut replacement_lines: Vec<String> = Vec::new();

    for line in hunk_lines {
        if line.starts_with('+') {
            replacement_lines.push(line[1..].to_string());
        } else if line.starts_with('-') {
            context_lines.push(line[1..].to_string());
        } else if line.starts_with(' ') {
            let pure = if line.len() > 1 { line[1..].to_string() } else { String::new() };
            context_lines.push(pure.clone());
            replacement_lines.push(pure);
        } else {
            context_lines.push(line.clone());
            replacement_lines.push(line.clone());
        }
    }

    if context_lines.is_empty() {
        return RsHunkApplyResult {
            success: false,
            matched_line_index: None,
            fuzz_level_used: 0,
            error: Some("Hunk contains no context or deletion lines.".to_string()),
            new_content: None,
        };
    }

    let target_len = context_lines.len();
    let total_file_lines = file_lines.len();

    // 1. Cấp độ Fuzz 0: Khớp chính xác dòng (Exact match)
    for offset in 0..=total_file_lines.saturating_sub(target_len) {
        let mut matched = true;
        for j in 0..target_len {
            if file_lines[offset + j] != context_lines[j] {
                matched = false;
                break;
            }
        }
        if matched {
            file_lines.splice(offset..offset + target_len, replacement_lines);
            return RsHunkApplyResult {
                success: true,
                matched_line_index: Some(offset as u32),
                fuzz_level_used: 0,
                error: None,
                new_content: Some(file_lines.join("\n")),
            };
        }
    }

    // 2. Cấp độ Fuzz 1: Bỏ qua khoảng trắng đầu dòng và cuối dòng (Trim tolerance)
    for offset in 0..=total_file_lines.saturating_sub(target_len) {
        let mut matched = true;
        for j in 0..target_len {
            if file_lines[offset + j].trim() != context_lines[j].trim() {
                matched = false;
                break;
            }
        }
        if matched {
            file_lines.splice(offset..offset + target_len, replacement_lines);
            return RsHunkApplyResult {
                success: true,
                matched_line_index: Some(offset as u32),
                fuzz_level_used: 1,
                error: None,
                new_content: Some(file_lines.join("\n")),
            };
        }
    }

    // 3. Cấp độ Fuzz 3: Fuzzy Levenshtein matching (Similarity >= 0.8)
    for offset in 0..=total_file_lines.saturating_sub(target_len) {
        let mut sum_sim = 0.0;
        for j in 0..target_len {
            sum_sim += string_similarity(file_lines[offset + j].trim(), context_lines[j].trim());
        }
        let avg_sim = sum_sim / (target_len as f64);
        if avg_sim >= 0.80 {
            file_lines.splice(offset..offset + target_len, replacement_lines);
            return RsHunkApplyResult {
                success: true,
                matched_line_index: Some(offset as u32),
                fuzz_level_used: 3,
                error: None,
                new_content: Some(file_lines.join("\n")),
            };
        }
    }

    RsHunkApplyResult {
        success: false,
        matched_line_index: None,
        fuzz_level_used: 0,
        error: Some("Failed to match hunk context lines against target file.".to_string()),
        new_content: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_hunk_exact() {
        let orig = "fn main() {\n    println!(\"old\");\n}";
        let hunk = vec![
            " fn main() {".to_string(),
            "-    println!(\"old\");".to_string(),
            "+    println!(\"new\");".to_string(),
            " }".to_string(),
        ];

        let res = apply_hunk_to_content(orig, &hunk, 1);
        assert!(res.success);
        assert_eq!(res.fuzz_level_used, 0);
        assert!(res.new_content.unwrap().contains("println!(\"new\")"));
    }
}
