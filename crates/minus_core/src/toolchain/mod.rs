use napi_derive::napi;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

#[napi(object)]
pub struct RsExtractResult {
    pub files_extracted: u32,
    pub bytes_written: u64,
    pub top_level_stripped: bool,
}

/// Join an archive entry name onto `dest`, rejecting absolute paths,
/// parent (`..`) escapes and other non-normal components (zip-slip guard).
fn safe_join(dest: &Path, name: &str) -> Option<PathBuf> {
    let rel = Path::new(name);
    if rel.is_absolute() {
        return None;
    }
    let mut out = dest.to_path_buf();
    let mut pushed = false;
    for comp in rel.components() {
        match comp {
            Component::Normal(part) => {
                out.push(part);
                pushed = true;
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if pushed {
        Some(out)
    } else {
        None
    }
}

fn archive_kind(archive_path: &Path) -> Option<&'static str> {
    let lower = archive_path.to_string_lossy().to_lowercase();
    if lower.ends_with(".zip") {
        Some("zip")
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some("tar.gz")
    } else {
        None
    }
}

fn extract_zip(archive: &fs::File, dest: &Path) -> Result<(u32, u64), String> {
    let mut zip = zip::ZipArchive::new(archive).map_err(|e| format!("Invalid zip archive: {}", e))?;
    let mut files = 0u32;
    let mut bytes = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Unreadable zip entry {}: {}", i, e))?;
        let Some(out_path) = entry.enclosed_name().and_then(|p| safe_join(dest, &p.to_string_lossy())) else {
            continue;
        };
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("Cannot create dir {}: {}", out_path.display(), e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent {}: {}", parent.display(), e))?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| format!("Cannot write {}: {}", out_path.display(), e))?;
        let mut buf = [0u8; 65536];
        loop {
            let n = entry.read(&mut buf).map_err(|e| format!("Zip read error: {}", e))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("Disk write error: {}", e))?;
            bytes += n as u64;
        }
        files += 1;
    }
    Ok((files, bytes))
}

fn extract_tar_gz(archive: &fs::File, dest: &Path) -> Result<(u32, u64), String> {
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let mut files = 0u32;
    let mut bytes = 0u64;
    let entries = tar.entries().map_err(|e| format!("Invalid tar.gz archive: {}", e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Unreadable tar entry: {}", e))?;
        let entry_path = entry.path().map_err(|e| format!("Bad tar entry path: {}", e))?.to_path_buf();
        let Some(out_path) = safe_join(dest, &entry_path.to_string_lossy()) else {
            continue;
        };
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("Cannot create dir {}: {}", out_path.display(), e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent {}: {}", parent.display(), e))?;
        }
        entry.unpack(&out_path).map_err(|e| format!("Cannot unpack to {}: {}", out_path.display(), e))?;
        if let Ok(meta) = fs::metadata(&out_path) {
            if meta.is_file() {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    Ok((files, bytes))
}

/// Collapse a single top-level directory (e.g. `node-v22-win-x64/`) by moving
/// its children up one level. Returns true when a collapse happened.
fn collapse_single_top_dir(dest: &Path) -> Result<bool, String> {
    let entries: Vec<_> = fs::read_dir(dest)
        .map_err(|e| format!("Cannot list {}: {}", dest.display(), e))?
        .filter_map(|e| e.ok())
        .collect();
    if entries.len() != 1 || !entries[0].file_type().map(|t| t.is_dir()).unwrap_or(false) {
        return Ok(false);
    }
    let top = entries[0].path();
    let children: Vec<_> = fs::read_dir(&top)
        .map_err(|e| format!("Cannot list {}: {}", top.display(), e))?
        .filter_map(|e| e.ok())
        .collect();
    for child in children {
        let name = child.file_name();
        let target = dest.join(&name);
        if target.exists() {
            return Err(format!("Top-level collapse would overwrite {}", target.display()));
        }
        fs::rename(child.path(), &target).map_err(|e| format!("Cannot move {}: {}", child.path().display(), e))?;
    }
    fs::remove_dir(&top).map_err(|e| format!("Cannot remove {}: {}", top.display(), e))?;
    Ok(true)
}

/// Extract a `.zip` / `.tar.gz` / `.tgz` archive straight into `dest_dir`
/// (single pass, no temp dir, no external `tar`/`unzip` process).
pub fn extract_archive_native(
    archive_path: &str,
    dest_dir: &str,
    strip_top_level: bool,
) -> Result<RsExtractResult, String> {
    let archive = Path::new(archive_path);
    let dest = Path::new(dest_dir);
    let kind = archive_kind(archive)
        .ok_or_else(|| format!("Unsupported archive type (expected .zip/.tar.gz/.tgz): {}", archive_path))?;
    if !archive.is_file() {
        return Err(format!("Archive not found: {}", archive_path));
    }
    fs::create_dir_all(dest).map_err(|e| format!("Cannot create {}: {}", dest.display(), e))?;
    let file = fs::File::open(archive).map_err(|e| format!("Cannot open {}: {}", archive.display(), e))?;
    let (files_extracted, bytes_written) = match kind {
        "zip" => extract_zip(&file, dest)?,
        _ => extract_tar_gz(&file, dest)?,
    };
    let top_level_stripped = if strip_top_level {
        collapse_single_top_dir(dest)?
    } else {
        false
    };
    Ok(RsExtractResult {
        files_extracted,
        bytes_written,
        top_level_stripped,
    })
}

/// Scan flat directories for exact file names in one call (bulk PATH probe).
/// Returns absolute paths of hits. Case sensitivity follows the OS
/// (insensitive on Windows, sensitive elsewhere).
pub fn scan_path_for_binaries_native(dirs: &[String], file_names: &[String]) -> Vec<String> {
    if dirs.is_empty() || file_names.is_empty() {
        return Vec::new();
    }
    #[cfg(windows)]
    let lowered: Vec<String> = file_names.iter().map(|n| n.to_lowercase()).collect();
    let mut hits = Vec::new();
    for dir in dirs {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            #[cfg(windows)]
            let is_hit = lowered.iter().any(|n| *n == name.to_lowercase());
            #[cfg(not(windows))]
            let is_hit = file_names.iter().any(|n| *n == name);
            if is_hit {
                hits.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_case(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("minus_toolchain_test_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp case dir");
        dir
    }

    #[test]
    fn zip_extract_with_top_level_strip() {
        let root = temp_case("zip");
        let archive = root.join("a.zip");
        {
            let file = fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("top-1.0/bin/tool", opts).unwrap();
            zip.write_all(b"binary-bytes").unwrap();
            zip.start_file("top-1.0/README.md", opts).unwrap();
            zip.write_all(b"docs").unwrap();
            zip.finish().unwrap();
        }
        let dest = root.join("out");
        let res = extract_archive_native(archive.to_str().unwrap(), dest.to_str().unwrap(), true).unwrap();
        assert_eq!(res.files_extracted, 2);
        assert!(res.top_level_stripped);
        assert_eq!(fs::read(dest.join("bin").join("tool")).unwrap(), b"binary-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tar_gz_extract_without_strip() {
        let root = temp_case("tgz");
        let src = root.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub").join("f.txt"), b"hello").unwrap();
        let archive = root.join("a.tar.gz");
        {
            let file = fs::File::create(&archive).unwrap();
            let enc = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            let mut tar = tar::Builder::new(enc);
            tar.append_dir_all("pkg", &src).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let dest = root.join("out");
        let res = extract_archive_native(archive.to_str().unwrap(), dest.to_str().unwrap(), false).unwrap();
        assert_eq!(res.files_extracted, 1);
        assert!(!res.top_level_stripped);
        assert_eq!(fs::read(dest.join("pkg").join("sub").join("f.txt")).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_slip_entries_are_skipped() {
        let root = temp_case("slip");
        let archive = root.join("evil.zip");
        {
            let file = fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("ok.txt", opts).unwrap();
            zip.write_all(b"ok").unwrap();
            zip.finish().unwrap();
        }
        let dest = root.join("out");
        let res = extract_archive_native(archive.to_str().unwrap(), dest.to_str().unwrap(), true).unwrap();
        assert_eq!(res.files_extracted, 1);
        // Direct unit check of the guard itself:
        assert!(safe_join(Path::new("/d"), "../evil.txt").is_none());
        assert!(safe_join(Path::new("/d"), "/abs.txt").is_none());
        assert!(safe_join(Path::new("/d"), "a/../b.txt").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_scan_finds_exact_names() {
        let root = temp_case("scan");
        fs::write(root.join("node"), b"x").unwrap();
        fs::write(root.join("node_extra"), b"x").unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let hits = scan_path_for_binaries_native(&[root_s], &["node".to_string()]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("node"));
        assert!(scan_path_for_binaries_native(&[], &["node".to_string()]).is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
