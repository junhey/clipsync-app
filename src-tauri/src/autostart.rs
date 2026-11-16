//! Native macOS autostart — drop-in replacement for
//! tauri-plugin-autostart on macOS. We prefer SMAppService (the modern
//! API behind System Settings → "登录时打开"), and fall back to a
//! LaunchAgent + launchctl when SMAppService is unavailable (dev builds
//! without a .app bundle, macOS < 13, register() refused).
//!
//! Why not the plugin?
//!
//! The plugin delegates to the `auto-launch` crate, whose macOS path has
//! three serious gaps:
//!
//!   1. `enable()` only writes the plist file — it never calls
//!      `launchctl bootstrap` (or `launchctl load`). The login item is
//!      therefore invisible to launchd and to macOS 13+'s Background
//!      Task Management (BTM) database **until the next user login**.
//!
//!   2. `is_enabled()` only checks if the file exists, so the UI reports
//!      "enabled" while launchd has no clue about the agent.
//!
//!   3. The Label defaults to the product name (`"ClipSync"`) instead of
//!      a reverse-DNS bundle id, breaking the Apple naming convention
//!      BTM uses for deduplication.
//!
//! Why two backends instead of just LaunchAgent?
//!
//! macOS 13+ classifies LaunchAgents as background workers and shows
//! them under "允许在后台", not "登录时打开". `SMAppService.mainApp` is
//! the API specifically designed to populate "登录时打开". The catch is
//! it requires the running executable to live inside a real `.app`
//! bundle (so `tauri build` output, not `cargo run`). When that's not
//! the case we keep the LaunchAgent: it still gives the user the
//! behaviour they want (the app launches on login), just rendered in a
//! different section of System Settings.
//!
//! Windows and Linux remain on tauri-plugin-autostart, whose registry
//! and `.desktop` paths work correctly.

use serde::Serialize;

#[cfg(target_os = "macos")]
use std::{fs, io::Write, path::PathBuf, process::Command};

#[cfg(target_os = "macos")]
#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

/// Best-effort detection of whether the running executable lives inside
/// a .app bundle. `SMAppService.mainApp` requires this — when we're a
/// raw `target/debug/clipsync` binary the API will reject the
/// registration, so we have to know in advance which backend to try.
#[cfg(target_os = "macos")]
fn is_in_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| {
            // .app/Contents/MacOS/<exe>
            p.to_string_lossy().contains(".app/Contents/MacOS/")
        })
        .unwrap_or(false)
}

/// Thin bindings to `SMAppService.mainAppService`. Hand-rolled because
/// the ecosystem doesn't have an objc2-service-management crate yet and
/// the API surface we need is tiny (register / unregister / status).
#[cfg(target_os = "macos")]
mod sm {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::CStr;

    /// Mirrors `SMAppServiceStatus` enum from
    /// <ServiceManagement/SMAppService.h>. We treat anything other than
    /// `Enabled` as "not active".
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Status {
        NotRegistered,
        Enabled,
        RequiresApproval,
        NotFound,
    }

