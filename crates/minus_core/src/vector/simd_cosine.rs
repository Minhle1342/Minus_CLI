pub const VECTOR_DIMENSIONS: usize = 384;

/// Tính toán Cosine Similarity giữa 2 vector f64 được tối ưu hóa theo chunks
pub fn cosine_similarity_simd(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;

    // Duyệt theo 4 phần tử mỗi bước để tận dụng unrolling và auto-vectorization
    let chunks_a = a.chunks_exact(4);
    let chunks_b = b.chunks_exact(4);
    let rem_a = chunks_a.remainder();
    let rem_b = chunks_b.remainder();

    for (ca, cb) in chunks_a.zip(chunks_b) {
        dot += ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2] + ca[3] * cb[3];
        norm_a += ca[0] * ca[0] + ca[1] * ca[1] + ca[2] * ca[2] + ca[3] * ca[3];
        norm_b += cb[0] * cb[0] + cb[1] * cb[1] + cb[2] * cb[2] + cb[3] * cb[3];
    }

    for (va, vb) in rem_a.iter().zip(rem_b.iter()) {
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a.sqrt() * norm_b.sqrt())
}

fn fnv1a_32(s: &str) -> i32 {
    let mut h: u32 = 2166136261;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h as i32
}

use std::sync::OnceLock;

static WORD_REGEX: OnceLock<regex::Regex> = OnceLock::new();

/// Vectorizer cục bộ offline 384 chiều siêu tốc độ cao trong Rust
/// Áp dụng thuật toán FNV-1a Signed Projection khớp 100% với VectorMemoryStore
pub fn generate_subword_embedding_native(text: &str) -> Vec<f64> {
    let dims = VECTOR_DIMENSIONS;
    let mut vec = vec![0.0f64; dims];
    let normalized = text.trim().to_lowercase();
    if normalized.is_empty() {
        return vec;
    }

    let re = WORD_REGEX.get_or_init(|| {
        regex::Regex::new(r"[^a-z0-9_#$@\.\-]+").unwrap()
    });

    for word in re.split(&normalized) {
        if word.is_empty() {
            continue;
        }

        // 1. Băm toàn từ (Full Word Hash)
        let word_hash = fnv1a_32(word);
        let idx1 = (word_hash.abs() as usize) % dims;
        let sign1 = if word_hash % 2 == 0 { 1.0 } else { -1.0 };
        vec[idx1] += 2.0 * sign1;

        // 2. Character N-Grams (Tri-grams & 4-grams cho Subword Similarity)
        let bytes = word.as_bytes();
        let char_len = bytes.len();

        if char_len >= 3 {
            for i in 0..=char_len - 3 {
                if let Ok(tri) = std::str::from_utf8(&bytes[i..i + 3]) {
                    let tri_hash = fnv1a_32(tri);
                    let idx2 = (tri_hash.abs() as usize) % dims;
                    let sign2 = if tri_hash % 2 == 0 { 0.5 } else { -0.5 };
                    vec[idx2] += sign2;
                }
            }
        }

        if char_len >= 4 {
            for i in 0..=char_len - 4 {
                if let Ok(quad) = std::str::from_utf8(&bytes[i..i + 4]) {
                    let quad_hash = fnv1a_32(quad);
                    let idx3 = (quad_hash.abs() as usize) % dims;
                    let sign3 = if quad_hash % 2 == 0 { 0.75 } else { -0.75 };
                    vec[idx3] += sign3;
                }
            }
        }
    }

    // Chuẩn hoá độ dài L2 để chuẩn bị cho Cosine Dot-Product
    let norm: f64 = vec.iter().map(|v| v * v).sum::<f64>().sqrt();
    if norm > 0.0 {
        for v in vec.iter_mut() {
            *v /= norm;
        }
    }

    vec
}

/// Tính toán Cosine Similarity hàng loạt (Batch SIMD) giữa 1 query vector và N vectors phẳng
pub fn batch_cosine_similarity_simd(query: &[f64], database: &[f64], dims: usize) -> Vec<f64> {
    if query.len() != dims || dims == 0 || database.len() % dims != 0 {
        return Vec::new();
    }
    let count = database.len() / dims;
    let mut scores = Vec::with_capacity(count);

    for chunk in database.chunks_exact(dims) {
        scores.push(cosine_similarity_simd(query, chunk));
    }
    scores
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identical_vector_similarity() {
        let v1 = generate_subword_embedding_native("authentication token bearer");
        let v2 = generate_subword_embedding_native("authentication token bearer");
        let sim = cosine_similarity_simd(&v1, &v2);
        assert!((sim - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_relevant_similarity() {
        let v1 = generate_subword_embedding_native("Always use replace_text for precise surgical edits");
        let v2 = generate_subword_embedding_native("surgical text edit tool");
        let v3 = generate_subword_embedding_native("Run test verification suite before concluding tasks");

        let sim12 = cosine_similarity_simd(&v1, &v2);
        let sim32 = cosine_similarity_simd(&v3, &v2);

        assert!(sim12 > sim32);
    }
}
