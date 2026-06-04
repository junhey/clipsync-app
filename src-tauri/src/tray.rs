use crate::state::AppState;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Minimal monitor bounds (physical pixels). Decoupled from `tauri::Monitor`
/// so the geometry logic is unit-testable without a running event loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MonRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl MonRect {
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Pick the monitor that physically contains `(px, py)` from `monitors`.
/// Returns the index. On a miss (cursor in the gap between two monitors,
/// or otherwise off-screen), returns `None` and the caller is expected to
/// fall back to a sensible default (e.g. the window's current monitor).
pub(crate) fn monitor_containing(monitors: &[MonRect], px: i32, py: i32) -> Option<usize> {
    monitors.iter().position(|m| m.contains(px, py))
}

/// Clamp a popup placed at `(px+12, py+12)` so the whole window fits
/// inside `mon`. Padding `pad` (default 8px) keeps the popup from hugging
/// the screen edge. Returns the final top-left corner in physical pixels.
///
/// We intentionally don't "flip" to the opposite side of the cursor when
/// there isn't enough room — that pushes tall popups very far from the
/// pointer on tall monitors, defeating the whole "follow the mouse"
/// intent. Instead we just clamp inward by the smallest amount that
/// makes the window fully visible.
pub(crate) fn clamp_popup_into(mon: MonRect, win_w: i32, win_h: i32, cx: i32, cy: i32, pad: i32) -> (i32, i32) {
    let mut x = cx + 12;
    let mut y = cy + 12;
    let max_x = mon.x + mon.w - win_w - pad;
    let max_y = mon.y + mon.h - win_h - pad;
    x = x.clamp(mon.x + pad, max_x.max(mon.x + pad));
    y = y.clamp(mon.y + pad, max_y.max(mon.y + pad));
    (x, y)
}

pub fn show_popup_at_tray(app: &AppHandle, tray_rect: Option<tauri::Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let win_size = win.outer_size().unwrap_or(tauri::PhysicalSize {
        width: 480,
        height: 560,
    });
    let scale = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let target = if let Some(rect) = tray_rect {
        let p_phys = rect.position.to_physical::<f64>(scale);
        let s_phys = rect.size.to_physical::<f64>(scale);
        let icon_x = p_phys.x as i32;
        let icon_y = p_phys.y as i32;
        let icon_w = s_phys.width as i32;
        let icon_h = s_phys.height as i32;
        let x = icon_x + icon_w / 2 - win_size.width as i32 / 2;
        let y = icon_y + icon_h + 8;
        tauri::PhysicalPosition { x, y }
    } else if let Ok(Some(monitor)) = win.current_monitor() {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let pad = (12.0 * scale) as i32;
        let menubar_h = (28.0 * scale) as i32;
        tauri::PhysicalPosition {
            x: mon_pos.x + mon_size.width as i32 - win_size.width as i32 - pad,
            y: mon_pos.y + menubar_h,
        }
    } else {
        tauri::PhysicalPosition { x: 100, y: 100 }
    };
    let _ = win.set_position(target);

    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("popup:toggle", ());
}

