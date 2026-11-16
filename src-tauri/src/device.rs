//! Stable per-device identifier for sync conflict tracking.
//!
//! Format: `<os>-<hostname>-<random6>`, e.g. `macos-junhey-mbp-a3kq91`.
//! Generated once on first launch and persisted to `<app_data_dir>/device-id`
//! so reinstalls and process restarts keep the same identity.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DEVICE_FILE: &str = "device-id";
const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

fn device_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join(DEVICE_FILE)
}

fn os_label() -> &'static str {
    // Slightly friendlier than `std::env::consts::OS` for users reading
    // sync logs / commit messages on the GitHub side.
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

fn hostname_sanitized() -> String {
    // Prefer the real host name (uname -n / GetComputerNameW). On a fresh
    // shell on macOS, `$HOSTNAME` is empty unless a login shell exported it,
    // so we can't rely on env vars alone — the `hostname` crate hides those
    // platform quirks behind one call.
    let raw = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::env::var("HOST").ok())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "host".into());

    let mut out = String::with_capacity(raw.len());
    for c in raw.chars().take(24) {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if c == '-' || c == '_' || c == '.' {
            out.push('-');
        }
    }
    // Strip a trailing `.local` (common on macOS Bonjour names) for cleanliness.
    if let Some(stripped) = out.strip_suffix("-local") {
        out = stripped.to_string();
    }
    if out.is_empty() {
        "host".into()
    } else {
        out
    }
}

fn random_suffix() -> String {
    // 6 chars from a-z0-9 → 36^6 ≈ 2.2B values; collision risk negligible
    // for personal multi-device sync (typically ≤ 5 devices).
    let mut buf = [0u8; 6];
    for slot in buf.iter_mut() {
        // Bias-free modulo via rejection sampling is overkill here.
        let n = rand_byte() % ALPHA.len() as u8;
        *slot = ALPHA[n as usize];
    }
    String::from_utf8(buf.to_vec()).unwrap_or_else(|_| "xxxxxx".into())
}

fn rand_byte() -> u8 {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Quick & dirty PRNG seeded from the system clock. Avoids pulling in a
    // dedicated rand crate just for one-shot ID generation at boot.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    static mut SEED: u32 = 0;
    unsafe {
        if SEED == 0 {
            SEED = nanos.wrapping_mul(2654435761);
        }
        SEED = SEED.wrapping_mul(1664525).wrapping_add(1013904223) ^ nanos;
        (SEED >> 16) as u8
    }
}

/// Load existing device id, or generate + persist a new one on first call.
pub fn ensure_device_id(app: &AppHandle) -> String {
    let path = device_path(app);
    if let Ok(s) = std::fs::read_to_string(&path) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = format!(
        "{}-{}-{}",
        os_label(),
        hostname_sanitized(),
        random_suffix()
    );
    let _ = std::fs::write(&path, &id);
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_strips_non_alnum() {
        std::env::set_var("HOSTNAME", "junhey's MBP!");
        let h = hostname_sanitized();
        assert!(!h.is_empty());
        assert!(h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn random_suffix_is_six_alphanum() {
        let s = random_suffix();
        assert_eq!(s.len(), 6);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
