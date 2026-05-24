use crate::hash::{hash_image_pixels, hash_text};
use crate::state::{AppState, ClipItem, MAX_IMAGE_BYTES, MAX_ITEMS_HARD_CAP};
use crate::storage::{delete_image_blob, save_image_blob, write_history_to_disk};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// macOS-only: read NSPasteboard.changeCount, a tiny integer that the OS
/// bumps whenever any pasteboard write happens. Comparing it lets us skip
/// the actual text/image read on every poll while idle — same trick Clipy
/// uses to keep CPU at ~0% in the background.
#[cfg(target_os = "macos")]
fn current_change_count() -> Option<i64> {
    use objc2_app_kit::NSPasteboard;
    let pb = NSPasteboard::generalPasteboard();
    Some(pb.changeCount() as i64)
}

#[cfg(not(target_os = "macos"))]
fn current_change_count() -> Option<i64> {
    None
}

/// Choose a poll interval based on how recently the clipboard last changed.
/// Closely mirrors what the macOS WindowServer / Maccy / Clipy do — when
/// nothing has happened for a while, slow down so we can sleep most of the time.
fn poll_interval(idle_for: Duration) -> Duration {
    if idle_for < Duration::from_secs(30) {
        Duration::from_millis(600)
    } else if idle_for < Duration::from_secs(5 * 60) {
        Duration::from_millis(1500)
    } else {
        Duration::from_millis(3000)
    }
}

/// Should the given source be ignored according to user blacklist patterns?
/// Patterns support a trailing `*` wildcard.
pub fn source_blocked(source: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        if let Some(prefix) = p.strip_suffix('*') {
            source.starts_with(prefix)
        } else {
            source == p
        }
    })
}

pub fn try_capture_image(
    app: &AppHandle,
    state_history: &Arc<Mutex<Vec<ClipItem>>>,
    last_image_hash: &Arc<Mutex<Option<String>>>,
) -> bool {
    let img = match app.clipboard().read_image() {
        Ok(i) => i,
        Err(_) => return false,
    };
    let rgba = img.rgba();
    let width = img.width();
    let height = img.height();
    if width == 0 || height == 0 || rgba.is_empty() {
        return false;
    }
    let id = hash_image_pixels(rgba, width, height);
    {
        let mut last = last_image_hash.lock();
        if last.as_deref() == Some(id.as_str()) {
            return true;
        }
        *last = Some(id.clone());
    }

    let png_size = match save_image_blob(app, &id, rgba, width, height) {
        Ok(sz) => sz,
        Err(_) => return true,
    };
    if png_size as usize > MAX_IMAGE_BYTES {
        delete_image_blob(app, &id);
        return true;
    }

    let now = crate::state::now_ms();
    let placeholder = format!(
        "📷 {}×{} ({} KB)",
        width,
        height,
        (png_size as f64 / 1024.0).round() as u64
    );
    let item = ClipItem {
        id: id.clone(),
        kind: "image".into(),
        text: placeholder,
        created_at: now,
        updated_at: now,
        hits: 1,
        pinned: None,
        source: None,
        device: None,
        width: Some(width),
        height: Some(height),
        bytes: Some(png_size),
        format: Some("png".into()),
    };
    {
        let mut hist = state_history.lock();
        if let Some(pos) = hist.iter().position(|x| x.id == id) {
            let mut existing = hist.remove(pos);
            existing.updated_at = now;
            existing.hits += 1;
            hist.insert(0, existing.clone());
            let _ = app.emit("clipboard:new", &existing);
        } else {
            hist.insert(0, item.clone());
            if hist.len() > MAX_ITEMS_HARD_CAP {
                hist.truncate(MAX_ITEMS_HARD_CAP);
            }
            let _ = app.emit("clipboard:new", &item);
        }
    }
    write_history_to_disk(app, &state_history.lock());
    true
}

