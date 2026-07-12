use anyhow::{Context, Result};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
pub(crate) fn discover_excel_files(
    input_dir: &Path,
    output_dir: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    let output_dir = output_dir.and_then(|path| path.canonicalize().ok());
    let mut files = Vec::new();
    for entry in fs::read_dir(input_dir)
        .with_context(|| format!("读取输入目录失败: {}", input_dir.display()))?
    {
        let path = entry?.path();
        if !is_supported_excel_file(&path) {
            continue;
        }
        if let Some(output_dir) = &output_dir
            && path.parent().and_then(|p| p.canonicalize().ok()).as_ref() == Some(output_dir)
        {
            continue;
        }
        files.push(path);
    }
    files.sort_by_key(|path| file_name(path).to_lowercase());
    Ok(files)
}

pub(crate) fn is_supported_excel_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = file_name(path);
    if name.starts_with("~$") {
        return false;
    }
    matches!(
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_lowercase()),
        Some(ext) if matches!(ext.as_str(), "xlsx" | "xlsm" | "xlsb" | "xls")
    )
}

pub(crate) fn format_file_size(size: u64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut value = size as f64;
    for unit in units {
        if value < 1024.0 || unit == "GB" {
            return if unit == "B" {
                format!("{} B", value as u64)
            } else {
                format!("{value:.1} {unit}")
            };
        }
        value /= 1024.0;
    }
    format!("{size} B")
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

pub(crate) fn canonical_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub(crate) fn file_id_for_path(path: &Path, index: usize) -> u64 {
    let mut hasher = Sha1::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut value = 0u64;
    for byte in digest.iter().take(5) {
        value = (value << 8) | *byte as u64;
    }
    value + index as u64
}
