use std::fs::File;
use memmap2::Mmap;
use napi_derive::napi;
use regex::RegexBuilder;
use walkdir::WalkDir;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsSearchMatch {
    pub file: String,
    pub line_number: u32,
    pub line_content: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsSearchResult {
    pub matches: Vec<RsSearchMatch>,
    pub total_scanned_files: u32,
    pub duration_ms: i64,
}

/// Tìm kiếm văn bản/regex tốc độ cao trên toàn thư mục bằng Memory-Mapped I/O
pub fn search_codebase_native(
    target_dir: &str,
    query: &str,
    is_regex: bool,
    ignore_case: bool,
    max_matches: u32,
    ignored_dirs: Vec<String>,
) -> RsSearchResult {
    let start_time = std::time::Instant::now();
    let mut matches = Vec::new();
    let mut total_scanned = 0;

    let regex_pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    let re = match RegexBuilder::new(&regex_pattern)
        .case_insensitive(ignore_case)
        .build()
    {
        Ok(r) => r,
        Err(_) => {
            return RsSearchResult {
                matches,
                total_scanned_files: 0,
                duration_ms: start_time.elapsed().as_millis() as i64,
            };
        }
    };

    let walker = WalkDir::new(target_dir).into_iter().filter_entry(|entry| {
        if entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            if ignored_dirs.iter().any(|ig| ig == &name) {
                return false;
            }
            if name == ".git" || name == "node_modules" || name == "dist" || name == "target" {
                return false;
            }
        }
        true
    });

    for entry in walker.filter_map(|e| e.ok()) {
        if matches.len() as u32 >= max_matches {
            break;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        total_scanned += 1;
        let file_path = entry.path();

        // Kiểm tra phần mở rộng binary cơ bản
        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ["png", "jpg", "jpeg", "gif", "exe", "bin", "dll", "zip", "pdf", "node"].contains(&ext_str.as_str()) {
                continue;
            }
        }

        if let Ok(file) = File::open(file_path) {
            // Sử dụng memory-mapped file nếu kích thước > 0
            if let Ok(mmap) = unsafe { Mmap::map(&file) } {
                if let Ok(content_str) = std::str::from_utf8(&mmap) {
                    for (idx, line) in content_str.lines().enumerate() {
                        if re.is_match(line) {
                            matches.push(RsSearchMatch {
                                file: file_path.to_string_lossy().to_string().replace('\\', "/"),
                                line_number: (idx + 1) as u32,
                                line_content: line.trim_end().to_string(),
                            });
                            if matches.len() as u32 >= max_matches {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    RsSearchResult {
        matches,
        total_scanned_files: total_scanned,
        duration_ms: start_time.elapsed().as_millis() as i64,
    }
}
