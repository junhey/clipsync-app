use crate::state::{AppState, ClipItem, MAX_ITEMS_HARD_CAP};
use crate::storage::{delete_image_blob, gc_orphan_blobs, read_image_blob, write_history_to_disk};
use crate::{autostart, hash, hotkey, secrets};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::{image::Image, AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[tauri::command]
pub fn load_history(state: State<'_, AppState>) -> Vec<ClipItem> {
    state.history.lock().clone()
}

#[tauri::command]
pub fn save_history(
    items: Vec<ClipItem>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let trimmed = items
        .into_iter()
        .take(MAX_ITEMS_HARD_CAP)
        .collect::<Vec<_>>();
    *state.history.lock() = trimmed.clone();
    write_history_to_disk(&app, &trimmed);
    gc_orphan_blobs(&app, &trimmed);
    Ok(())
}

#[tauri::command]
pub fn copy_to_clipboard(
    item: ClipItem,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if item.kind == "image" {
        let bytes = read_image_blob(&app, &item.id)?;
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let raw = rgba.into_raw();
        let cb_image = Image::new(&raw, w, h);
        app.clipboard()
            .write_image(&cb_image)
            .map_err(|e| e.to_string())?;
        *state.last_image_hash.lock() = Some(hash::hash_image_pixels(&raw, w, h));
    } else {
        app.clipboard()
            .write_text(item.text.clone())
            .map_err(|e| e.to_string())?;
        *state.last_text_hash.lock() = Some(hash::hash_text(&item.text));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_blob(id: String, app: AppHandle) -> Result<String, String> {
    // Fast path: image already cached locally.
    if let Ok(bytes) = read_image_blob(&app, &id) {
        return Ok(format!("data:image/png;base64,{}", B64.encode(bytes)));
    }

    // Lazy fetch from the GitHub `data` branch. We look up the item by id in
    // the history snapshot to recover its `remote_ref` (the actual PNG sha),
    // then download the blob and persist it locally so future reads are cheap.
    let state: tauri::State<'_, AppState> = app.state();
    let item = {
        let hist = state.history.lock();
        hist.iter().find(|x| x.id == id).cloned()
    };
    let png_sha = item
        .as_ref()
        .and_then(|i| i.remote_ref.clone())
        .ok_or_else(|| format!("image not available locally and no remote_ref: {id}"))?;

    let token = secrets::get_token().ok_or("no token in keychain")?;
    let settings = state.sync_settings.lock().clone();
    if settings.backend != "repo" {
        return Err("only the `repo` sync backend supports lazy image fetch".into());
    }
    let repo = match settings.repo.as_deref() {
        Some(r) if r.contains('/') => r.to_string(),
        _ => {
            let login = crate::sync_backends::repo::get_login(&token)
                .await
                .map_err(|e| e.to_string())?;
            format!("{login}/clipsync")
        }
    };
    let bytes = crate::sync_backends::repo::fetch_blob_bytes(&token, &repo, &png_sha)
        .await
        .map_err(|e| e.to_string())?;

    // Persist to the local cache so the next read takes the fast path. We
    // mirror save_image_blob's layout (id.png under cache_dir/blobs).
    let path = crate::storage::blob_file(&app, &id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &bytes);

    Ok(format!("data:image/png;base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn delete_item(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut hist = state.history.lock();
    hist.retain(|it| it.id != id);
    let snapshot = hist.clone();
    drop(hist);
    write_history_to_disk(&app, &snapshot);
    delete_image_blob(&app, &id);
    Ok(())
}

#[tauri::command]
pub fn hide_popup(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn set_hotkey(accelerator: String, app: AppHandle) -> Result<(), String> {
    let new_sc = hotkey::parse_accelerator(&accelerator)
        .ok_or_else(|| format!("invalid accelerator: {accelerator}"))?;

    // CommandOrControl+Shift+Alt+1..9 stay registered for direct paste.
    // Replacing the toggle must not unregister them.
    if crate::is_paste_nth_shortcut(new_sc.id()) {
        return Err(format!(
            "accelerator is reserved for direct paste: {accelerator}"
        ));
    }

    let previous = crate::current_toggle_shortcut();
    if previous.as_ref() == Some(&new_sc) {
        return Ok(());
    }

    let gs = app.global_shortcut();
    // Register the new accelerator before releasing the old one, so a failure
    // leaves the previous toggle in place. There is no window with zero toggle.
    gs.register(new_sc.clone()).map_err(|e| e.to_string())?;

    if let Some(prev) = previous {
        if prev.id() != new_sc.id() {
            if let Err(e) = gs.unregister(prev.clone()) {
                // New toggle is live and the old one may be too. Drop the new
                // registration and put the previous accelerator back if the
                // failed unregister already removed it.
                let _ = gs.unregister(new_sc.clone());
                if !gs.is_registered(prev.clone()) {
                    let _ = gs.register(prev);
                }
                return Err(format!("failed to replace hotkey: {e}"));
            }
        }
    }

    crate::remember_toggle_shortcut(new_sc);
    Ok(())
}

// ── Secrets ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_token(token: String) -> Result<(), String> {
    secrets::set_token(&token)
}

#[tauri::command]
pub fn get_token() -> Option<String> {
    secrets::get_token()
}

#[tauri::command]
pub fn clear_token() -> Result<(), String> {
    secrets::clear_token()
}

// ── Ignore-sources blacklist ───────────────────────────────────────────────

#[tauri::command]
pub fn set_ignore_sources(patterns: Vec<String>, state: State<'_, AppState>) {
    *state.ignore_sources.lock() = patterns;
}

// ── Sync ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_sync_settings(
    settings: crate::sync::SyncSettings,
    device: String,
    max_items: usize,
    app: AppHandle,
    state: State<'_, AppState>,
) {
    *state.sync_settings.lock() = settings.clone();
    // Persist so the Rust timer can keep working across restarts without
    // waiting for the frontend webview to boot.
    crate::sync::save_settings_to_disk(&app, &settings);
    // Only fall back to the frontend-provided device id if the backend hasn't
    // already initialised a stable one (e.g. very first launch before
    // `device::ensure_device_id` ran). Otherwise we'd let the frontend's
    // random localStorage value overwrite the persistent OS+hostname id every
    // time the settings panel is opened.
    {
        let mut d = state.device.lock();
        if d.is_empty() {
            *d = device;
        }
    }
    *state.max_items.lock() = max_items.max(10);
}

/// Expose the backend-managed stable device id to the frontend so the UI can
/// drop its localStorage-only fallback.
#[tauri::command]
pub fn get_device_id(state: State<'_, AppState>) -> String {
    state.device.lock().clone()
}

#[tauri::command]
pub async fn sync_check(state: State<'_, AppState>) -> Result<crate::sync::SyncCheck, String> {
    let settings = state.sync_settings.lock().clone();
    Ok(crate::sync::check_ready(&settings).await)
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let settings = state.sync_settings.lock().clone();
    let device = state.device.lock().clone();
    let max_items = *state.max_items.lock();
    crate::sync::sync_once(app, settings, device, max_items).await
}

/// Migrate any clipboard items found in the configured Gist over to the repo
/// backend. Does NOT delete the Gist; the user can do that on github.com.
/// Returns the number of items migrated.
#[tauri::command]
pub async fn migrate_from_gist(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let settings = state.sync_settings.lock().clone();
    let token = secrets::get_token().ok_or("no token in keychain")?;
    let gist_id = settings
        .gist_id
        .clone()
        .ok_or("no gistId in current settings")?;

    let res = reqwest::Client::new()
        .get(format!("https://api.github.com/gists/{gist_id}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "ClipSync/0.5 (rust)")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("gist GET failed: {}", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let content = v["files"]["history.json"]["content"]
        .as_str()
        .ok_or("history.json missing")?;

    #[derive(serde::Deserialize)]
    struct GistFile {
        items: Vec<ClipItem>,
    }
    let f: GistFile = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let count = f.items.len();

    {
        let mut hist = state.history.lock();
        let mut existing: std::collections::HashSet<String> =
            hist.iter().map(|x| x.id.clone()).collect();
        for it in f.items {
            if !existing.contains(&it.id) {
                existing.insert(it.id.clone());
                hist.insert(0, it);
            }
        }
        let snapshot = hist.clone();
        drop(hist);
        write_history_to_disk(&app, &snapshot);
        let _ = app.emit("history:updated", &snapshot);
    }

    {
        let mut s = state.sync_settings.lock();
        s.backend = "repo".to_string();
    }

    let device = state.device.lock().clone();
    let max_items = *state.max_items.lock();
    let mut updated = state.sync_settings.lock().clone();
    updated.backend = "repo".to_string();
    crate::sync::sync_once(app, updated, device, max_items).await?;

    Ok(count)
}

// ── History export / import ────────────────────────────────────────────────

/// Serialize the full clipboard history as a pretty-printed JSON string.
#[tauri::command]
pub fn export_history(state: State<'_, AppState>) -> Result<String, String> {
    let history = state.history.lock().clone();
    serde_json::to_string_pretty(&history).map_err(|e| e.to_string())
}

/// Merge an imported JSON array of ClipItems into the current history.
/// Deduplicates by `id`; items already present are skipped.
/// Returns the number of newly added items.
#[tauri::command]
pub fn import_history(
    json: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let incoming: Vec<ClipItem> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut hist = state.history.lock();
    let existing: std::collections::HashSet<String> = hist.iter().map(|x| x.id.clone()).collect();
    let mut added = 0usize;
    for item in incoming {
        if !existing.contains(&item.id) {
            hist.push(item);
            added += 1;
        }
    }
    hist.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    hist.truncate(MAX_ITEMS_HARD_CAP);
    let snapshot = hist.clone();
    drop(hist);
    write_history_to_disk(&app, &snapshot);
    let _ = app.emit("history:updated", &snapshot);
    crate::tray::rebuild_tray_menu(&app);
    Ok(added)
}

/// Switch how the app shows itself: as a menubar-only Accessory app, as a
/// Regular Dock-visible app, or as both at once. The change is applied
/// immediately without restart.
#[tauri::command]
pub fn set_presentation_mode(mode: String, app: AppHandle) -> Result<(), String> {
    let normalised = match mode.as_str() {
        "menubar" | "dock" | "both" => mode.as_str(),
        _ => return Err(format!("invalid mode: {mode}")),
    };

    #[cfg(target_os = "macos")]
    {
        let policy = if normalised == "menubar" {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        let _ = app.set_activation_policy(policy);
    }

    if let Some(tray) = app.tray_by_id("main-tray") {
        let visible = normalised != "dock";
        let _ = tray.set_visible(visible);
    }

    Ok(())
}

// ── Direct-paste hotkeys: paste history[n-1] without showing the popup ────

/// Take the n-th history item (1-indexed, pinned-first then newest), write it
/// to the clipboard, then synthesise a Cmd+V keystroke. Used by the global
/// `Cmd+Shift+Alt+1..9` hotkeys so the user can paste recent items without
/// ever opening the popup.
#[tauri::command]
pub fn paste_nth_history(
    n: usize,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if n == 0 || n > 9 {
        return Err("n must be 1..=9".into());
    }
    let snapshot = {
        let hist = state.history.lock();
        hist.clone()
    };
    // Sort: pinned first, then by updatedAt desc — same order users see in popup.
    let mut sorted = snapshot;
    sorted.sort_by(|a, b| {
        let pa = a.pinned.unwrap_or(false);
        let pb = b.pinned.unwrap_or(false);
        match pb.cmp(&pa) {
            std::cmp::Ordering::Equal => b.updated_at.cmp(&a.updated_at),
            o => o,
        }
    });
    let item = match sorted.into_iter().nth(n - 1) {
        Some(it) => it,
        None => return Ok(()), // not enough history; silent
    };

    if item.kind == "image" {
        // Skip image: there's no useful Cmd+V into a text input from a binary
        // png. Power users can still pick image via the popup.
        return Ok(());
    }

    app.clipboard()
        .write_text(item.text.clone())
        .map_err(|e| e.to_string())?;
    *state.last_text_hash.lock() = Some(hash::hash_text(&item.text));

    // Tiny delay so the clipboard write is observed by the next app before V.
    std::thread::sleep(std::time::Duration::from_millis(20));

    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Snippets ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Vec<crate::snippets::SnippetNode> {
    state.snippets.lock().clone()
}

#[tauri::command]
pub fn save_snippets(
    nodes: Vec<crate::snippets::SnippetNode>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    *state.snippets.lock() = nodes.clone();
    crate::snippets::save(&app, &nodes);
    let _ = app.emit("snippets:updated", &nodes);
    Ok(())
}

#[tauri::command]
pub fn delete_snippet(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut nodes = state.snippets.lock();
    crate::snippets::delete_node(&mut nodes, &id);
    let snapshot = nodes.clone();
    drop(nodes);
    crate::snippets::save(&app, &snapshot);
    let _ = app.emit("snippets:updated", &snapshot);
    Ok(())
}

#[tauri::command]
pub fn toggle_snippet(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut nodes = state.snippets.lock();
    crate::snippets::toggle_enabled(&mut nodes, &id);
    let snapshot = nodes.clone();
    drop(nodes);
    crate::snippets::save(&app, &snapshot);
    let _ = app.emit("snippets:updated", &snapshot);
    Ok(())
}

/// Apply a snippet: write its content to the clipboard and hide the popup.
/// The frontend then optionally calls `simulate_paste` to send Cmd+V.
#[tauri::command]
pub fn use_snippet(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let snapshot = state.snippets.lock().clone();
    let (_name, content) = crate::snippets::find_snippet_content(&snapshot, &id)
        .ok_or_else(|| format!("snippet not found: {id}"))?;
    app.clipboard()
        .write_text(content.clone())
        .map_err(|e| e.to_string())?;
    *state.last_text_hash.lock() = Some(hash::hash_text(&content));
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn open_snippets_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("snippets") {
        #[cfg(target_os = "macos")]
        {
            let _ = app.show();
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    // The window has been destroyed (user clicked the red close button or
    // pressed ⌘W) — Tauri on macOS tears down the webview rather than
    // hiding it, and `get_webview_window("snippets")` returns None
    // forever after. Re-create from the same config we'd normally get
    // out of tauri.conf.json so reopening the editor "just works"
    // however many times the user closes it.
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let win = WebviewWindowBuilder::new(
        &app,
        "snippets",
        WebviewUrl::App("index.html#/snippets".into()),
    )
    .title("ClipSync — 片段编辑器")
    .inner_size(760.0, 520.0)
    .min_inner_size(600.0, 360.0)
    .resizable(true)
    .visible(true)
    .focused(true)
    .build()
    .map_err(|e| format!("create snippets window: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
pub fn import_snippets(
    text: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let imported: Vec<crate::snippets::SnippetNode> =
        serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut nodes = state.snippets.lock();
    let count = imported.len();
    nodes.extend(imported);
    let snapshot = nodes.clone();
    drop(nodes);
    crate::snippets::save(&app, &snapshot);
    let _ = app.emit("snippets:updated", &snapshot);
    Ok(count)
}

#[tauri::command]
pub fn export_snippets(state: State<'_, AppState>) -> Result<String, String> {
    let snapshot = state.snippets.lock().clone();
    serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())
}

/// Fetch the shared catalog and remember it for later imports.
/// `source` is `"remote"` when the fetch parsed, otherwise `"bundled"`.
///
/// The `Result` is required for an async command that borrows `State`.
/// This command does not fail: a bad fetch is stored as the bundled copy.
#[tauri::command]
pub async fn load_catalog(
    state: State<'_, AppState>,
) -> Result<crate::catalog::LoadedCatalog, String> {
    let (file, sealed, source) = crate::catalog::fetch_catalog().await;
    let loaded = crate::catalog::LoadedCatalog {
        version: file.version,
        categories: file.categories.clone(),
        sealed,
        source: source.to_string(),
    };
    *state.catalog.lock() = file;
    Ok(loaded)
}

/// Copy one catalog snippet into the user's tree.
/// Returns `"added"` or `"updated"`.
#[tauri::command]
pub fn import_shared_snippet(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let item = {
        let catalog = state.catalog.lock();
        crate::catalog::find_snippet(&catalog, &id).cloned()
    };
    let item = match item {
        Some(item) => item,
        None => crate::catalog::find_snippet(&crate::catalog::bundled_catalog(), &id)
            .cloned()
            .ok_or_else(|| "目录里没有这条片段".to_string())?,
    };

    let mut roots = state.snippets.lock();
    let kind = crate::catalog::import_into(&mut roots, &item, crate::state::now_ms());
    let snapshot = roots.clone();
    drop(roots);
    crate::snippets::save(&app, &snapshot);
    let _ = app.emit("snippets:updated", &snapshot);
    Ok(kind.as_str().to_string())
}

/// Import a snippet the caller already decrypted. The catalog id is the
/// stable source id; name and content never pass through the sealed file.
#[tauri::command]
pub fn import_unlocked_snippet(
    id: String,
    name: String,
    content: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = id.trim().to_string();
    let name = name.trim().to_string();
    if id.is_empty() || content.is_empty() {
        return Err("这条分享不完整".to_string());
    }
    let item = crate::catalog::CatalogSnippet {
        id,
        name: if name.is_empty() {
            "未命名".to_string()
        } else {
            name
        },
        summary: String::new(),
        tags: Vec::new(),
        author: String::new(),
        content,
    };
    let mut roots = state.snippets.lock();
    let kind = crate::catalog::import_into(&mut roots, &item, crate::state::now_ms());
    let snapshot = roots.clone();
    drop(roots);
    crate::snippets::save(&app, &snapshot);
    let _ = app.emit("snippets:updated", &snapshot);
    Ok(kind.as_str().to_string())
}

/// Open the fixed share form. The caller supplies the title and body so a
/// private share can omit the plaintext. This is not a general URL opener.
#[tauri::command]
pub fn open_share_issue(title: String, body: String) -> Result<(), String> {
    open_share_form(&share_issue_url(&title, &body))
}

fn share_issue_url(title: &str, body: &str) -> String {
    let short_title: String = title.chars().take(80).collect();
    let body = clip_share_content(body);
    format!(
        "https://github.com/junhey/clipsync-app/issues/new?title={}&body={}",
        encode_query_component(&short_title),
        encode_query_component(&body)
    )
}

/// Keep at most 4000 Unicode scalar values. Longer text gains a trailing
/// line noting that it was cut.
fn clip_share_content(content: &str) -> String {
    if content.chars().count() <= 4000 {
        return content.to_string();
    }
    let mut clipped: String = content.chars().take(4000).collect();
    clipped.push('\n');
    clipped.push_str("（已截断）");
    clipped
}

/// Encode the characters that would break the query string, plus non-ASCII.
fn encode_query_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '\n' => out.push_str("%0A"),
            '\r' => out.push_str("%0D"),
            '#' => out.push_str("%23"),
            '&' => out.push_str("%26"),
            '%' => out.push_str("%25"),
            '+' => out.push_str("%2B"),
            '?' => out.push_str("%3F"),
            '=' => out.push_str("%3D"),
            '/' => out.push_str("%2F"),
            c if c.is_ascii() => out.push(c),
            c => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).as_bytes() {
                    push_percent(&mut out, *byte);
                }
            }
        }
    }
    out
}

fn push_percent(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(HEX[(byte >> 4) as usize] as char);
    out.push(HEX[(byte & 0x0f) as usize] as char);
}

fn open_share_form(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open").arg(url).status();

    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(code) => Err(format!("could not open the share form ({code})")),
        Err(err) => Err(err.to_string()),
    }
}

// ── Paste on pick ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn simulate_paste() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// Whether this process is allowed to post synthetic key events.
/// macOS gates that on Accessibility trust; other platforms have no equivalent
/// check and report trusted.
#[tauri::command]
pub fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

// ── Autostart ───────────────────────────────────────────────────────────
//
// On macOS we bypass tauri-plugin-autostart and use our own
// `crate::autostart` module — see that module's header comment for why
// (the plugin's macOS path never registers the agent with launchd, so
// System Settings → "登录项与扩展" shows it as missing even after
// "enable"). On Windows/Linux we keep the plugin's path, which is fine.

#[tauri::command]
pub async fn autostart_set(enabled: bool, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        autostart::set_enabled(&app, enabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        if enabled {
            mgr.enable().map_err(|e| e.to_string())
        } else {
            mgr.disable().map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn autostart_get(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(autostart::is_enabled(&app))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn autostart_diagnose(app: AppHandle) -> autostart::Diagnosis {
    autostart::diagnose(&app)
}

#[tauri::command]
pub async fn autostart_open_settings() -> Result<(), String> {
    autostart::open_system_login_items()
}

#[cfg(test)]
mod tests {
    use super::{clip_share_content, encode_query_component, share_issue_url};

    #[test]
    fn share_issue_url_truncates_and_encodes() {
        let url = share_issue_url("a b#&%+?=/x", "line\n2");
        assert!(url.starts_with("https://github.com/junhey/clipsync-app/issues/new?title="));
        assert!(url.contains("&body="));
        assert!(!url.contains(' '));
        assert!(!url.contains('\n'));
        assert!(url.contains("a%20b%23%26%25%2B%3F%3D%2Fx"));
        assert!(url.contains("%0A"));

        let long_title: String = "名".repeat(90);
        let long_url = share_issue_url(&long_title, "x");
        let title = encode_query_component(&"名".repeat(80));
        let longer_title = encode_query_component(&"名".repeat(81));
        assert!(long_url.contains(&format!("title={title}&")));
        assert!(!long_url.contains(&longer_title));

        let clipped = clip_share_content(&"c".repeat(4001));
        assert_eq!(clipped, format!("{}\n（已截断）", "c".repeat(4000)));
        assert_eq!(clip_share_content("exact"), "exact");
    }
}
