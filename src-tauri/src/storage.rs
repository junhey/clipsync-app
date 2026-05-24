use crate::state::{ClipItem, BLOBS_DIR, HISTORY_FILE};
use image::{ImageBuffer, Rgba};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn cache_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn history_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join(HISTORY_FILE)
}

pub fn blobs_path(app: &AppHandle) -> PathBuf {
    let p = cache_dir(app).join(BLOBS_DIR);
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn blob_file(app: &AppHandle, id: &str) -> PathBuf {
    blobs_path(app).join(format!("{id}.png"))
}

pub fn read_history_from_disk(app: &AppHandle) -> Vec<ClipItem> {
    let path = history_path(app);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn write_history_to_disk(app: &AppHandle, items: &[ClipItem]) {
    let path = history_path(app);
    if let Ok(json) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(path, json);
    }
}

pub fn save_image_blob(
    app: &AppHandle,
    id: &str,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<u64, String> {
    let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba.to_vec())
            .ok_or_else(|| "rgba size mismatch".to_string())?;
    let path = blob_file(app, id);
    if path.exists() {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        return Ok(meta.len());
    }
    buffer
        .save_with_format(&path, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

pub fn read_image_blob(app: &AppHandle, id: &str) -> Result<Vec<u8>, String> {
    let path = blob_file(app, id);
    std::fs::read(&path).map_err(|e| format!("blob not found: {e}"))
}

pub fn delete_image_blob(app: &AppHandle, id: &str) {
    let path = blob_file(app, id);
    let _ = std::fs::remove_file(path);
}

pub fn gc_orphan_blobs(app: &AppHandle, items: &[ClipItem]) {
    let referenced: HashSet<&str> = items
        .iter()
        .filter(|it| it.kind == "image")
        .map(|it| it.id.as_str())
        .collect();
    let dir = blobs_path(app);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".png") {
                if !referenced.contains(id) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}
