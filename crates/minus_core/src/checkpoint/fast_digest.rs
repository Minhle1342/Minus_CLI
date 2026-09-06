use std::fs::File;
use std::io::Read;
use std::path::Path;
use memmap2::Mmap;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// Tính SHA-256 của file bằng khối buffer 64KB tốc độ cao
pub fn compute_file_sha256_native(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    loop {
        let n = file.read(&mut buffer).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Tính SHA-256 của chuỗi văn bản
pub fn compute_string_sha256_native(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Quét toàn bộ thư mục và tính digest đại diện cho Workspace trong 1 lần gọi (Bulk processing)
/// Tuân thủ quy tắc 2: Không gọi NAPI lặp qua từng file, toàn bộ cây thư mục được duyệt và băm trong Rust.
pub fn scan_and_digest_workspace_native(root_dir: &str, ignored_dirs: &[String]) -> String {
    let root_path = Path::new(root_dir);
    if !root_path.exists() || !root_path.is_dir() {
        return "sha256:invalid_workspace".to_string();
    }

    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.file_type().is_dir() {
                let name = entry.file_name().to_string_lossy();
                if ignored_dirs.iter().any(|ig| ig == &name) {
                    return false;
                }
                if name == ".git"
                    || name == "node_modules"
                    || name == "dist"
                    || name == "target"
                    || name == ".gemini"
                    || name == ".claude"
                {
                    return false;
                }
            }
            true
        });

    let mut entries: Vec<(String, String)> = Vec::new();

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let rel_path = match path.strip_prefix(root_path) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        // Băm file dùng memory map hoặc buffer
        let file_hash = match File::open(path) {
            Ok(file) => {
                let metadata = match file.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let len = metadata.len();
                if len == 0 {
                    // Empty file sha256
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string()
                } else if len > 50 * 1024 * 1024 {
                    // Skip hashing huge files > 50MB
                    format!("len:{}", len)
                } else {
                    match unsafe { Mmap::map(&file) } {
                        Ok(mmap) => {
                            let mut hasher = Sha256::new();
                            hasher.update(&mmap[..]);
                            format!("{:x}", hasher.finalize())
                        }
                        Err(_) => {
                            compute_file_sha256_native(&path.to_string_lossy()).unwrap_or_default()
                        }
                    }
                }
            }
            Err(_) => continue,
        };

        entries.push((rel_path, file_hash));
    }

    // Sắp xếp deterministic theo relative path
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut top_hasher = Sha256::new();
    for (rel_path, file_hash) in entries {
        top_hasher.update(rel_path.as_bytes());
        top_hasher.update(b":");
        top_hasher.update(file_hash.as_bytes());
        top_hasher.update(b"\n");
    }

    format!("sha256:{:x}", top_hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_string_hash() {
        let hash = compute_string_sha256_native("hello world");
        assert_eq!(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    }

    #[test]
    fn test_scan_and_digest_workspace() {
        let temp_dir = std::env::temp_dir().join("minus_core_test_digest");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        fs::write(temp_dir.join("file_a.txt"), "hello file a").unwrap();
        fs::write(temp_dir.join("file_b.txt"), "hello file b").unwrap();

        let sub_dir = temp_dir.join("sub");
        fs::create_dir_all(&sub_dir).unwrap();
        fs::write(sub_dir.join("file_c.txt"), "hello file c").unwrap();

        let digest = scan_and_digest_workspace_native(
            &temp_dir.to_string_lossy(),
            &vec!["node_modules".to_string()],
        );

        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), 71); // "sha256:" (7) + 64 hex chars

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
