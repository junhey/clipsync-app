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
    /// Content sha of the actual PNG bytes on the GitHub `data` branch.
    /// Only set on image items synced down from a remote — used by
    /// `read_blob` to lazily fetch the binary when the local blob is missing
    /// (typical on the receiving side that never had the original screenshot).
    #[serde(default, rename = "remoteRef", skip_serializing_if = "Option::is_none")]
    pub remote_ref: Option<String>,
    /// Text recognized from an image item. Absent for text items and for
    /// images that have not been recognized yet (or that contained no text).
    #[serde(default, rename = "ocrText", skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
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
    /// Shared snippet catalog. Empty until `load_catalog` fills it.
    pub catalog: Arc<Mutex<crate::catalog::CatalogFile>>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ClipItem {
        ClipItem {
            id: "a".into(),
            kind: "text".into(),
            text: "hi".into(),
            created_at: 1,
            updated_at: 1,
            hits: 1,
            pinned: None,
            source: None,
            device: None,
            width: None,
            height: None,
            bytes: None,
            format: None,
            remote_ref: None,
            ocr_text: None,
        }
    }

    #[test]
    fn ocr_text_round_trips_as_ocr_text() {
        let raw = r#"{"id":"a","kind":"text","text":"hi","createdAt":1,"updatedAt":1,"hits":1}"#;
        let item: ClipItem = serde_json::from_str(raw).unwrap();
        assert!(item.ocr_text.is_none());
        let json = serde_json::to_string(&item).unwrap();
        assert!(!json.contains("ocrText"));

        let mut item = sample();
        item.ocr_text = Some("你好".into());
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["ocrText"], "你好");
        let back: ClipItem = serde_json::from_value(value).unwrap();
        assert_eq!(back.ocr_text.as_deref(), Some("你好"));
    }
}
