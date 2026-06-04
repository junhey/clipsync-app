mod autostart;
mod clipboard;
mod commands;
mod device;
mod hash;
mod hotkey;
mod secrets;
mod snippets;
mod state;
mod storage;
mod sync;
mod sync_backends;
mod tray;

use state::AppState;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// Tag a global shortcut as either the popup toggle or one of the nine
/// "paste history[n]" hotkeys, so the global handler can dispatch.
#[derive(Clone, Copy)]
enum HotkeyAction {
    TogglePopup,
    PasteNth(usize),
}

use parking_lot::Mutex as PMutex;
use std::collections::HashMap;
use std::sync::OnceLock;
fn hotkey_routes() -> &'static PMutex<HashMap<u32, HotkeyAction>> {
    static R: OnceLock<PMutex<HashMap<u32, HotkeyAction>>> = OnceLock::new();
    R.get_or_init(|| PMutex::new(HashMap::new()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let action = {
                        let map = hotkey_routes().lock();
                        map.get(&shortcut.id()).copied()
                    };
                    match action {
                        Some(HotkeyAction::TogglePopup) | None => {
                            // Default: treat unknown as toggle (covers the
                            // initial Cmd+Shift+V before routes are populated).
                            tray::toggle_popup(app, None);
                        }
                        Some(HotkeyAction::PasteNth(n)) => {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let state: tauri::State<'_, AppState> = app.state();
                                let _ = commands::paste_nth_history(n, app.clone(), state);
                            });
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let app_handle = app.handle().clone();
            let state: tauri::State<'_, AppState> = app.state();
            tray::populate_state_from_disk(&app_handle, &state);

            // Multi-monitor self-test (debug builds only). At startup,
            // enumerate every connected display and verify the same
            // physical-pixel hit-test that `show_popup_at_cursor` uses
            // resolves each monitor's own centre back to itself. This
            // catches a class of regressions where some future Tauri / tao
            // upgrade changes which coordinate system `available_monitors`
            // reports — instead of mysteriously snapping the popup to the
            // wrong screen, we'll see the failure in stderr immediately.
            #[cfg(debug_assertions)]
            if let Ok(mons) = app_handle.available_monitors() {
                eprintln!("clipsync: [self-test] {} monitor(s):", mons.len());
                for (i, m) in mons.iter().enumerate() {
                    eprintln!(
                        "  [{i}] pos=({}, {}) size={}x{} scale={}",
                        m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor()
                    );
                }
                let mons_vec: Vec<_> = mons.into_iter().collect();
                for (i, m) in mons_vec.iter().enumerate() {
                    let p = m.position();
                    let s = m.size();
                    let cx = p.x + s.width as i32 / 2;
                    let cy = p.y + s.height as i32 / 2;
                    let hit_idx = mons_vec.iter().position(|mm| {
                        let pp = mm.position();
                        let ss = mm.size();
                        cx >= pp.x
                            && cx < pp.x + ss.width as i32
                            && cy >= pp.y
                            && cy < pp.y + ss.height as i32
                    });
                    let ok = hit_idx == Some(i);
                    eprintln!(
                        "clipsync: [self-test] center of #{i} ({cx},{cy}) -> hit=#{hit_idx:?} {}",
                        if ok { "OK" } else { "FAIL" }
                    );
                }
            } else {
                eprintln!("clipsync: [self-test] available_monitors() FAILED");
            }
            // Initialise the per-machine device id (persisted in app_data_dir),
            // so the Rust-side sync timer no longer uses the hardcoded
            // "rust-sync" name that conflated all devices into one identity.
            *state.device.lock() = device::ensure_device_id(&app_handle);
            // Restore sync settings from disk so the Rust timer can run on
            // first launch (before the frontend has called `set_sync_settings`)
            // and on every restart without the popup needing to be opened.
            *state.sync_settings.lock() = sync::load_settings_from_disk(&app_handle);
            // Load persisted snippets.
            *state.snippets.lock() = snippets::load(&app_handle);
            tray::build_tray(&app_handle).map_err(|e| e.to_string())?;
            tray::install_focus_lost_hide(&app_handle);
            // Populate tray menu with loaded history.
            tray::rebuild_tray_menu(&app_handle);

            // Toggle hotkey.
            if let Some(sc) = hotkey::parse_accelerator("CommandOrControl+Shift+V") {
                let id = sc.id();
                let _ = app.global_shortcut().register(sc);
                hotkey_routes().lock().insert(id, HotkeyAction::TogglePopup);
            }

            // Direct-paste hotkeys: Cmd+Shift+Alt+1..9.
            for n in 1..=9 {
                let acc = format!("CommandOrControl+Shift+Alt+{n}");
                if let Some(sc) = hotkey::parse_accelerator(&acc) {
                    let id = sc.id();
                    if app.global_shortcut().register(sc).is_ok() {
                        hotkey_routes()
                            .lock()
                            .insert(id, HotkeyAction::PasteNth(n));
                    }
                }
            }

            // Spawn the clipboard watcher (uses cloned Arcs).
            let watcher_state = AppState {
                history: state.history.clone(),
                last_text_hash: state.last_text_hash.clone(),
                last_image_hash: state.last_image_hash.clone(),
                ignore_sources: state.ignore_sources.clone(),
                sync_settings: state.sync_settings.clone(),
                device: state.device.clone(),
                max_items: state.max_items.clone(),
                snippets: state.snippets.clone(),
            };
            clipboard::spawn_clipboard_watcher(app_handle.clone(), watcher_state);

            // Spawn the Rust-side sync timer. It re-reads settings every tick
            // so user changes in the UI take effect without a restart, and it
            // keeps working when the webview is suspended.
            let settings_state = state.sync_settings.clone();
            sync::spawn_sync_timer(app_handle.clone(), move || settings_state.lock().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_history,
            commands::save_history,
            commands::copy_to_clipboard,
            commands::read_blob,
            commands::delete_item,
            commands::hide_popup,
            commands::set_hotkey,
            commands::set_token,
            commands::get_token,
            commands::clear_token,
            commands::set_ignore_sources,
            commands::set_sync_settings,
            commands::sync_now,
            commands::migrate_from_gist,
            commands::list_snippets,
            commands::save_snippets,
            commands::delete_snippet,
            commands::toggle_snippet,
            commands::use_snippet,
            commands::open_snippets_window,
            commands::import_snippets,
            commands::export_snippets,
            commands::set_presentation_mode,
            commands::paste_nth_history,
            commands::simulate_paste,
            commands::open_accessibility_settings,
            commands::export_history,
            commands::import_history,
            commands::get_device_id,
            commands::autostart_set,
            commands::autostart_get,
            commands::autostart_diagnose,
            commands::autostart_open_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
