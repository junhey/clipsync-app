use sha2::{Digest, Sha256};

pub fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
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