pub fn try_capture_text(
    app: &AppHandle,
    state_history: &Arc<Mutex<Vec<ClipItem>>>,
    last_text_hash: &Arc<Mutex<Option<String>>>,
    ignore_sources: &Arc<Mutex<Vec<String>>>,
) {
    let text = match app.clipboard().read_text() {
        Ok(t) => t,
        Err(_) => return,
    };
    if text.is_empty() {
        return;
    }
    let h = hash_text(&text);
    {
        let mut last = last_text_hash.lock();
        if last.as_deref() == Some(h.as_str()) {
            return;
        }
        *last = Some(h.clone());
    }
    // macOS-only: peek the source bundle id hint from the pasteboard,
    // and skip if it matches a blacklisted pattern.
    #[cfg(target_os = "macos")]
    {
        if let Some(src) = source_hint_macos() {
            let patterns = ignore_sources.lock().clone();
            if source_blocked(&src, &patterns) {
                return;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = ignore_sources;

    let now = crate::state::now_ms();
    let item = ClipItem {
        id: h.clone(),
        kind: "text".into(),
        text: text.clone(),
        created_at: now,
        updated_at: now,
        hits: 1,
        pinned: None,
        source: None,
        device: None,
        width: None,
        height: None,
        bytes: None,
        format: None,
    };
    {
        let mut hist = state_history.lock();
        if let Some(pos) = hist.iter().position(|x| x.id == h) {
            let mut existing = hist.remove(pos);
            existing.updated_at = now;
            existing.hits += 1;
            hist.insert(0, existing.clone());
            let _ = app.emit("clipboard:new", &existing);
        } else {
            hist.insert(0, item.clone());
            if hist.len() > MAX_ITEMS_HARD_CAP {
                hist.truncate(MAX_ITEMS_HARD_CAP);
            }
            let _ = app.emit("clipboard:new", &item);
        }
    }
    write_history_to_disk(app, &state_history.lock());
}

#[cfg(target_os = "macos")]
fn source_hint_macos() -> Option<String> {
    // Best-effort: read the `org.nspasteboard.source` UTI that some apps
    // (notably password managers) write to mark their pasteboard contents.
    // We shell out to `osascript` to keep the implementation tiny — the
    // same job in Objective-C would require pulling in obj2.
    let out = std::process::Command::new("osascript")
        .args([
            "-e",
            "use framework \"AppKit\"\nset pb to current application's NSPasteboard's generalPasteboard()\nset items to pb's pasteboardItems()\nif (count of items) is 0 then return \"\"\ntry\n  return ((items's first item)'s stringForType:\"org.nspasteboard.source\") as text\non error\n  return \"\"\nend try",
        ])
        .output()
        .ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

pub fn spawn_clipboard_watcher(app: AppHandle, state: AppState) {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            let mut last_change_count: Option<i64> = None;
            let mut last_activity = Instant::now();
            loop {
                let interval = poll_interval(last_activity.elapsed());
                tokio::time::sleep(interval).await;

                // macOS fast-path: if changeCount didn't move, skip everything.
                if let Some(cc) = current_change_count() {
                    if last_change_count == Some(cc) {
                        continue;
                    }
                    last_change_count = Some(cc);
                }

                let captured_image =
                    try_capture_image(&app, &state.history, &state.last_image_hash);
                if captured_image {
                    last_activity = Instant::now();
                    continue;
                }
                let len_before = state.history.lock().len();
                try_capture_text(
                    &app,
                    &state.history,
                    &state.last_text_hash,
                    &state.ignore_sources,
                );
                if state.history.lock().len() != len_before {
                    last_activity = Instant::now();
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_blocks() {
        let patterns = vec!["com.lastpass.LastPass".into()];
        assert!(source_blocked("com.lastpass.LastPass", &patterns));
        assert!(!source_blocked("com.other.app", &patterns));
    }

    #[test]
    fn wildcard_blocks_subdomains() {
        let patterns = vec!["com.agilebits.onepassword*".into()];
        assert!(source_blocked("com.agilebits.onepassword7", &patterns));
        assert!(source_blocked("com.agilebits.onepassword-launcher", &patterns));
        assert!(!source_blocked("com.something.else", &patterns));
    }

    #[test]
    fn empty_patterns_block_nothing() {
        assert!(!source_blocked("com.any.app", &[]));
    }
}
