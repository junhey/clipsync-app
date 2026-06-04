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

const SYNC_SETTINGS_FILE: &str = "sync-settings.json";

/// Persist sync settings to `<app_data_dir>/sync-settings.json` so the Rust
/// timer can keep running across restarts even when the frontend webview
/// hasn't booted yet (macOS suspends hidden popups aggressively).
pub fn save_settings_to_disk(app: &AppHandle, settings: &SyncSettings) {
    let path = match app.path().app_data_dir() {
        Ok(d) => d.join(SYNC_SETTINGS_FILE),
        Err(_) => return,
    };
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

pub fn load_settings_from_disk(app: &AppHandle) -> SyncSettings {
    let path = match app.path().app_data_dir() {
        Ok(d) => d.join(SYNC_SETTINGS_FILE),
        Err(_) => return SyncSettings::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => SyncSettings::default(),
    }
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
    // Clamp absurdly large `hits` values (left over from the old summing-merge
    // bug that drove the counter to u32::MAX). Without this, a single sync
    // round can re-poison local data with the corrupted remote `hits` and the
    // next `hits += 1` will overflow the watcher again.
    const SANE_HITS_CAP: u32 = 10_000;
    fn clamp_hits(mut it: ClipItem) -> ClipItem {
        if it.hits > SANE_HITS_CAP {
            it.hits = SANE_HITS_CAP;
        }
        it
    }

    let mut map: HashMap<String, ClipItem> = HashMap::new();
    for it in local
        .into_iter()
        .chain(remote.into_iter())
        .map(clamp_hits)
    {
        match map.get_mut(&it.id) {
            Some(prev) => {
                prev.pinned = match (prev.pinned, it.pinned) {
                    (Some(true), _) | (_, Some(true)) => Some(true),
                    _ => None,
                };
                // Use max instead of saturating_add: the remote side already
                // reflects a previous push from this (or another) device, so
                // summing them on every round causes hits to double each sync
                // and quickly saturate at u32::MAX, which then overflows the
                // next `hits += 1` in the clipboard watcher and crashes it.
                prev.hits = prev.hits.max(it.hits);
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

/// Merge two snippet trees: remote-only snippets (by id) are appended to the
/// root level; when the same id appears on both sides, keep the newer one.
/// Folder structure from local is preserved; remote-only items land at root.
fn merge_snippets(
    local: Vec<crate::snippets::SnippetNode>,
    remote: Vec<crate::snippets::SnippetNode>,
) -> Vec<crate::snippets::SnippetNode> {
    use crate::snippets::SnippetNode;

    fn collect_ids_and_timestamps(
        nodes: &[SnippetNode],
        out: &mut std::collections::HashMap<String, i64>,
    ) {
        for n in nodes {
            match n {
                SnippetNode::Snippet { id, updated_at, .. } => {
                    out.insert(id.clone(), *updated_at);
                }
                SnippetNode::Folder { children, .. } => {
                    collect_ids_and_timestamps(children, out);
                }
            }
        }
    }

    /// Replace snippets whose remote counterpart is newer, return what's left.
    fn apply_remote_updates(
        nodes: &mut Vec<SnippetNode>,
        remote_map: &std::collections::HashMap<String, &SnippetNode>,
    ) {
        for n in nodes.iter_mut() {
            match n {
                SnippetNode::Snippet { id, updated_at, .. } => {
                    if let Some(remote_node) = remote_map.get(id) {
                        if let SnippetNode::Snippet {
                            updated_at: remote_ts,
                            ..
                        } = remote_node
                        {
                            if remote_ts > updated_at {
                                *n = (*remote_node).clone();
                            }
                        }
                    }
                }
                SnippetNode::Folder { children, .. } => {
                    apply_remote_updates(children, remote_map);
                }
            }
        }
    }

    fn flatten_snippets<'a>(
        nodes: &'a [SnippetNode],
        out: &mut std::collections::HashMap<String, &'a SnippetNode>,
    ) {
        for n in nodes {
            match n {
                SnippetNode::Snippet { id, .. } => {
                    out.insert(id.clone(), n);
                }
                SnippetNode::Folder { children, .. } => flatten_snippets(children, out),
            }
        }
    }

    let mut local_timestamps: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    collect_ids_and_timestamps(&local, &mut local_timestamps);

    let mut remote_flat: std::collections::HashMap<String, &SnippetNode> =
        std::collections::HashMap::new();
    flatten_snippets(&remote, &mut remote_flat);

    let mut result = local;

    // Update any local snippets that are outdated.
    apply_remote_updates(&mut result, &remote_flat);

    // Append remote snippets/folders that have no local counterpart.
    fn append_missing(
        nodes: Vec<SnippetNode>,
        local_ids: &std::collections::HashMap<String, i64>,
        out: &mut Vec<SnippetNode>,
    ) {
        for n in nodes {
            match &n {
                SnippetNode::Snippet { id, .. } if local_ids.contains_key(id) => {
                    // Already merged above.
                }
                SnippetNode::Folder { id, name, children } => {
                    // Recurse to check if folder has any new snippets.
                    let mut new_children: Vec<SnippetNode> = Vec::new();
                    append_missing(children.clone(), local_ids, &mut new_children);
                    if !new_children.is_empty() {
                        // Re-use same folder id/name but only with the new children.
                        out.push(SnippetNode::Folder {
                            id: id.clone(),
                            name: name.clone(),
                            children: new_children,
                        });
                    }
                }
                _ => out.push(n),
            }
        }
    }
    append_missing(remote, &local_timestamps, &mut result);

    result
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
    use crate::sync_backends::repo::{fetch_repo_index, fetch_repo_snippets, sync_repo_once};
    let repo = match settings.repo.as_deref() {
        Some(r) if r.contains('/') => r.to_string(),
        _ => {
            let login = crate::sync_backends::repo::get_login(token).await?;
            format!("{login}/clipsync")
        }
    };

    // ── 1. History: pull + merge ──────────────────────────────────────────
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
                    remote_ref: e.remote_ref,
                })
                .collect()
        })
        .unwrap_or_default();

    let merged_history = merge_history(local.clone(), remote_items, max_items);

    let state: tauri::State<'_, crate::state::AppState> = app.state();
    *state.history.lock() = merged_history.clone();
    crate::storage::write_history_to_disk(app, &merged_history);
    let _ = app.emit("history:updated", &merged_history);
    crate::tray::rebuild_tray_menu(app);

    // ── 2. Snippets: pull + merge ─────────────────────────────────────────
    let local_snippets = state.snippets.lock().clone();
    let remote_snippets = fetch_repo_snippets(token, &repo)
        .await
        .unwrap_or_default();

    let merged_snippets = merge_snippets(local_snippets, remote_snippets);
    let snippets_changed = {
        let current = state.snippets.lock();
        // Compare lengths as a fast heuristic; a full diff would be expensive.
        current.len() != merged_snippets.len()
    };
    *state.snippets.lock() = merged_snippets.clone();
    crate::snippets::save(app, &merged_snippets);
    if snippets_changed {
        let _ = app.emit("snippets:updated", &merged_snippets);
    }

    // ── 3. Push unified state to remote ───────────────────────────────────
    sync_repo_once(token, &repo, device, merged_history, merged_snippets, app).await?;
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
        crate::tray::rebuild_tray_menu(app);
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
///
/// Failure handling: a single transient hiccup shouldn't spam stderr or
/// flood the UI with `sync:status` events. We track consecutive failures
/// and:
///   - apply an exponential back-off (capped at 10 minutes) so a long
///     outage doesn't keep hammering GitHub every 30s,
///   - de-dupe identical error messages — the first occurrence logs in
///     full, subsequent identical ones log once every 10 retries with a
///     summary like `"still failing (×17): ..."`,
///   - emit at most one `sync:status err` per distinct message, so the
///     UI doesn't repaint a flickering "同步失败" badge on every tick.
pub fn spawn_sync_timer(app: AppHandle, settings_provider: impl Fn() -> SyncSettings + Send + 'static) {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            // Initial small delay so the app is fully up.
            tokio::time::sleep(Duration::from_secs(3)).await;

            let mut consecutive_failures: u32 = 0;
            let mut last_error: Option<String> = None;
            loop {
                let settings = settings_provider();
                let configured_interval = if settings.interval_sec == 0 {
                    30
                } else {
                    settings.interval_sec
                };
                let should_run = match settings.backend.as_str() {
                    "gist" => settings.gist_id.is_some(),
                    "repo" => true, // repo can self-default to <login>/clipsync
                    _ => false,
                };

                let mut next_interval = configured_interval;
                if should_run {
                    // Read the persisted device id set during setup, falling
                    // back to a generic label if the value hasn't been hydrated
                    // yet (only happens during the first 3s warm-up window).
                    let state: tauri::State<'_, crate::state::AppState> = app.state();
                    let device = {
                        let d = state.device.lock().clone();
                        if d.is_empty() { "unknown".to_string() } else { d }
                    };
                    let max_items = {
                        let m = *state.max_items.lock();
                        if m == 0 { 200 } else { m }
                    };
                    match sync_once(app.clone(), settings.clone(), device, max_items).await {
                        Ok(()) => {
                            if consecutive_failures > 0 {
                                eprintln!("clipsync: sync recovered after {consecutive_failures} failure(s)");
                            }
                            consecutive_failures = 0;
                            last_error = None;
                        }
                        Err(e) => {
                            consecutive_failures = consecutive_failures.saturating_add(1);
                            let same_as_last = last_error.as_deref() == Some(e.as_str());
                            if !same_as_last {
                                // New / different error — log + notify UI.
                                eprintln!("clipsync: sync_once failed: {e}");
                                let _ = app.emit(
                                    "sync:status",
                                    json!({"phase": "err", "at": crate::state::now_ms(), "message": e}),
                                );
                                last_error = Some(e.clone());
                            } else if consecutive_failures % 10 == 0 {
                                // Same error N×10 in a row — periodic summary
                                // line so the user has *some* signal there's
                                // still a problem without drowning the log.
                                eprintln!(
                                    "clipsync: sync still failing (×{consecutive_failures}): {e}"
                                );
                            }

                            // Exponential back-off, capped at 600s (10 min).
                            // 1: 1×, 2: 2×, 3: 4×, 4: 8×, ... clamped.
                            let mult = 1u64 << consecutive_failures.min(5);
                            next_interval = (configured_interval as u64 * mult).min(600) as u64;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(next_interval)).await;
            }
        });
    });
}
