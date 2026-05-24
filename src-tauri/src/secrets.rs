use keyring::Entry;

const SERVICE: &str = "ClipSync";
const ACCOUNT: &str = "github_pat";

pub fn set_token(token: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    if token.is_empty() {
        // Treat empty as delete to avoid storing empty strings.
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(token).map_err(|e| e.to_string())
}

pub fn get_token() -> Option<String> {
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    entry.get_password().ok()
}

pub fn clear_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())
}
