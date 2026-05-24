//! Backend-side GitHub sync. Lives in Rust so it keeps working when the
//! webview is suspended (which macOS does aggressively for hidden popups).

use crate::secrets;
use crate::state::ClipItem;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncSettings {
    pub backend: String, // "gist" | "repo" | "local"
    #[serde(default, rename = "gistId")]
    pub gist_id: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default, rename = "intervalSec")]
    pub interval_sec: u64,
    #[serde(default, rename = "pushOnChange")]
    pub push_on_change: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    device: String,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    items: Vec<ClipItem>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ClipSync/0.3 (rust)")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client")
}

async fn gh_get_gist_history(token: &str, gist_id: &str) -> Result<HistoryFile, String> {
    let res = client()
        .get(format!("https://api.github.com/gists/{gist_id}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("gist GET {} failed: {}", gist_id, res.status()));
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let content = json["files"]["history.json"]["content"]
        .as_str()
        .ok_or("history.json missing")?;
    serde_json::from_str(content).map_err(|e| e.to_string())
}

async fn gh_patch_gist_history(
    token: &str,
    gist_id: &str,
    file: &HistoryFile,
) -> Result<(), String> {
    let body = json!({
        "files": {
            "history.json": { "content": serde_json::to_string_pretty(file).unwrap() }
        }
    });
    let res = client()
        .patch(format!("https://api.github.com/gists/{gist_id}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("gist PATCH failed: {}", res.status()));
    }
    Ok(())
}

/// Same merge semantics as the TS side: dedupe by id, latest updatedAt wins,
/// pinned union, hits sum, cap by maxItems while preserving pinned.
pub fn merge_history(local: Vec<ClipItem>, remote: Vec<ClipItem>, max_items: usize) -> Vec<ClipItem> {
    use std::collections::HashMap;
    let mut map: HashMap<String, ClipItem> = HashMap::new();
    for it in local.into_iter().chain(remote.into_iter()) {
        match map.get_mut(&it.id) {
            Some(prev) => {
                prev.pinned = match (prev.pinned, it.pinned) {
                    (Some(true), _) | (_, Some(true)) => Some(true),
                    _ => None,
                };
                prev.hits = prev.hits.saturating_add(it.hits);
                if it.created_at < prev.created_at {
                    prev.created_at = it.created_at;
                }
                if it.updated_at > prev.updated_at {
                    prev.updated_at = it.updated_at;
                    prev.text = it.text;
                }
            }
            None => {
                map.insert(it.id.clone(), it);
            }
        }
    }
    let mut merged: Vec<ClipItem> = map.into_values().collect();
    merged.sort_by(|a, b| {
        let pa = a.pinned.unwrap_or(false);
        let pb = b.pinned.unwrap_or(false);
        match pb.cmp(&pa) {
            std::cmp::Ordering::Equal => b.updated_at.cmp(&a.updated_at),
            o => o,
        }
    });
    if merged.len() <= max_items {
        return merged;
    }
    let pinned_count = merged.iter().filter(|x| x.pinned == Some(true)).count();
    let keep_unpinned = max_items.saturating_sub(pinned_count);
    let mut kept: Vec<ClipItem> = Vec::with_capacity(max_items);
    let mut unpinned_taken = 0;
    for it in merged {
        if it.pinned == Some(true) {
            kept.push(it);
        } else if unpinned_taken < keep_unpinned {
            kept.push(it);
            unpinned_taken += 1;
        }
    }
    kept
}

pub async fn sync_once(
    app: AppHandle,
    settings: SyncSettings,
    device: String,
    max_items: usize,
) -> Result<(), String> {
    let token = secrets::get_token().ok_or("no token in keychain")?;
    let _ = app.emit("sync:status", json!({"phase":"syncing"}));

    let state: tauri::State<'_, crate::state::AppState> = app.state();
    let local = state.history.lock().clone();

    match settings.backend.as_str() {
        "repo" => sync_repo(&app, &token, &settings, &device, max_items, local).await?,
        "gist" => sync_gist(&app, &token, &settings, &device, max_items, local).await?,
        _ => {
            // "local" or unknown — nothing to do.
        }
    }

    let _ = app.emit("sync:status", json!({"phase":"ok", "at": crate::state::now_ms()}));
    Ok(())
}

/// Repo backend: content-addressed, single-commit, force-pushed `data` branch.
async fn sync_repo(
    app: &AppHandle,
    token: &str,
    settings: &SyncSettings,
    device: &str,
    max_items: usize,
    local: Vec<ClipItem>,
) -> Result<(), String> {
    use crate::sync_backends::repo::{fetch_repo_index, sync_repo_once};
    let repo = match settings.repo.as_deref() {
        Some(r) if r.contains('/') => r.to_string(),
        _ => {
            // Default to <login>/clipsync.
            let login =
                crate::sync_backends::repo::get_login(token).await?;
            format!("{login}/clipsync")
        }
    };

    // Pull remote index, merge with local, push back.
    let remote_items = fetch_repo_index(token, &repo)
        .await
        .ok()
        .flatten()
        .map(|f| {
            f.items
                .into_iter()
                .map(|e| ClipItem {
                    id: e.id,
                    kind: e.kind,
                    text: e.text,
                    created_at: e.created_at,
                    updated_at: e.updated_at,
                    hits: e.hits,
                    pinned: e.pinned,
                    source: None,
                    device: None,
                    width: e.width,
                    height: e.height,
                    bytes: e.bytes,
                    format: e.format,
                })
                .collect()
        })
        .unwrap_or_default();

    let merged = merge_history(local.clone(), remote_items, max_items);

    let state: tauri::State<'_, crate::state::AppState> = app.state();
    *state.history.lock() = merged.clone();
    crate::storage::write_history_to_disk(app, &merged);
    let _ = app.emit("history:updated", &merged);

    let snippets = state.snippets.lock().clone();
    sync_repo_once(token, &repo, device, merged, snippets).await?;
    Ok(())
}

/// Legacy Gist backend (kept for migration). Whole-file PATCH each round.
async fn sync_gist(
    app: &AppHandle,
    token: &str,
    settings: &SyncSettings,
    device: &str,
    max_items: usize,
    local: Vec<ClipItem>,
) -> Result<(), String> {
    let gist_id = match settings.gist_id.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(()),
    };
    let remote = gh_get_gist_history(token, gist_id).await.unwrap_or(HistoryFile {
        version: 1,
        device: device.to_string(),
        updated_at: 0,
        items: vec![],
    });

    let merged = merge_history(local.clone(), remote.items.clone(), max_items);
    let needs_push = settings.push_on_change || merged.len() != local.len();

    if !merged.is_empty() && (needs_push || local.is_empty()) {
        let state: tauri::State<'_, crate::state::AppState> = app.state();
        *state.history.lock() = merged.clone();
        crate::storage::write_history_to_disk(app, &merged);
        let _ = app.emit("history:updated", &merged);
    }

    if needs_push {
        let file = HistoryFile {
            version: 1,
            device: device.to_string(),
            updated_at: crate::state::now_ms(),
            items: merged,
        };
        gh_patch_gist_history(token, gist_id, &file).await?;
    }

    Ok(())
}

/// Background timer: sync every `interval_sec` while running. Settings are
/// re-read on every tick so user changes apply without restart.
pub fn spawn_sync_timer(app: AppHandle, settings_provider: impl Fn() -> SyncSettings + Send + 'static) {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            // Initial small delay so the app is fully up.
            tokio::time::sleep(Duration::from_secs(3)).await;
            loop {
                let settings = settings_provider();
                let interval = if settings.interval_sec == 0 {
                    30
                } else {
                    settings.interval_sec
                };
                let should_run = match settings.backend.as_str() {
                    "gist" => settings.gist_id.is_some(),
                    "repo" => true, // repo can self-default to <login>/clipsync
                    _ => false,
                };
                if should_run {
                    let device = "rust-sync".to_string();
                    let _ = sync_once(app.clone(), settings.clone(), device, 200).await;
                }
                tokio::time::sleep(Duration::from_secs(interval)).await;
            }
        });
    });
}
