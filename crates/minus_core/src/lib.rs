#![deny(clippy::all)]

pub mod checkpoint;
pub mod context;
pub mod patch;
pub mod runtime;
pub mod search;
pub mod security;
pub mod symbols;
pub mod vector;
pub mod workspace;

use napi_derive::napi;

pub use checkpoint::{compute_file_sha256_native, compute_string_sha256_native, scan_and_digest_workspace_native};
pub use context::{compact_history_native, RsCompactionResult};
pub use patch::{apply_hunk_to_content, levenshtein_distance, string_similarity, RsHunkApplyResult};
pub use runtime::{
    cancel_execution, compute_history_stats_native, execute_isolated_command, execute_isolated_command_async,
    truncate_tool_output_native, ExecuteCommandTask, RsExecutionResult, RsHistoryStats,
    RsTruncateResult,
};
pub use search::{batch_read_files_native, search_codebase_native, RsBatchFileReadResult, RsSearchMatch, RsSearchResult};
pub use security::{parse_shell_command, resolve_safe_path_internal, RsPathResult, RsShellAnalysis};
pub use symbols::{extract_file_symbols_native, find_symbol_in_file_native, RsSymbolDefinition};
pub use vector::{batch_cosine_similarity_simd, cosine_similarity_simd, generate_subword_embedding_native};
pub use workspace::{
    vfs_commit_to_disk_native, vfs_create_session_native, vfs_delete_file_native,
    vfs_destroy_session_native, vfs_generate_diff_native, vfs_list_modified_native,
    vfs_read_file_native, vfs_write_file_native, RsVfsFileStatus,
};
use napi::{Env, Task};
use napi::bindgen_prelude::{AsyncTask, Float64Array};

pub struct BatchReadFilesTask {
    root_dir: String,
    rel_paths: Vec<String>,
    max_bytes: usize,
}

impl Task for BatchReadFilesTask {
    type Output = Vec<RsBatchFileReadResult>;
    type JsValue = Vec<RsBatchFileReadResult>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(batch_read_files_native(&self.root_dir, &self.rel_paths, self.max_bytes))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct SearchCodebaseTask {
    target_dir: String,
    query: String,
    is_regex: bool,
    ignore_case: bool,
    max_matches: u32,
    ignored_dirs: Vec<String>,
}

impl Task for SearchCodebaseTask {
    type Output = RsSearchResult;
    type JsValue = RsSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(search_codebase_native(
            &self.target_dir,
            &self.query,
            self.is_regex,
            self.ignore_case,
            self.max_matches,
            self.ignored_dirs.clone(),
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

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

/// Chạy command trên libuv worker để không chặn event loop Node.js.
#[napi]
pub fn rs_execute_sandboxed_async(
    command: String,
    cwd: String,
    timeout_ms: u32,
    max_bytes: u32,
    memory_limit_mb: u32,
    execution_id: String,
    environment: Vec<String>,
) -> AsyncTask<ExecuteCommandTask> {
    execute_isolated_command_async(
        command,
        cwd,
        timeout_ms as u64,
        max_bytes as usize,
        memory_limit_mb,
        execution_id,
        environment,
    )
}

#[napi]
pub fn rs_cancel_sandboxed(execution_id: String) -> bool {
    cancel_execution(&execution_id)
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
pub fn rs_search_codebase_async(
    target_dir: String,
    query: String,
    is_regex: bool,
    ignore_case: bool,
    max_matches: u32,
    ignored_dirs: Vec<String>,
) -> AsyncTask<SearchCodebaseTask> {
    AsyncTask::new(SearchCodebaseTask {
        target_dir,
        query,
        is_regex,
        ignore_case,
        max_matches,
        ignored_dirs,
    })
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

#[napi]
pub fn rs_batch_read_files_async(
    root_dir: String,
    rel_paths: Vec<String>,
    max_bytes: u32,
) -> AsyncTask<BatchReadFilesTask> {
    AsyncTask::new(BatchReadFilesTask {
        root_dir,
        rel_paths,
        max_bytes: max_bytes as usize,
    })
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

// ── Native Output Truncation & Compaction & Symbols APIs ──────────────────────

#[napi]
pub fn rs_truncate_tool_output(
    content: String,
    max_lines: u32,
    max_bytes: u32,
    preserve_head_tail: bool,
) -> RsTruncateResult {
    truncate_tool_output_native(&content, max_lines, max_bytes, preserve_head_tail)
}

#[napi]
pub fn rs_compact_history(
    messages_json: String,
    max_tokens: u32,
    preserve_last_n: u32,
    max_chars_per_tool: u32,
) -> RsCompactionResult {
    compact_history_native(&messages_json, max_tokens, preserve_last_n, max_chars_per_tool)
}

#[napi]
pub fn rs_extract_file_symbols(file_path: String, content: Option<String>) -> Vec<RsSymbolDefinition> {
    extract_file_symbols_native(&file_path, content.as_deref())
}

#[napi]
pub fn rs_find_symbol_in_file(
    file_path: String,
    symbol_name: String,
    content: Option<String>,
) -> RsSymbolDefinition {
    find_symbol_in_file_native(&file_path, &symbol_name, content.as_deref())
}
