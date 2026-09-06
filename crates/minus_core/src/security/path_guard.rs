use std::path::{Path, PathBuf};
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsPathResult {
    pub success: bool,
    pub resolved_path: Option<String>,
    pub error: Option<String>,
}

/// Chuẩn hoá và kiểm tra an toàn đường dẫn trong workspace
/// Chống path traversal (../) và symlink escape ra ngoài root
pub fn resolve_safe_path_internal(root_dir: &str, target_path: &str) -> Result<String, String> {
    let root = PathBuf::from(root_dir);
    let target = Path::new(target_path);

    let combined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };

    // Chuẩn hóa đường dẫn logic
    let normalized = match normalize_path(&combined) {
        Some(p) => p,
        None => return Err(format!("Security Exception: Invalid path structure: \"{}\"", target_path)),
    };

    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());

    // Kiểm tra tiền tố logic
    if let Ok(rel) = normalized.strip_prefix(&root) {
        if rel.starts_with("..") {
            return Err(format!(
                "Security Exception: Access denied for path outside workspace: \"{}\"",
                target_path
            ));
        }
    } else if let Ok(rel) = normalized.strip_prefix(&canonical_root) {
        if rel.starts_with("..") {
            return Err(format!(
                "Security Exception: Access denied for path outside workspace: \"{}\"",
                target_path
            ));
        }
    } else {
        return Err(format!(
            "Security Exception: Access denied for path outside workspace: \"{}\"",
            target_path
        ));
    }

    // Kiểm tra symlink escape trên filesystem thực tế
    let mut current = normalized.clone();
    while !current.exists() {
        if let Some(parent) = current.parent() {
            if parent == current {
                break;
            }
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    if current.exists() {
        if let Ok(real_target) = current.canonicalize() {
            if !real_target.starts_with(&canonical_root) {
                return Err(format!(
                    "Security Exception: Symlink target resolves outside workspace: \"{}\"",
                    target_path
                ));
            }
        }
    }

    Ok(normalized.to_string_lossy().to_string())
}

/// Khử các phần tử `.` và `..` mà không cần đĩa cứng phải tồn tại file
fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(p) => components.push(std::path::Component::Prefix(p)),
            std::path::Component::RootDir => components.push(std::path::Component::RootDir),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if let Some(last) = components.last() {
                    match last {
                        std::path::Component::Normal(_) => {
                            components.pop();
                        }
                        _ => return None,
                    }
                } else {
                    return None;
                }
            }
            std::path::Component::Normal(c) => components.push(std::path::Component::Normal(c)),
        }
    }

    let mut result = PathBuf::new();
    for c in components {
        result.push(c.as_os_str());
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_child_path() {
        let root = std::env::current_dir().unwrap();
        let root_str = root.to_str().unwrap();
        let res = resolve_safe_path_internal(root_str, "src/index.ts");
        assert!(res.is_ok());
    }

    #[test]
    fn test_path_traversal_denied() {
        let root = std::env::current_dir().unwrap();
        let root_str = root.to_str().unwrap();
        let res = resolve_safe_path_internal(root_str, "../../windows/system32");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Security Exception"));
    }
}
