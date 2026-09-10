use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use napi_derive::napi;

#[derive(Debug, Clone)]
pub enum VirtualFileState {
    Created(String),
    Modified(String),
    Deleted,
}

#[derive(Debug)]
pub struct VirtualSession {
    pub id: String,
    pub root_dir: PathBuf,
    pub overlay: HashMap<String, VirtualFileState>,
}

static VFS_SESSIONS: OnceLock<Mutex<HashMap<String, VirtualSession>>> = OnceLock::new();

fn get_sessions() -> &'static Mutex<HashMap<String, VirtualSession>> {
    VFS_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_rel_path(path: &str) -> String {
    path.trim().replace('\\', "/").trim_start_matches('/').to_string()
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsVfsFileStatus {
    pub path: String,
    pub status: String, // "created" | "modified" | "deleted"
    pub size_bytes: u32,
}

pub fn vfs_create_session_native(session_id: &str, root_dir: &str) -> bool {
    let mut sessions = get_sessions().lock().unwrap();
    let root = PathBuf::from(root_dir);
    sessions.insert(
        session_id.to_string(),
        VirtualSession {
            id: session_id.to_string(),
            root_dir: root,
            overlay: HashMap::new(),
        },
    );
    true
}

pub fn vfs_read_file_native(session_id: &str, rel_path: &str) -> Option<String> {
    let norm = normalize_rel_path(rel_path);
    let sessions = get_sessions().lock().unwrap();
    let session = sessions.get(session_id)?;

    if let Some(state) = session.overlay.get(&norm) {
        match state {
            VirtualFileState::Created(c) | VirtualFileState::Modified(c) => return Some(c.clone()),
            VirtualFileState::Deleted => return None,
        }
    }

    // Đọc từ disk gốc nếu chưa bị sửa đổi trong overlay
    let full_path = session.root_dir.join(&norm);
    fs::read_to_string(full_path).ok()
}

pub fn vfs_write_file_native(session_id: &str, rel_path: &str, content: &str) -> bool {
    let norm = normalize_rel_path(rel_path);
    let mut sessions = get_sessions().lock().unwrap();
    let session = match sessions.get_mut(session_id) {
        Some(s) => s,
        None => return false,
    };

    let full_path = session.root_dir.join(&norm);
    let disk_exists = full_path.exists();

    let state = if disk_exists {
        VirtualFileState::Modified(content.to_string())
    } else {
        VirtualFileState::Created(content.to_string())
    };

    session.overlay.insert(norm, state);
    true
}

pub fn vfs_delete_file_native(session_id: &str, rel_path: &str) -> bool {
    let norm = normalize_rel_path(rel_path);
    let mut sessions = get_sessions().lock().unwrap();
    let session = match sessions.get_mut(session_id) {
        Some(s) => s,
        None => return false,
    };

    session.overlay.insert(norm, VirtualFileState::Deleted);
    true
}

pub fn vfs_list_modified_native(session_id: &str) -> Vec<RsVfsFileStatus> {
    let sessions = get_sessions().lock().unwrap();
    let session = match sessions.get(session_id) {
        Some(s) => s,
        None => return Vec::new(),
    };

    session.overlay.iter().map(|(path, state)| {
        let (status, size) = match state {
            VirtualFileState::Created(c) => ("created", c.len() as u32),
            VirtualFileState::Modified(c) => ("modified", c.len() as u32),
            VirtualFileState::Deleted => ("deleted", 0),
        };
        RsVfsFileStatus {
            path: path.clone(),
            status: status.to_string(),
            size_bytes: size,
        }
    }).collect()
}

pub fn vfs_generate_diff_native(session_id: &str) -> String {
    let sessions = get_sessions().lock().unwrap();
    let session = match sessions.get(session_id) {
        Some(s) => s,
        None => return String::new(),
    };

    let mut diff_output = String::new();
    for (rel_path, state) in &session.overlay {
        match state {
            VirtualFileState::Created(content) => {
                diff_output.push_str(&format!("diff --git a/{} b/{}\n", rel_path, rel_path));
                diff_output.push_str("new file mode 100644\n--- /dev/null\n");
                diff_output.push_str(&format!("+++ b/{}\n", rel_path));
                for line in content.lines() {
                    diff_output.push_str(&format!("+{}\n", line));
                }
            }
            VirtualFileState::Modified(new_content) => {
                let full_path = session.root_dir.join(rel_path);
                let old_content = fs::read_to_string(&full_path).unwrap_or_default();
                diff_output.push_str(&format!("diff --git a/{} b/{}\n", rel_path, rel_path));
                diff_output.push_str(&format!("--- a/{}\n", rel_path));
                diff_output.push_str(&format!("+++ b/{}\n", rel_path));
                diff_output.push_str(&format!("@@ -1,{} +1,{} @@\n", old_content.lines().count(), new_content.lines().count()));
                for line in old_content.lines() {
                    diff_output.push_str(&format!("-{}\n", line));
                }
                for line in new_content.lines() {
                    diff_output.push_str(&format!("+{}\n", line));
                }
            }
            VirtualFileState::Deleted => {
                diff_output.push_str(&format!("diff --git a/{} b/{}\n", rel_path, rel_path));
                diff_output.push_str("deleted file mode 100644\n");
                diff_output.push_str(&format!("--- a/{}\n+++ /dev/null\n", rel_path));
            }
        }
    }
    diff_output
}

pub fn vfs_commit_to_disk_native(session_id: &str) -> Result<Vec<String>, String> {
    let mut sessions = get_sessions().lock().unwrap();
    let session = sessions.get_mut(session_id).ok_or_else(|| "Session not found".to_string())?;
    let mut committed = Vec::new();

    for (rel_path, state) in &session.overlay {
        let full_path = session.root_dir.join(rel_path);

        match state {
            VirtualFileState::Created(content) | VirtualFileState::Modified(content) => {
                if let Some(parent) = full_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                fs::write(&full_path, content).map_err(|e| format!("Failed to write {}: {}", rel_path, e))?;
                committed.push(rel_path.clone());
            }
            VirtualFileState::Deleted => {
                if full_path.exists() {
                    let _ = fs::remove_file(&full_path);
                }
                committed.push(rel_path.clone());
            }
        }
    }

    session.overlay.clear();
    Ok(committed)
}

pub fn vfs_destroy_session_native(session_id: &str) -> bool {
    let mut sessions = get_sessions().lock().unwrap();
    sessions.remove(session_id).is_some()
}
