use crate::state::{AppState, ClipItem, MAX_ITEMS_HARD_CAP};
use crate::storage::{
    delete_image_blob, gc_orphan_blobs, read_image_blob, write_history_to_disk,
};
use crate::{hash, hotkey, secrets};
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
pub fn read_blob(id: String, app: AppHandle) -> Result<String, String> {
    let bytes = read_image_blob(&app, &id)?;
    Ok(format!("data:image/png;base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn delete_item(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(new_sc).map_err(|e| e.to_string())
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
    state: State<'_, AppState>,
) {
    *state.sync_settings.lock() = settings;
    *state.device.lock() = device;
    *state.max_items.lock() = max_items.max(10);
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

// ── Presentation mode (Dock + menubar visibility) ─────────────────────────

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
pub fn paste_nth_history(n: usize, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
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
    let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
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
pub fn use_snippet(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    Err("snippets window not found".into())
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
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
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