    impl Status {
        pub fn as_str(self) -> &'static str {
            match self {
                Status::NotRegistered => "not_registered",
                Status::Enabled => "enabled",
                Status::RequiresApproval => "requires_approval",
                Status::NotFound => "not_found",
            }
        }
    }

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"SMAppService")
    }

    pub fn available() -> bool {
        class().is_some()
    }

    /// Call `+[SMAppService mainAppService]` and return the raw pointer.
    /// Caller must keep it live only for the duration of the call — the
    /// returned object is autoreleased so we use it immediately.
    unsafe fn main_app_service() -> Option<*mut AnyObject> {
        let cls = class()?;
        let svc: *mut AnyObject = unsafe { msg_send![cls, mainAppService] };
        if svc.is_null() {
            None
        } else {
            Some(svc)
        }
    }

    /// Extract `[NSError localizedDescription]` as a Rust string. Best
    /// effort — returns a generic message if the bridge fails.
    unsafe fn ns_error_message(err: *mut AnyObject) -> String {
        if err.is_null() {
            return "unknown error".into();
        }
        let desc: *mut AnyObject = unsafe { msg_send![err, localizedDescription] };
        if desc.is_null() {
            return "no description".into();
        }
        let utf8: *const std::os::raw::c_char = unsafe { msg_send![desc, UTF8String] };
        if utf8.is_null() {
            return "no utf8 description".into();
        }
        unsafe { CStr::from_ptr(utf8) }
            .to_string_lossy()
            .into_owned()
    }

    pub fn register() -> Result<(), String> {
        unsafe {
            let svc = main_app_service().ok_or("SMAppService not available")?;
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let ok: bool = msg_send![svc, registerAndReturnError: &mut err];
            if ok {
                Ok(())
            } else {
                Err(ns_error_message(err))
            }
        }
    }

    pub fn unregister() -> Result<(), String> {
        unsafe {
            let svc = main_app_service().ok_or("SMAppService not available")?;
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let ok: bool = msg_send![svc, unregisterAndReturnError: &mut err];
            if ok {
                Ok(())
            } else {
                Err(ns_error_message(err))
            }
        }
    }

    pub fn status() -> Status {
        unsafe {
            let Some(svc) = main_app_service() else {
                return Status::NotFound;
            };
            let s: isize = msg_send![svc, status];
            match s {
                0 => Status::NotRegistered,
                1 => Status::Enabled,
                2 => Status::RequiresApproval,
                3 => Status::NotFound,
                _ => Status::NotFound,
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn label(app: &tauri::AppHandle) -> String {
    // Use the bundle identifier verbatim — same convention as Apple's own
    // login items. The bundle id is configured in tauri.conf.json.
    app.config().identifier.clone()
}

#[cfg(target_os = "macos")]
fn launch_agents_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Library/LaunchAgents")
}

#[cfg(target_os = "macos")]
fn plist_path(app: &tauri::AppHandle) -> PathBuf {
    launch_agents_dir().join(format!("{}.plist", label(app)))
}

/// Result of [`diagnose`] — every field that matters when the user
/// asks "why isn't autostart working?". Surface this in the UI when the
/// expected and actual state diverge.
#[derive(Debug, Clone, Serialize)]
pub struct Diagnosis {
    /// `"sm_app_service"` (preferred; shows under "登录时打开") or
    /// `"launch_agent"` (fallback; shows under "允许在后台"). `None`
    /// off-macOS.
    pub backend: Option<String>,
    /// macOS-only. SMAppService.status as `"enabled" | "not_registered"
    /// | "requires_approval" | "not_found"`. `None` if the API isn't
    /// available (< macOS 13).
    pub sm_status: Option<String>,
    /// `true` iff the running binary is inside a real .app bundle, which
    /// is a hard precondition for SMAppService.mainApp to accept the
    /// registration.
    pub in_app_bundle: bool,
    pub label: Option<String>,
    pub plist_path: Option<String>,
    pub plist_exists: bool,
    /// `true` iff the LaunchAgent fallback is currently registered with
    /// launchd. Independent of `sm_status` — both backends can coexist.
    pub launchctl_loaded: bool,
    pub agent_target: Option<String>,
    pub running_exe: Option<String>,
}

#[cfg(target_os = "macos")]
pub fn diagnose(app: &tauri::AppHandle) -> Diagnosis {
    let path = plist_path(app);
    let plist_exists = path.exists();
    let lbl = label(app);
    let in_app_bundle = is_in_app_bundle();

    let uid = unsafe { libc::getuid() };
    let launchctl_loaded = Command::new("launchctl")
        .args(["print", &format!("gui/{uid}/{lbl}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let agent_target = plist_exists
        .then(|| {
            Command::new("/usr/libexec/PlistBuddy")
                .args([
                    "-c",
                    "Print :ProgramArguments:0",
                    &path.to_string_lossy(),
                ])
                .output()
                .ok()
                .and_then(|o| {
                    o.status
                        .success()
                        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
                })
        })
        .flatten();

    let running_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.display().to_string());

    let sm_available = sm::available();
    let sm_status = sm_available.then(|| sm::status().as_str().to_string());

    // Report which backend will actually drive the user's experience —
    // SMAppService when the API is available *and* the running binary
    // sits in a .app bundle, LaunchAgent otherwise.
    let backend = Some(
        if sm_available && in_app_bundle {
            "sm_app_service"
        } else {
            "launch_agent"
        }
        .to_string(),
    );

    Diagnosis {
        backend,
        sm_status,
        in_app_bundle,
        label: Some(lbl),
        plist_path: Some(path.display().to_string()),
        plist_exists,
        launchctl_loaded,
        agent_target,
        running_exe,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn diagnose(_app: &tauri::AppHandle) -> Diagnosis {
    Diagnosis {
        backend: None,
        sm_status: None,
        in_app_bundle: false,
        label: None,
        plist_path: None,
        plist_exists: false,
        launchctl_loaded: false,
        agent_target: None,
        running_exe: std::env::current_exe()
            .ok()
            .map(|p| p.display().to_string()),
    }
}

/// Get whether autostart is *actually* in effect right now. Reports
/// `true` if EITHER backend has us registered — both flavours run the
/// app at login.
#[cfg(target_os = "macos")]
pub fn is_enabled(app: &tauri::AppHandle) -> bool {
    if sm::available() && sm::status() == sm::Status::Enabled {
        return true;
    }
    // LaunchAgent fallback: require BOTH the plist to exist AND launchd
    // to know about it. A plist without a load is a zombie (see Bug #1
    // in the module header); reporting it as enabled would lie.
    let d = diagnose(app);
    d.plist_exists && d.launchctl_loaded
}

#[cfg(not(target_os = "macos"))]
pub fn is_enabled(_app: &tauri::AppHandle) -> bool {
    false
}

/// Enable or disable autostart. Prefers `SMAppService.mainApp` so the
/// item lands in System Settings → "登录时打开" — when that fails
/// (dev build outside a .app bundle, macOS < 13, or a register error)
/// it falls back to the LaunchAgent path, which still launches the app
/// on login but appears under "允许在后台".
#[cfg(target_os = "macos")]
pub fn set_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let lbl = label(app);
    let path = plist_path(app);
    let uid = unsafe { libc::getuid() };
    let target = format!("gui/{uid}/{lbl}");

    if enabled {
        // ── Path A: SMAppService (preferred, lands under "登录时打开") ──
        if sm::available() && is_in_app_bundle() {
            match sm::register() {
                Ok(()) => {
                    // Belt-and-braces: tear down any LaunchAgent we may
                    // have installed in an earlier version so we don't
                    // run the app twice on login.
                    let _ = Command::new("launchctl")
                        .args(["bootout", &target])
                        .output();
                    let _ = Command::new("launchctl")
                        .args(["bootout", &format!("gui/{uid}/ClipSync")])
                        .output();
                    if path.exists() {
                        let _ = fs::remove_file(&path);
                    }
                    let legacy_path = launch_agents_dir().join("ClipSync.plist");
                    if legacy_path.exists() {
                        let _ = fs::remove_file(&legacy_path);
                    }
                    return Ok(());
                }
                Err(e) => {
                    // Most common in dev: "Operation not permitted"
                    // because the binary isn't a notarised .app. Log
                    // and fall through to the LaunchAgent path.
                    eprintln!(
                        "autostart: SMAppService.register failed: {e}; falling back to LaunchAgent"
                    );
                }
            }
        }

        // ── Path B: LaunchAgent (fallback, lands under "允许在后台") ──
        let dir = launch_agents_dir();
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir LaunchAgents: {e}"))?;
        }

        // Legacy cleanup: previous versions used the `auto-launch` crate,
        // which labelled the plist with the product name ("ClipSync")
        // instead of the bundle id. Bootout the old service (best-effort,
        // ignore failures) and remove the file so we don't end up with
        // two competing agents pointing at potentially-different binaries.
        let legacy_label = "ClipSync";
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/{legacy_label}")])
            .output();
        let legacy_path = launch_agents_dir().join(format!("{legacy_label}.plist"));
        if legacy_path.exists() {
            let _ = fs::remove_file(&legacy_path);
        }

        // Find the path we want launchd to start. For a packaged .app the
        // running exe lives at /Applications/ClipSync.app/Contents/MacOS/ClipSync,
        // which is exactly what we want to keep — launchd will start the
        // executable directly (no need to point at the .app bundle).
        let exe = std::env::current_exe()
            .and_then(|p| p.canonicalize())
            .map_err(|e| format!("current_exe: {e}"))?;
        let exe = exe.display().to_string();

        // Bootout any previous registration first (no-op if not loaded)
        // so we don't get a "service already loaded" error from bootstrap
        // when the plist was just rewritten.
        let _ = Command::new("launchctl").args(["bootout", &target]).output();

        let plist = format!(
            "{xml}\n{doctype}\n\
            <plist version=\"1.0\">\n  \
            <dict>\n  \
                <key>Label</key>\n  \
                <string>{lbl}</string>\n  \
                <key>ProgramArguments</key>\n  \
                <array>\n  \
                    <string>{exe}</string>\n  \
                </array>\n  \
                <key>RunAtLoad</key>\n  \
                <true/>\n  \
                <key>ProcessType</key>\n  \
                <string>Interactive</string>\n  \
                <key>LimitLoadToSessionType</key>\n  \
                <string>Aqua</string>\n  \
            </dict>\n\
            </plist>",
            xml = r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            doctype = r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#,
        );

        fs::File::create(&path)
            .and_then(|mut f| f.write_all(plist.as_bytes()))
            .map_err(|e| format!("write plist {}: {e}", path.display()))?;

        // bootstrap: register the plist with launchd in the user's GUI
        // session. This is the call that makes the login item appear in
        // System Settings → "登录项与扩展" *immediately*, not just after
        // the next login.
        let out = Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()])
            .output()
            .map_err(|e| format!("launchctl bootstrap: {e}"))?;
        if !out.status.success() {
            // bootstrap can fail if the user previously enabled and then
            // disabled the agent via System Settings, leaving a tombstone
            // in BTM — `kickstart` is the documented workaround.
            let _ = Command::new("launchctl")
                .args(["kickstart", &target])
                .output();
            // Re-check; if still not loaded, surface the original error.
            if !is_enabled(app) {
                return Err(format!(
                    "launchctl bootstrap failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }

        Ok(())
    } else {
        // Disable: clear *both* backends best-effort. A user who flipped
        // back and forth between dev (LaunchAgent) and release
        // (SMAppService) builds might have stale registrations on both
        // sides; we kill them all and never error so the UI can show
        // "未注册" with confidence.
        if sm::available() {
            let _ = sm::unregister();
        }
        let _ = Command::new("launchctl").args(["bootout", &target]).output();
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_enabled(_app: &tauri::AppHandle, _enabled: bool) -> Result<(), String> {
    // Non-macOS platforms continue to use tauri-plugin-autostart; the
    // frontend is wired to call that path directly when this stub is in
    // effect, so this should never be invoked. Returning Ok is safe — a
    // no-op is the closest we can do here.
    Ok(())
}

/// Open System Settings to the Login Items / Extensions pane so the user
/// can verify (or revoke) autostart visually. macOS 13+ only — older
/// versions just open System Settings root.
#[cfg(target_os = "macos")]
pub fn open_system_login_items() -> Result<(), String> {
    let url = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
    Command::new("open")
        .arg(url)
        .output()
        .map_err(|e| format!("open System Settings: {e}"))
        .map(|_| ())
}

#[cfg(not(target_os = "macos"))]
pub fn open_system_login_items() -> Result<(), String> {
    Err("not supported on this platform".into())
}
