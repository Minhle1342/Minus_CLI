use std::fs::File;
use std::path::Path;
use memmap2::Mmap;
use napi_derive::napi;
use sha2::{Digest, Sha256};
use crate::security::resolve_safe_path_internal;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsBatchFileReadResult {
    pub rel_path: String,
    pub content: Option<String>,
    pub hash: Option<String>,
    pub total_lines: u32,
    pub size_bytes: u32,
    pub error: Option<String>,
}

/// Đọc hàng loạt file trong workspace cùng lúc bằng Memory-Mapped I/O và kiểm tra Path Guard
/// Tuân thủ quy tắc 2: Không gọi NAPI lặp qua từng file; toàn bộ danh sách file được đọc,
/// băm SHA-256 và đếm số dòng trong duy nhất 1 lần vượt ranh giới NAPI.
pub fn batch_read_files_native(
    root_dir: &str,
    rel_paths: &[String],
    max_bytes_per_file: usize,
) -> Vec<RsBatchFileReadResult> {
    let mut results = Vec::with_capacity(rel_paths.len());

    for rel_path in rel_paths {
        let trimmed = rel_path.trim();
        if trimmed.is_empty() {
            results.push(RsBatchFileReadResult {
                rel_path: rel_path.clone(),
                content: None,
                hash: None,
                total_lines: 0,
                size_bytes: 0,
                error: Some("Path cannot be empty.".to_string()),
            });
            continue;
        }

        let safe_full_path = match resolve_safe_path_internal(root_dir, trimmed) {
            Ok(p) => p,
            Err(e) => {
                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: None,
                    hash: None,
                    total_lines: 0,
                    size_bytes: 0,
                    error: Some(format!("Security path resolution failed: {}", e)),
                });
                continue;
            }
        };

        let path_obj = Path::new(&safe_full_path);
        let file = match File::open(path_obj) {
            Ok(f) => f,
            Err(e) => {
                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: None,
                    hash: None,
                    total_lines: 0,
                    size_bytes: 0,
                    error: Some(format!("Failed to open file: {}", e)),
                });
                continue;
            }
        };

        let metadata = match file.metadata() {
            Ok(m) => m,
            Err(e) => {
                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: None,
                    hash: None,
                    total_lines: 0,
                    size_bytes: 0,
                    error: Some(format!("Failed to read file metadata: {}", e)),
                });
                continue;
            }
        };

        if !metadata.is_file() {
            results.push(RsBatchFileReadResult {
                rel_path: rel_path.clone(),
                content: None,
                hash: None,
                total_lines: 0,
                size_bytes: 0,
                error: Some("Path is not a regular file.".to_string()),
            });
            continue;
        }

        let size = metadata.len() as usize;
        if size > max_bytes_per_file {
            results.push(RsBatchFileReadResult {
                rel_path: rel_path.clone(),
                content: None,
                hash: None,
                total_lines: 0,
                size_bytes: size as u32,
                error: Some(format!("File too large ({} bytes exceeds limit {} bytes).", size, max_bytes_per_file)),
            });
            continue;
        }

        if size == 0 {
            results.push(RsBatchFileReadResult {
                rel_path: rel_path.clone(),
                content: Some(String::new()),
                hash: Some("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string()),
                total_lines: 0,
                size_bytes: 0,
                error: None,
            });
            continue;
        }

        let mmap = match unsafe { Mmap::map(&file) } {
            Ok(m) => m,
            Err(e) => {
                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: None,
                    hash: None,
                    total_lines: 0,
                    size_bytes: size as u32,
                    error: Some(format!("Memory map error: {}", e)),
                });
                continue;
            }
        };

        match std::str::from_utf8(&mmap[..]) {
            Ok(utf8_str) => {
                let mut hasher = Sha256::new();
                hasher.update(&mmap[..]);
                let hash = format!("sha256:{:x}", hasher.finalize());

                // Đếm dòng nhanh bằng byte scanning '\n'
                let line_count = mmap.iter().filter(|&&b| b == b'\n').count() + 1;

                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: Some(utf8_str.to_string()),
                    hash: Some(hash),
                    total_lines: line_count as u32,
                    size_bytes: size as u32,
                    error: None,
                });
            }
            Err(_) => {
                results.push(RsBatchFileReadResult {
                    rel_path: rel_path.clone(),
                    content: None,
                    hash: None,
                    total_lines: 0,
                    size_bytes: size as u32,
                    error: Some("Binary or non-UTF8 content.".to_string()),
                });
            }
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_batch_read_files() {
        let temp_dir = std::env::temp_dir().join("minus_core_test_batch_read");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let file_a = temp_dir.join("a.txt");
        let file_b = temp_dir.join("b.txt");
        fs::write(&file_a, "line1\nline2\nline3\n").unwrap();
        fs::write(&file_b, "hello world").unwrap();

        let paths = vec!["a.txt".to_string(), "b.txt".to_string(), "nonexistent.txt".to_string()];
        let results = batch_read_files_native(&temp_dir.to_string_lossy(), &paths, 1024 * 1024);

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].rel_path, "a.txt");
        assert_eq!(results[0].content.as_deref(), Some("line1\nline2\nline3\n"));
        assert_eq!(results[0].total_lines, 4);
        assert!(results[0].hash.is_some());
        assert!(results[0].error.is_none());

        assert_eq!(results[1].rel_path, "b.txt");
        assert_eq!(results[1].content.as_deref(), Some("hello world"));
        assert_eq!(results[1].total_lines, 1);
        assert!(results[1].error.is_none());

        assert_eq!(results[2].rel_path, "nonexistent.txt");
        assert!(results[2].error.is_some());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
