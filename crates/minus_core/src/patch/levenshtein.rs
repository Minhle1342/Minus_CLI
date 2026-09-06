/// Tính toán khoảng cách Levenshtein nhanh và tối ưu bộ nhớ O(min(M, N))
pub fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let v1: Vec<char> = s1.chars().collect();
    let v2: Vec<char> = s2.chars().collect();

    let len1 = v1.len();
    let len2 = v2.len();

    if len1 == 0 { return len2; }
    if len2 == 0 { return len1; }

    let mut prev_row: Vec<usize> = (0..=len2).collect();
    let mut curr_row: Vec<usize> = vec![0; len2 + 1];

    for i in 0..len1 {
        curr_row[0] = i + 1;
        for j in 0..len2 {
            let cost = if v1[i] == v2[j] { 0 } else { 1 };
            curr_row[j + 1] = std::cmp::min(
                curr_row[j] + 1, // Chèn
                std::cmp::min(
                    prev_row[j + 1] + 1, // Xóa
                    prev_row[j] + cost,  // Thay thế
                ),
            );
        }
        prev_row.copy_from_slice(&curr_row);
    }

    prev_row[len2]
}

/// Tính toán độ tương đồng chuỗi từ 0.0 đến 1.0 (Similarity Ratio)
pub fn string_similarity(s1: &str, s2: &str) -> f64 {
    let len1 = s1.chars().count();
    let len2 = s2.chars().count();
    let max_len = std::cmp::max(len1, len2);
    if max_len == 0 { return 1.0; }

    let dist = levenshtein_distance(s1, s2);
    1.0 - (dist as f64 / max_len as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_levenshtein_identical() {
        assert_eq!(levenshtein_distance("hello world", "hello world"), 0);
        assert_eq!(string_similarity("hello world", "hello world"), 1.0);
    }

    #[test]
    fn test_levenshtein_close() {
        assert_eq!(levenshtein_distance("const a = 1;", "const a = 2;"), 1);
        assert!(string_similarity("const a = 1;", "const a = 2;") > 0.9);
    }
}
