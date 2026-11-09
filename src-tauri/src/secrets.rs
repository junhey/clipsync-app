use keyring::Entry;
use parking_lot::RwLock;
use std::sync::OnceLock;

const SERVICE: &str = "ClipSync";
const ACCOUNT: &str = "github_pat";

/// Process-wide cache of the GitHub PAT.
///
/// Why: macOS Keychain enforces an ACL check on **every** access by an
/// unknown / changed binary. In dev mode, every hot-reload re-signs the
/// binary so the OS asks "allow clipsync to use ClipSync keychain item?"
/// once per `get_token` call. The sync timer fires every 60s and the watcher
/// can fire on any clipboard write, which is what stacks dozens of authz
/// prompts on top of each other. Caching the secret in process memory means
/// we hit the Keychain at most once per launch — production builds with a
/// stable signature also benefit by skipping the system call.
///
/// Layout: `OnceLock<RwLock<Option<String>>>`.
///   - `None` (never accessed): not yet looked up; next `get_token` will
///     hit the keychain and seed the cache.
///   - `Some(None)`: we tried and the keychain has no value (or denied us).
///     Subsequent reads short-circuit so we don't ask again this session.
///   - `Some(Some(token))`: cached PAT.
fn cache() -> &'static RwLock<Option<Option<String>>> {
    static C: OnceLock<RwLock<Option<Option<String>>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(None))
}

pub fn set_token(token: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    if token.is_empty() {
        // Treat empty as delete to avoid storing empty strings.
        let _ = entry.delete_credential();
        *cache().write() = Some(None);
        return Ok(());
    }
    entry.set_password(token).map_err(|e| e.to_string())?;
    *cache().write() = Some(Some(token.to_string()));
    Ok(())
}

pub fn get_token() -> Option<String> {
    if let Some(cached) = cache().read().as_ref() {
        return cached.clone();
    }
    // Cache miss — actually hit the keychain.
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    let value = entry.get_password().ok();
    *cache().write() = Some(value.clone());
    value
}

pub fn clear_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())?;
    *cache().write() = Some(None);
    Ok(())
}

/// Force the next `get_token` call to re-read from the keychain. Useful
/// after an external change (e.g. the user replaced the token via Keychain
/// Access) so the running process picks it up without restarting.
#[allow(dead_code)]
pub fn invalidate_cache() {
    *cache().write() = None;
}
