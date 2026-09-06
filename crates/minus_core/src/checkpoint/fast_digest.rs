use std::fs::File;
use std::io::Read;
use std::path::Path;
use sha2::{Digest, Sha256};

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_string_hash() {
        let hash = compute_string_sha256_native("hello world");
        assert_eq!(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    }
}
