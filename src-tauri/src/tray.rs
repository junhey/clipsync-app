use crate::state::AppState;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

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

pub fn toggle_popup(app: &AppHandle, tray_rect: Option<tauri::Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_popup_at_tray(app, tray_rect);
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

    let show_item = MenuItem::with_id(app, "show", "显示 ClipSync", true, Some("Cmd+Shift+V"))?;
    let about_item = MenuItem::with_id(app, "about", "关于 ClipSync", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, Some("Cmd+Q"))?;
    let menu = Menu::with_items(app, &[&show_item, &about_item, &quit_item])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("ClipSync — Cmd+Shift+V")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => toggle_popup(app, None),
            "about" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("alert('ClipSync v0.3 — clipboard manager · GitHub sync')");
                }
            }
            "quit" => app.exit(0),
            _ => {}
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
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
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
    });
}

pub fn populate_state_from_disk(app: &AppHandle, state: &AppState) {
    use crate::storage::{gc_orphan_blobs, read_history_from_disk};
    let on_disk = read_history_from_disk(app);
    *state.history.lock() = on_disk.clone();
    gc_orphan_blobs(app, &on_disk);

    // Default ignore sources for password managers.
    *state.ignore_sources.lock() = vec![
        "com.agilebits.onepassword*".into(),
        "com.lastpass.LastPass".into(),
        "org.keepassxc.keepassxc".into(),
        "com.bitwarden.desktop".into(),
    ];
}
