#![deny(clippy::all)]

pub mod checkpoint;
pub mod patch;
pub mod runtime;
pub mod search;
pub mod security;
pub mod vector;
pub mod workspace;

use napi_derive::napi;

pub use checkpoint::{compute_file_sha256_native, compute_string_sha256_native, scan_and_digest_workspace_native};
pub use patch::{apply_hunk_to_content, levenshtein_distance, string_similarity, RsHunkApplyResult};
pub use runtime::{compute_history_stats_native, execute_isolated_command, RsExecutionResult, RsHistoryStats};
pub use search::{batch_read_files_native, search_codebase_native, RsBatchFileReadResult, RsSearchMatch, RsSearchResult};
pub use security::{parse_shell_command, resolve_safe_path_internal, RsPathResult, RsShellAnalysis};
pub use vector::{batch_cosine_similarity_simd, cosine_similarity_simd, generate_subword_embedding_native};
pub use workspace::{
    vfs_commit_to_disk_native, vfs_create_session_native, vfs_delete_file_native,
    vfs_destroy_session_native, vfs_generate_diff_native, vfs_list_modified_native,
    vfs_read_file_native, vfs_write_file_native, RsVfsFileStatus,
};
use napi::bindgen_prelude::Float64Array;

#[napi]
pub fn rs_cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
    cosine_similarity_simd(&a, &b)
}

#[napi]
pub fn rs_cosine_similarity_typed(a: Float64Array, b: Float64Array) -> f64 {
    cosine_similarity_simd(a.as_ref(), b.as_ref())
}

#[napi]
pub fn rs_batch_cosine_similarity(query: Float64Array, database: Float64Array, dims: u32) -> Vec<f64> {
    batch_cosine_similarity_simd(query.as_ref(), database.as_ref(), dims as usize)
}

#[napi]
pub fn rs_generate_subword_embedding(text: String) -> Vec<f64> {
    generate_subword_embedding_native(&text)
}

#[napi]
pub fn rs_version() -> String {
    "minus-core 0.3.0 (Tier 4+ Ultra Concurrency Engine)".to_string()
}

#[napi]
pub fn rs_analyze_shell_command(command: String) -> RsShellAnalysis {
    parse_shell_command(&command)
}

#[napi]
pub fn rs_resolve_safe_path(root_dir: String, target_path: String) -> RsPathResult {
    match resolve_safe_path_internal(&root_dir, &target_path) {
        Ok(p) => RsPathResult {
            success: true,
            resolved_path: Some(p),
            error: None,
        },
        Err(e) => RsPathResult {
            success: false,
            resolved_path: None,
            error: Some(e),
        },
    }
}

/// Thực thi lệnh cách ly với quota mặc định 2048 MB (Backward compatible)
#[napi]
pub fn rs_execute_isolated(
    command: String,
    cwd: String,
    timeout_ms: u32,
    max_bytes: u32,
) -> RsExecutionResult {
    execute_isolated_command(&command, &cwd, timeout_ms as u64, max_bytes as usize, 2048)
}

/// Thực thi lệnh trong Sandbox cứng với Windows Job Object / Quota RAM tùy chỉnh
#[napi]
pub fn rs_execute_sandboxed(
    command: String,
    cwd: String,
    timeout_ms: u32,
    max_bytes: u32,
    memory_limit_mb: u32,
) -> RsExecutionResult {
    execute_isolated_command(&command, &cwd, timeout_ms as u64, max_bytes as usize, memory_limit_mb)
}

#[napi]
pub fn rs_apply_hunk(
    original: String,
    hunk_lines: Vec<String>,
    expected_start: u32,
) -> RsHunkApplyResult {
    apply_hunk_to_content(&original, &hunk_lines, expected_start as usize)
}

#[napi]
pub fn rs_search_codebase(
    target_dir: String,
    query: String,
    is_regex: bool,
    ignore_case: bool,
    max_matches: u32,
    ignored_dirs: Vec<String>,
) -> RsSearchResult {
    search_codebase_native(&target_dir, &query, is_regex, ignore_case, max_matches, ignored_dirs)
}

#[napi]
pub fn rs_compute_file_hash(file_path: String) -> String {
    compute_file_sha256_native(&file_path).unwrap_or_default()
}

#[napi]
pub fn rs_compute_string_hash(content: String) -> String {
    compute_string_sha256_native(&content)
}

/// Quét toàn bộ thư mục và tính digest đại diện cho Workspace trong 1 lần gọi (Bulk processing)
#[napi]
pub fn rs_scan_and_digest_workspace(root_dir: String, ignored_dirs: Vec<String>) -> String {
    scan_and_digest_workspace_native(&root_dir, &ignored_dirs)
}

/// Đọc hàng loạt file trong workspace cùng lúc bằng Memory-Mapped I/O và kiểm tra Path Guard (Bulk read)
#[napi]
pub fn rs_batch_read_files(root_dir: String, rel_paths: Vec<String>, max_bytes: u32) -> Vec<RsBatchFileReadResult> {
    batch_read_files_native(&root_dir, &rel_paths, max_bytes as usize)
}

/// Phân tích thống kê ký tự và ước lượng token của toàn bộ session trong 1 lần gọi (Bulk history stats)
#[napi]
pub fn rs_fast_history_stats(payloads: Vec<String>) -> RsHistoryStats {
    compute_history_stats_native(&payloads)
}

// ── Virtual Copy-on-Write (CoW) Workspace APIs ───────────────────────────────

#[napi]
pub fn rs_vfs_create_session(session_id: String, root_dir: String) -> bool {
    vfs_create_session_native(&session_id, &root_dir)
}

#[napi]
pub fn rs_vfs_read_file(session_id: String, rel_path: String) -> Option<String> {
    vfs_read_file_native(&session_id, &rel_path)
}

#[napi]
pub fn rs_vfs_write_file(session_id: String, rel_path: String, content: String) -> bool {
    vfs_write_file_native(&session_id, &rel_path, &content)
}

#[napi]
pub fn rs_vfs_delete_file(session_id: String, rel_path: String) -> bool {
    vfs_delete_file_native(&session_id, &rel_path)
}

#[napi]
pub fn rs_vfs_list_modified(session_id: String) -> Vec<RsVfsFileStatus> {
    vfs_list_modified_native(&session_id)
}

#[napi]
pub fn rs_vfs_generate_diff(session_id: String) -> String {
    vfs_generate_diff_native(&session_id)
}

#[napi]
pub fn rs_vfs_commit_to_disk(session_id: String) -> Vec<String> {
    vfs_commit_to_disk_native(&session_id).unwrap_or_default()
}

#[napi]
pub fn rs_vfs_destroy_session(session_id: String) -> bool {
    vfs_destroy_session_native(&session_id)
}