/// Show the popup anchored to the current mouse cursor position. Used when
/// the hotkey (or the tray menu's "显示" item) triggers the toggle — there's
/// no tray icon rect to anchor against in those cases, and the previous
/// behaviour of slamming the window into the top-right corner of the
/// monitor was disorienting when the user was working elsewhere on screen.
///
/// The window is placed just below-and-right of the pointer so the cursor
/// itself is never covered, then clamped (and flipped if necessary) to the
/// bounds of the monitor that currently contains the cursor.
pub fn show_popup_at_cursor(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let win_size = win.outer_size().unwrap_or(tauri::PhysicalSize {
        width: 480,
        height: 560,
    });

    // `cursor_position` already returns physical pixels and is multi-monitor
    // aware. Fall back to the tray-style top-right anchor if the runtime
    // refuses to report (e.g. no pointing device).
    let cursor = match app.cursor_position() {
        Ok(c) => c,
        Err(_) => {
            show_popup_at_tray(app, None);
            return;
        }
    };

    let cx = cursor.x as i32;
    let cy = cursor.y as i32;

    // CRITICAL for multi-monitor: we need the monitor that contains the
    // CURSOR, not the one the window happens to live on from a previous
    // session. We **don't** use Tauri's `monitor_from_point`: on macOS its
    // tao backend goes through `CGDisplayBounds` + `CGRectContainsPoint`,
    // both of which work in *logical* coordinates — but `cursor_position`
    // and `monitor.position()/size()` are reported in *physical* pixels.
    // That mismatch silently returns `None` on Retina + side-by-side
    // displays (the secondary monitor's centre `(5760, 1080)` physical
    // doesn't satisfy a check against logical bounds `(1920..3840, 0..1080)`).
    // We do our own physical-pixel hit-test against `available_monitors()`
    // — everything stays in one coordinate system end-to-end. See unit
    // tests in this file for the matrix this exercises.
    let mons: Vec<MonRect> = app
        .available_monitors()
        .ok()
        .map(|v| {
            v.into_iter()
                .map(|m| MonRect {
                    x: m.position().x,
                    y: m.position().y,
                    w: m.size().width as i32,
                    h: m.size().height as i32,
                })
                .collect()
        })
        .unwrap_or_default();

    let chosen = monitor_containing(&mons, cx, cy)
        .map(|i| mons[i])
        .or_else(|| {
            // Fallback: cursor is in a gap or off-screen. Use the window's
            // current monitor's bounds so we at least produce something
            // visible rather than placing the popup off-screen.
            win.current_monitor().ok().flatten().map(|m| MonRect {
                x: m.position().x,
                y: m.position().y,
                w: m.size().width as i32,
                h: m.size().height as i32,
            })
        });

    let (x, y) = if let Some(mon) = chosen {
        clamp_popup_into(mon, win_size.width as i32, win_size.height as i32, cx, cy, 8)
    } else {
        (cx + 12, cy + 12)
    };

    let _ = win.set_position(tauri::PhysicalPosition { x, y });

    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("popup:toggle", ());
}

pub fn toggle_popup(app: &AppHandle, tray_rect: Option<tauri::Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else if let Some(rect) = tray_rect {
        // Left-clicking the tray icon anchors below the icon.
        show_popup_at_tray(app, Some(rect));
    } else {
        // Hotkey + tray "显示" menu item follow the mouse cursor.
        show_popup_at_cursor(app);
    }
}

/// Sort history the same way the popup does: pinned first, then newest first,
/// text-only (images can't be meaningfully shown in a menu).
fn sorted_text_history(app: &AppHandle) -> Vec<crate::state::ClipItem> {
    let state: tauri::State<'_, AppState> = app.state();
    let mut items: Vec<_> = state
        .history
        .lock()
        .iter()
        .filter(|x| x.kind == "text")
        .cloned()
        .collect();
    items.sort_by(|a, b| {
        let pa = a.pinned.unwrap_or(false);
        let pb = b.pinned.unwrap_or(false);
        match pb.cmp(&pa) {
            std::cmp::Ordering::Equal => b.updated_at.cmp(&a.updated_at),
            o => o,
        }
    });
    items
}

