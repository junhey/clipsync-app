use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// Normalize text for hashing so the same logical content produces the same id
/// across platforms. Note the *raw* text the user copied is preserved in the
/// `ClipItem.text` field — only the hash input is normalized.
///
/// Transforms applied (idempotent):
/// - CRLF / CR line endings → LF (Windows ↔ macOS/Linux parity)
/// - Unicode Normalization Form C (NFC) — macOS sometimes hands back NFD for
///   accented characters and East-Asian IME output, which would otherwise
///   produce different byte sequences for visually identical text
fn normalize_for_hash(s: &str) -> String {
    let line_ending_unified = s.replace("\r\n", "\n").replace('\r', "\n");
    line_ending_unified.nfc().collect()
}

pub fn hash_text(s: &str) -> String {
    let normalized = normalize_for_hash(s);
    let mut h = Sha256::new();
    h.update(normalized.as_bytes());
    hex::encode(h.finalize())
}

pub fn hash_image_pixels(rgba: &[u8], width: u32, height: u32) -> String {
    let mut h = Sha256::new();
    h.update(rgba);
    h.update(&width.to_le_bytes());
    h.update(&height.to_le_bytes());
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_hash_is_deterministic() {
        assert_eq!(hash_text("hello"), hash_text("hello"));
        assert_ne!(hash_text("hello"), hash_text("Hello"));
    }

    #[test]
    fn empty_text_hash_is_known_constant() {
        // SHA-256 of empty string
        assert_eq!(
            hash_text(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn crlf_and_lf_collapse_to_same_hash() {
        // The cross-platform sync win: Windows-copied `hello\r\nworld` and
        // mac/linux-copied `hello\nworld` now share an id.
        assert_eq!(hash_text("hello\r\nworld"), hash_text("hello\nworld"));
        assert_eq!(hash_text("a\rb"), hash_text("a\nb"));
    }

    #[test]
    fn nfd_and_nfc_collapse_to_same_hash() {
        // "é" can be encoded as U+00E9 (NFC) or U+0065 U+0301 (NFD); macOS
        // pasteboards sometimes hand back NFD. Both should match now.
        let nfc = "café";
        let nfd = "cafe\u{0301}";
        assert_eq!(hash_text(nfc), hash_text(nfd));
    }

    #[test]
    fn image_hash_changes_with_dimensions() {
        let pixels = vec![255_u8; 16 * 16 * 4];
        let h_a = hash_image_pixels(&pixels, 16, 16);
        let h_b = hash_image_pixels(&pixels, 8, 32); // same bytes, different shape
        assert_ne!(h_a, h_b);
    }

    #[test]
    fn image_hash_is_pixel_stable() {
        let pixels = vec![10_u8; 4 * 4 * 4];
        assert_eq!(
            hash_image_pixels(&pixels, 4, 4),
            hash_image_pixels(&pixels, 4, 4)
        );
    }
}
