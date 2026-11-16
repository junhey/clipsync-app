use parking_lot::Mutex;
use serde::Serialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

const LATEST_URL: &str = "https://api.github.com/repos/junhey/clipsync-app/releases/latest";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: String,
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub url: String,
    pub can_install: bool,
    pub message: String,
}

struct RemoteRelease {
    version: String,
    notes: String,
    url: String,
}

fn status_slot() -> &'static Mutex<UpdateStatus> {
    static SLOT: OnceLock<Mutex<UpdateStatus>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(checking_status()))
}

fn checking_status() -> UpdateStatus {
    UpdateStatus {
        phase: "checking".into(),
        available: false,
        version: String::new(),
        notes: String::new(),
        url: String::new(),
        can_install: can_install(),
        message: String::new(),
    }
}

fn can_install() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Numeric dotted compare. `v` prefixes are ignored. Missing segments are 0,
/// so `0.8` is older than `0.10.2`.
pub(crate) fn is_newer(local: &str, remote: &str) -> bool {
    cmp_versions(local, remote) == std::cmp::Ordering::Less
}

fn cmp_versions(local: &str, remote: &str) -> std::cmp::Ordering {
    let parse = |raw: &str| -> Vec<u64> {
        raw.trim()
            .trim_start_matches('v')
            .trim_start_matches('V')
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect()
    };
    let left = parse(local);
    let right = parse(remote);
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        match l.cmp(&r) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn parse_release(raw: &str) -> Result<RemoteRelease, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|err| format!("无法读取版本信息: {err}"))?;
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string();
    if tag.is_empty() {
        return Err("发布信息里没有版本号".into());
    }
    let notes = value
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/junhey/clipsync-app/releases/latest")
        .to_string();
    Ok(RemoteRelease {
        version: tag,
        notes,
        url,
    })
}

fn publish(app: &AppHandle, status: UpdateStatus) {
    if status.available {
        crate::tray::set_update_notice(app, Some(&status.version));
    } else if status.phase != "checking" {
        crate::tray::set_update_notice(app, None);
    }
    let _ = app.emit("update:status", &status);
    *status_slot().lock() = status;
}

async fn run_check(app: AppHandle) -> UpdateStatus {
    publish(&app, checking_status());
    let local = app.package_info().version.to_string();
    let status = match fetch_latest().await {
        Ok(remote) => UpdateStatus {
            phase: "ready".into(),
            available: is_newer(&local, &remote.version),
            version: remote.version,
            notes: remote.notes,
            url: remote.url,
            can_install: can_install(),
            message: String::new(),
        },
        Err(err) => UpdateStatus {
            phase: "error".into(),
            available: false,
            version: String::new(),
            notes: String::new(),
            url: "https://github.com/junhey/clipsync-app/releases/latest".into(),
            can_install: can_install(),
            message: err,
        },
    };
    publish(&app, status.clone());
    status
}

async fn fetch_latest() -> Result<RemoteRelease, String> {
    let client = reqwest::Client::builder()
        .user_agent("ClipSync")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .get(LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| format!("检查更新失败: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("检查更新失败: HTTP {}", response.status()));
    }
    let body = response
        .text()
        .await
        .map_err(|err| format!("检查更新失败: {err}"))?;
    parse_release(&body)
}

pub fn spawn_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = run_check(app).await;
    });
}

#[tauri::command]
pub fn update_status() -> UpdateStatus {
    status_slot().lock().clone()
}

#[tauri::command]
pub async fn refresh_update(app: AppHandle) -> UpdateStatus {
    run_check(app).await
}

#[tauri::command]
pub fn open_update_page(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/junhey/clipsync-app/") {
        return Err("只能打开 ClipSync 的发布页".into());
    }
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = std::process::Command::new("xdg-open").arg(&url).status();
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(code) => Err(format!("无法打开下载页 ({code})")),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_newer, parse_release};

    #[test]
    fn newer_release_is_detected() {
        assert!(is_newer("0.10.2", "0.15.0"));
        assert!(is_newer("0.8", "0.10.2"));
        assert!(is_newer("0.10.2", "v0.10.10"));
    }

    #[test]
    fn same_or_older_release_is_not_an_update() {
        assert!(!is_newer("0.15.0", "0.15.0"));
        assert!(!is_newer("v0.15.0", "0.15.0"));
        assert!(!is_newer("0.15.0", "0.14.0"));
    }

    #[test]
    fn release_json_keeps_notes_and_strips_v() {
        let raw = r#"{"tag_name":"v0.15.0","body":"  hello\n","html_url":"https://github.com/junhey/clipsync-app/releases/tag/v0.15.0"}"#;
        let release = parse_release(raw).unwrap();
        assert_eq!(release.version, "0.15.0");
        assert_eq!(release.notes, "hello");
        assert!(release.url.contains("/releases/tag/v0.15.0"));
    }
}