/// Rebuild the tray right-click menu to reflect the current top-5 history
/// items. Safe to call from any thread; Tauri dispatches menu ops internally.
pub fn rebuild_tray_menu(app: &AppHandle) {
    let top: Vec<_> = sorted_text_history(app).into_iter().take(5).collect();
    let version = app.package_info().version.to_string();

    let Ok(show) = MenuItem::with_id(
        app,
        "show",
        "显示 ClipSync",
        true,
        Some("CmdOrCtrl+Shift+V"),
    ) else {
        return;
    };
    let Ok(about) = MenuItem::with_id(
        app,
        "about",
        &format!("关于 ClipSync v{version}"),
        true,
        None::<&str>,
    ) else {
        return;
    };
    let Ok(quit) = MenuItem::with_id(app, "quit", "退出", true, Some("CmdOrCtrl+Q")) else {
        return;
    };
    let Ok(menu) = Menu::new(app) else { return };
    let _ = menu.append(&show);

    if !top.is_empty() {
        if let Ok(sep) = PredefinedMenuItem::separator(app) {
            let _ = menu.append(&sep);
        }
        for (i, item) in top.iter().enumerate() {
            let raw: String = item.text.replace('\n', " ").replace('\t', " ");
            let preview: String = raw.chars().take(38).collect();
            let ellipsis = if raw.chars().count() > 38 { "…" } else { "" };
            let pin = if item.pinned.unwrap_or(false) { "★ " } else { "" };
            let label = format!("  {}  {pin}{preview}{ellipsis}", i + 1);
            if let Ok(mi) = MenuItem::with_id(
                app,
                format!("hist_{i}"),
                &label,
                true,
                None::<&str>,
            ) {
                let _ = menu.append(&mi);
            }
        }
        if let Ok(sep2) = PredefinedMenuItem::separator(app) {
            let _ = menu.append(&sep2);
        }
    }

    let _ = menu.append(&about);
    let _ = menu.append(&quit);

    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let icon_bytes: &[u8] = include_bytes!("../icons/tray@2x.png");
    #[cfg(not(target_os = "macos"))]
    let icon_bytes: &[u8] = include_bytes!("../icons/icon.png");

    let decoded = image::load_from_memory(icon_bytes)?;
    let rgba = decoded.to_rgba8();
    let (icon_w, icon_h) = rgba.dimensions();
    let tray_icon = Image::new_owned(rgba.into_raw(), icon_w, icon_h);

    let show_item = MenuItem::with_id(
        app,
        "show",
        "显示 ClipSync",
        true,
        Some("CmdOrCtrl+Shift+V"),
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip(if cfg!(target_os = "macos") {
            "ClipSync — ⌘⇧V"
        } else {
            "ClipSync — Ctrl+Shift+V"
        })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "show" => toggle_popup(app, None),
                "quit" => app.exit(0),
                "about" => {
                    let v = app.package_info().version.to_string();
                    if let Some(w) = app.get_webview_window("main") {
                        let msg = format!(
                            "alert('ClipSync v{v}\\n跨平台剪贴板管理器\\nGitHub 同步 · 快捷键 ⌘⇧V')"
                        );
                        let _ = w.eval(&msg);
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                id if id.starts_with("hist_") => {
                    if let Ok(n) = id[5..].parse::<usize>() {
                        let items = sorted_text_history(app);
                        if let Some(item) = items.into_iter().nth(n) {
                            let _ = app.clipboard().write_text(item.text.clone());
                            // Update hash so the watcher won't re-capture our own write.
                            let state: tauri::State<'_, AppState> = app.state();
                            *state.last_text_hash.lock() =
                                Some(crate::hash::hash_text(&item.text));
                        }
                    }
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                rect,
                ..
            } => {
                toggle_popup(tray.app_handle(), Some(rect));
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn install_focus_lost_hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let win_handle = win.clone();
    let close_handle = win.clone();
    win.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Focused(false) => {
                if !win_handle.is_visible().unwrap_or(false) {
                    return;
                }
                let w = win_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    if !w.is_focused().unwrap_or(false) {
                        let _ = w.hide();
                    }
                });
            }
            // macOS's red-X / ⌘W default action on a Tauri webview is to
            // *destroy* it — after that `get_webview_window("main")`
            // returns None and the global hotkey silently does nothing.
            // Treat close as hide so the popup is always reachable.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = close_handle.hide();
            }
            _ => {}
        }
    });
}

