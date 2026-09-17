use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
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

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsSearchOptions {
    pub max_matches: u32,
    pub max_files: u32,
    pub max_total_bytes: f64,
    pub max_line_bytes: u32,
    pub ignore_case: bool,
    pub is_regex: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsSearchMetadata {
    pub cancelled: bool,
    pub truncated: bool,
    pub error: Option<String>,
    pub scanned_files: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsBoundedSearchResult {
    pub matches: Vec<RsSearchMatch>,
    pub total_scanned_files: u32,
    pub duration_ms: i64,
    pub metadata: Option<RsSearchMetadata>,
}

pub(crate) const SEARCH_MAX_MATCHES_CAP: u32 = 100_000;
pub(crate) const SEARCH_MAX_FILES_CAP: u32 = 200_000;
pub(crate) const SEARCH_MAX_TOTAL_BYTES_CAP: u64 = 1 << 30;
pub(crate) const SEARCH_MAX_LINE_BYTES_CAP: u32 = 1 << 20;

fn clamp_to_cap_u32(value: u32, cap: u32) -> u32 {
    if value > cap {
        cap
    } else {
        value
    }
}

fn default_when_zero(value: u32, cap: u32) -> u32 {
    if value == 0 {
        cap
    } else {
        clamp_to_cap_u32(value, cap)
    }
}

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

        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ["png", "jpg", "jpeg", "gif", "exe", "bin", "dll", "zip", "pdf", "node"].contains(&ext_str.as_str()) {
                continue;
            }
        }

        if let Ok(file) = File::open(file_path) {
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

pub fn search_codebase_native_bounded(
    target_dir: &str,
    query: &str,
    options: &RsSearchOptions,
    ignored_dirs: Vec<String>,
    cancel: Option<&AtomicBool>,
) -> RsBoundedSearchResult {
    let start_time = std::time::Instant::now();
    let max_matches = default_when_zero(options.max_matches, SEARCH_MAX_MATCHES_CAP);
    let max_files = default_when_zero(options.max_files, SEARCH_MAX_FILES_CAP);
    let max_total_bytes = if !options.max_total_bytes.is_finite() || options.max_total_bytes <= 0.0 {
        SEARCH_MAX_TOTAL_BYTES_CAP
    } else {
        options.max_total_bytes.min(SEARCH_MAX_TOTAL_BYTES_CAP as f64) as u64
    };
    let max_line_bytes = default_when_zero(options.max_line_bytes, SEARCH_MAX_LINE_BYTES_CAP) as usize;

    let mut matches: Vec<RsSearchMatch> = Vec::new();
    let mut total_scanned: u32 = 0;
    let mut truncated = false;
    let error: Option<String> = None;

    let regex_pattern = if options.is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    let re = match RegexBuilder::new(&regex_pattern)
        .case_insensitive(options.ignore_case)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return RsBoundedSearchResult {
                matches,
                total_scanned_files: 0,
                duration_ms: start_time.elapsed().as_millis() as i64,
                metadata: Some(RsSearchMetadata {
                    cancelled: false,
                    truncated: false,
                    error: Some(format!("Invalid regex: {}", e)),
                    scanned_files: 0,
                }),
            };
        }
    };

    let is_cancelled = || cancel.map_or(false, |c| c.load(Ordering::Relaxed));

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

    let mut bytes_scanned: u64 = 0;

    for entry in walker.filter_map(|e| e.ok()) {
        if is_cancelled() {
            truncated = true;
            break;
        }

        if matches.len() >= max_matches as usize || total_scanned >= max_files {
            truncated = true;
            break;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let file_path = entry.path();

        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ["png", "jpg", "jpeg", "gif", "exe", "bin", "dll", "zip", "pdf", "node"].contains(&ext_str.as_str()) {
                continue;
            }
        }

        let file = match File::open(file_path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let remaining_budget = max_total_bytes.saturating_sub(bytes_scanned);
        if remaining_budget == 0 {
            truncated = true;
            break;
        }

        total_scanned += 1;

        let input_truncated = would_exceed(file_len, remaining_budget);
        let read_budget = file_len.min(remaining_budget);
        let mut content: Vec<u8> = Vec::with_capacity(read_budget as usize);
        if file.take(read_budget).read_to_end(&mut content).is_err() {
            total_scanned -= 1;
            continue;
        }
        bytes_scanned += content.len() as u64;
        if content.len() < read_budget as usize {
            truncated = true;
            break;
        }

        if let Ok(text) = std::str::from_utf8(&content) {
            collect_matches(text, file_path, &re, max_matches, max_line_bytes, &mut matches, &mut truncated);
            if input_truncated || truncated || is_cancelled() {
                truncated = true;
                break;
            }
        }
    }

    if is_cancelled() {
        truncated = true;
    }

    RsBoundedSearchResult {
        matches,
        total_scanned_files: total_scanned,
        duration_ms: start_time.elapsed().as_millis() as i64,
        metadata: Some(RsSearchMetadata {
            cancelled: is_cancelled(),
            truncated,
            error,
            scanned_files: total_scanned,
        }),
    }
}

fn would_exceed(file_len: u64, remaining: u64) -> bool {
    file_len > remaining
}

fn collect_matches(
    text: &str,
    file_path: &std::path::Path,
    re: &regex::Regex,
    max_matches: u32,
    max_line_bytes: usize,
    matches: &mut Vec<RsSearchMatch>,
    truncated: &mut bool,
) {
    for (idx, line) in text.lines().enumerate() {
        if matches.len() >= max_matches as usize {
            *truncated = true;
            return;
        }
        if re.is_match(line) {
            let mut content = line.trim_end().to_string();
            if content.len() > max_line_bytes {
                let mut cut = max_line_bytes;
                while cut > 0 && !content.is_char_boundary(cut) {
                    cut -= 1;
                }
                content.truncate(cut);
                *truncated = true;
            }
            matches.push(RsSearchMatch {
                file: file_path.to_string_lossy().to_string().replace('\\', "/"),
                line_number: (idx + 1) as u32,
                line_content: content,
            });
        }
    }
}
