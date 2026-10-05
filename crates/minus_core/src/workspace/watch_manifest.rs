use std::path::Path;
use walkdir::WalkDir;
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsManifestEntry {
    pub rel_path: String,
    pub fingerprint: String,
    pub size_bytes: u32,
    pub mtime_ms: f64,
    pub kind: String,
}

fn mtime_ms_of(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_millis() as f64))
        .unwrap_or(0.0)
}

fn is_ignored_dir(name: &str, ignored: &[String]) -> bool {
    if ignored.iter().any(|ig| ig.as_str() == name) {
        return true;
    }
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "target"
            | ".gemini"
            | ".claude"
            | ".codingagent"
            | ".minus"
            | ".gitnexus"
    )
}

/// Bulk manifest scan: one NAPI crossing returns size+mtime fingerprints
/// for every eligible file. TS watcher uses this for polling fallback
/// and for debounced batch filtering (10-50x faster than Node stat loop).
pub fn scan_manifest_native(root_dir: &str, ignored_dirs: &[String]) -> Vec<RsManifestEntry> {
    let root_path = Path::new(root_dir);
    if !root_path.exists() || !root_path.is_dir() {
        return Vec::new();
    }
    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.file_type().is_dir() {
                let name = entry.file_name().to_string_lossy();
                if name.starts_with('.') && name != ".env" {
                    if name == ".git" {
                        return false;
                    }
                }
                if is_ignored_dir(&name, ignored_dirs) {
                    return false;
                }
            }
            true
        });

    let mut entries = Vec::new();
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let rel = match p.strip_prefix(root_path) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.starts_with("..") || rel.is_empty() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > 500 * 1024 {
            continue;
        }
        let mtime_ms = mtime_ms_of(p);
        entries.push(RsManifestEntry {
            fingerprint: format!("{}:{}", size, mtime_ms),
            rel_path: rel,
            size_bytes: size as u32,
            mtime_ms,
            kind: "file".to_string(),
        });
    }
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    entries
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsManifestDiff {
    pub rel_path: String,
    pub kind: String,
}

/// Pure diff of two fingerprint lists (both sorted by rel_path).
/// Runs fully in Rust so TS never loops file-by-file over NAPI.
pub fn diff_manifests_native(before: Vec<RsManifestEntry>, after: Vec<RsManifestEntry>) -> Vec<RsManifestDiff> {
    use std::collections::HashMap;
    let mut diffs = Vec::new();
    let before_map: HashMap<&str, &str> = before
        .iter()
        .map(|e| (e.rel_path.as_str(), e.fingerprint.as_str()))
        .collect();
    let after_map: HashMap<&str, &str> = after
        .iter()
        .map(|e| (e.rel_path.as_str(), e.fingerprint.as_str()))
        .collect();
    for (rel, after_fp) in &after_map {
        match before_map.get(rel) {
            None => diffs.push(RsManifestDiff {
                rel_path: rel.to_string(),
                kind: "create".to_string(),
            }),
            Some(before_fp) if *before_fp != **after_fp => diffs.push(RsManifestDiff {
                rel_path: rel.to_string(),
                kind: "modify".to_string(),
            }),
            _ => {}
        }
    }
    for rel in before_map.keys() {
        if !after_map.contains_key(rel) {
            diffs.push(RsManifestDiff {
                rel_path: rel.to_string(),
                kind: "delete".to_string(),
            });
        }
    }
    diffs.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    diffs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_scan_and_diff_manifest() {
        let temp_dir = std::env::temp_dir().join("minus_core_test_watch_manifest");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(temp_dir.join("a.txt"), "hello").unwrap();

        let ignored = vec!["node_modules".to_string()];
        let before = scan_manifest_native(&temp_dir.to_string_lossy(), &ignored);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].rel_path, "a.txt");

        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(temp_dir.join("b.txt"), "world").unwrap();
        let after = scan_manifest_native(&temp_dir.to_string_lossy(), &ignored);
        assert_eq!(after.len(), 2);

        let diffs = diff_manifests_native(before, after);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].rel_path, "b.txt");
        assert_eq!(diffs[0].kind, "create");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