pub fn populate_state_from_disk(app: &AppHandle, state: &AppState) {
    use crate::storage::{gc_orphan_blobs, read_history_from_disk};
    let on_disk = read_history_from_disk(app);
    *state.history.lock() = on_disk.clone();
    gc_orphan_blobs(app, &on_disk);

    // Default ignore sources for password managers, per platform.
    //
    // macOS keys against the source-app bundle id (read via
    // `org.nspasteboard.source` on the pasteboard). Windows keys against the
    // foreground window's owning process name (matched case-insensitively by
    // the watcher). Linux has no equivalent yet, so we leave it empty.
    #[cfg(target_os = "macos")]
    let default_blocklist: Vec<String> = vec![
        "com.agilebits.onepassword*".into(),
        "com.lastpass.LastPass".into(),
        "org.keepassxc.keepassxc".into(),
        "com.bitwarden.desktop".into(),
        "com.dashlane.dashlanephonefinalmac".into(),
    ];
    #[cfg(target_os = "windows")]
    let default_blocklist: Vec<String> = vec![
        // 1Password: 1Password.exe / AgileBits.1Password.UI.exe
        "1Password*".into(),
        "AgileBits.1Password*".into(),
        // LastPass desktop / browser companion
        "LastPass*".into(),
        // KeePass family (KeePass, KeePassXC)
        "KeePass*".into(),
        // Bitwarden desktop
        "Bitwarden*".into(),
        // Dashlane
        "Dashlane*".into(),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let default_blocklist: Vec<String> = Vec::new();

    *state.ignore_sources.lock() = default_blocklist;
}

// ============================================================================
// Geometry unit tests — exercised with `cargo test --lib`.
//
// These cover the multi-monitor popup-anchoring matrix without needing a
// running event loop. The numbers mirror the real layouts we've seen in
// the wild plus a few pathological cases.
// ============================================================================
#[cfg(test)]
mod popup_geometry_tests {
    use super::*;

    /// Side-by-side Retina monitors (the user's actual setup):
    ///   #0 HP D27k      at (0, 0)    3840×2160 physical (2× scale)
    ///   #1 PHL 278B1    at (3840, 0) 3840×2160 physical (2× scale)
    fn dual_4k_side_by_side() -> Vec<MonRect> {
        vec![
            MonRect { x: 0, y: 0, w: 3840, h: 2160 },
            MonRect { x: 3840, y: 0, w: 3840, h: 2160 },
        ]
    }

    #[test]
    fn cursor_on_primary_picks_primary() {
        let mons = dual_4k_side_by_side();
        // Middle of the primary 4K screen.
        assert_eq!(monitor_containing(&mons, 1920, 1080), Some(0));
        // Top-left corner is inclusive.
        assert_eq!(monitor_containing(&mons, 0, 0), Some(0));
    }

    #[test]
    fn cursor_on_secondary_picks_secondary() {
        let mons = dual_4k_side_by_side();
        // Centre of the secondary 4K screen — *physical* pixels.
        // This is the exact case that broke under tao's logical-coord
        // monitor_from_point: cursor=(5760,1080) used to resolve to None.
        assert_eq!(monitor_containing(&mons, 5760, 1080), Some(1));
        // Just past the seam between monitors.
        assert_eq!(monitor_containing(&mons, 3840, 100), Some(1));
        // Far-right edge (last column inside #1).
        assert_eq!(monitor_containing(&mons, 7679, 2159), Some(1));
    }

    #[test]
    fn cursor_off_screen_returns_none() {
        let mons = dual_4k_side_by_side();
        // Far right of both monitors.
        assert_eq!(monitor_containing(&mons, 9000, 100), None);
        // Below both monitors.
        assert_eq!(monitor_containing(&mons, 100, 3000), None);
        // Negative quadrant.
        assert_eq!(monitor_containing(&mons, -10, -10), None);
    }

    #[test]
    fn cursor_at_seam_picks_secondary() {
        // The seam belongs to the right monitor: x == 3840 is the first
        // column of #1, *not* the last of #0 (width-exclusive convention).
        let mons = dual_4k_side_by_side();
        assert_eq!(monitor_containing(&mons, 3840, 500), Some(1));
        assert_eq!(monitor_containing(&mons, 3839, 500), Some(0));
    }

    #[test]
    fn secondary_above_primary_negative_y_works() {
        // Some users put their secondary above the primary, which gives
        // it a negative y-position. The hit-test must accept negatives.
        let mons = vec![
            MonRect { x: 0, y: 0, w: 3840, h: 2160 },        // primary
            MonRect { x: 0, y: -2160, w: 3840, h: 2160 },    // above primary
        ];
        assert_eq!(monitor_containing(&mons, 1920, -1000), Some(1));
        assert_eq!(monitor_containing(&mons, 1920, 1000), Some(0));
    }

    #[test]
    fn mixed_scale_monitors_still_hit_correctly() {
        // Retina 2× primary + external 1× 1080p to the right.
        //   #0 logical 1920×1080 → physical 3840×2160 (scale 2)
        //   #1 logical 1920×1080 → physical 1920×1080 (scale 1)
        // available_monitors() returns physical pixels, so the
        // hit-test only cares about (x,y,w,h).
        let mons = vec![
            MonRect { x: 0, y: 0, w: 3840, h: 2160 },
            MonRect { x: 3840, y: 0, w: 1920, h: 1080 },
        ];
        assert_eq!(monitor_containing(&mons, 4000, 500), Some(1));
        assert_eq!(monitor_containing(&mons, 3700, 500), Some(0));
    }

    #[test]
    fn single_monitor_degenerate_case() {
        let mons = vec![MonRect { x: 0, y: 0, w: 1920, h: 1080 }];
        assert_eq!(monitor_containing(&mons, 100, 100), Some(0));
        assert_eq!(monitor_containing(&mons, 1920, 0), None);
    }

    #[test]
    fn clamp_normal_case_window_fits_below_cursor() {
        // Plenty of room below+right of cursor; popup just gets the 12px
        // offset and is unchanged by clamp.
        let mon = MonRect { x: 0, y: 0, w: 3840, h: 2160 };
        let (x, y) = clamp_popup_into(mon, 960, 1120, 100, 100, 8);
        assert_eq!((x, y), (112, 112));
    }

    #[test]
    fn clamp_cursor_too_low_pulls_window_up_not_flip() {
        // Reproduces the original failure: window 960×1120 on a 4K screen,
        // cursor at y=1080 leaves only 1080 px below — not enough for the
        // 1120 px tall window. The OLD code "flipped" the window above
        // the cursor and landed it at y=8 (top of screen, far from the
        // pointer). The NEW code pulls the window up just enough to fit
        // and keeps it close to the pointer.
        let mon = MonRect { x: 0, y: 0, w: 3840, h: 2160 };
        let (_, y) = clamp_popup_into(mon, 960, 1120, 100, 1080, 8);
        let max_y = 2160 - 1120 - 8;
        assert_eq!(y, max_y, "popup should be pulled up to just fit, not flipped");
        // Sanity: still near the cursor, *not* glued to the screen top.
        assert!(y > 800, "popup should stay near the cursor; got y={y}");
    }

    #[test]
    fn clamp_cursor_on_secondary_keeps_window_on_secondary() {
        // This is the high-level invariant we couldn't satisfy before:
        // when the cursor is on #1, the popup must end up on #1 too.
        let mons = dual_4k_side_by_side();
        let mon_idx = monitor_containing(&mons, 5760, 1080).unwrap();
        assert_eq!(mon_idx, 1);
        let (x, y) = clamp_popup_into(mons[mon_idx], 960, 1120, 5760, 1080, 8);
        let mon = mons[mon_idx];
        assert!(x >= mon.x && x < mon.x + mon.w, "x={x} not on secondary {mon:?}");
        assert!(y >= mon.y && y < mon.y + mon.h, "y={y} not on secondary {mon:?}");
    }

    #[test]
    fn clamp_cursor_at_far_right_of_secondary_stays_visible() {
        // Cursor near the right edge of the secondary monitor — the popup
        // would extend off the right side; clamp must pull it back inside.
        let mon = MonRect { x: 3840, y: 0, w: 3840, h: 2160 };
        let (x, _) = clamp_popup_into(mon, 960, 1120, 7600, 500, 8);
        let max_x = 3840 + 3840 - 960 - 8;
        assert_eq!(x, max_x);
        // Stays on the secondary monitor.
        assert!(x >= mon.x);
    }
}
