use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const HISTORY_FILE: &str = "history.json";
pub const BLOBS_DIR: &str = "blobs";
pub const MAX_ITEMS_HARD_CAP: usize = 1000;
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024; // 20 MB

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipItem {
    pub id: String,
    pub kind: String, // "text" | "image" | "files"
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub hits: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    pub history: Arc<Mutex<Vec<ClipItem>>>,
    pub last_text_hash: Arc<Mutex<Option<String>>>,
    pub last_image_hash: Arc<Mutex<Option<String>>>,
    /// Blacklist of source bundle id patterns. Items whose source matches
    /// any pattern are dropped before reaching history.
    pub ignore_sources: Arc<Mutex<Vec<String>>>,
    /// Latest sync settings, mirrored from the frontend so the Rust sync
    /// timer can keep working while the webview is suspended.
    pub sync_settings: Arc<Mutex<crate::sync::SyncSettings>>,
    /// Device id for sync conflict tracking.
    pub device: Arc<Mutex<String>>,
    /// User-configured maxItems cap.
    pub max_items: Arc<Mutex<usize>>,
    /// Tree of long-lived user snippets (loaded from disk on boot).
    pub snippets: Arc<Mutex<Vec<crate::snippets::SnippetNode>>>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
