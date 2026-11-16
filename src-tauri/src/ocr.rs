//! Image OCR.
//!
//! macOS runs Vision's text recognizer on the PNG we just stored. Other
//! platforms expose the same entry points as no-ops so the clipboard watcher
//! can call them without a cfg at every site.

use crate::state::ClipItem;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::AppHandle;

/// Hard cap on recognized text stored on a single item.
pub const OCR_TEXT_MAX_CHARS: usize = 4000;

/// Join recognized lines with `\n`, dropping blank lines, and cap the result
/// at [`OCR_TEXT_MAX_CHARS`]. Whitespace-only input yields `None`.
pub fn join_ocr_lines<I, S>(lines: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = String::new();
    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() {
            continue;
        }
        let sep = if out.is_empty() { 0 } else { 1 };
        let remaining = OCR_TEXT_MAX_CHARS.saturating_sub(out.chars().count());
        if remaining <= sep {
            break;
        }
        let chunk: String = line.chars().take(remaining - sep).collect();
        if chunk.is_empty() {
            break;
        }
        if sep == 1 {
            out.push('\n');
        }
        out.push_str(&chunk);
        if chunk.chars().count() < line.chars().count() {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Recognize text in PNG bytes. Empty or failed recognition returns `None`
/// and never panics.
pub fn recognize_png(png: &[u8]) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        recognize_png_macos(png)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = png;
        None
    }
}

/// Read the item's PNG on a background thread and, when recognition returns
/// text, write `ocr_text` and emit `history:updated`.
pub fn spawn_image_ocr(app: AppHandle, history: Arc<Mutex<Vec<ClipItem>>>, id: String) {
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || {
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Err(err) = store_ocr(&app, &history, &id) {
                    eprintln!("clipsync: ocr skipped for {id}: {err}");
                }
            }))
            .is_err();
            if panicked {
                eprintln!("clipsync: ocr thread panicked for {id}");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, history, id);
    }
}

#[cfg(target_os = "macos")]
fn store_ocr(app: &AppHandle, history: &Arc<Mutex<Vec<ClipItem>>>, id: &str) -> Result<(), String> {
    use crate::storage::{read_image_blob, write_history_to_disk};
    use tauri::Emitter;

    let png = read_image_blob(app, id)?;
    let Some(text) = recognize_png(&png) else {
        return Ok(());
    };
    let snapshot = {
        let mut hist = history.lock();
        let Some(item) = hist.iter_mut().find(|it| it.id == id) else {
            // Deleted while recognition was running.
            return Ok(());
        };
        if item.ocr_text.as_deref() == Some(text.as_str()) {
            return Ok(());
        }
        item.ocr_text = Some(text);
        hist.clone()
    };
    write_history_to_disk(app, &snapshot);
    let _ = app.emit("history:updated", &snapshot);
    Ok(())
}

#[cfg(target_os = "macos")]
fn recognize_png_macos(png: &[u8]) -> Option<String> {
    if png.is_empty() {
        return None;
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        objc2::rc::autoreleasepool(|_| recognize_png_vision(png))
    })) {
        Ok(text) => text,
        Err(_) => None,
    }
}

#[cfg(target_os = "macos")]
fn recognize_png_vision(png: &[u8]) -> Option<String> {
    use objc2::runtime::AnyObject;
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };
    use std::ffi::c_void;

    let data = unsafe { NSData::dataWithBytes_length(png.as_ptr() as *const c_void, png.len()) };
    // `VNImageOption` is an `NSString` alias. An empty dictionary means
    // "no camera intrinsics or other hints".
    let keys: &[&NSString] = &[];
    let values: &[&AnyObject] = &[];
    let options = NSDictionary::from_slices(keys, values);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );

    let request = unsafe { VNRecognizeTextRequest::init(VNRecognizeTextRequest::alloc()) };
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let languages =
        NSArray::from_retained_slice(&[NSString::from_str("zh-Hans"), NSString::from_str("en-US")]);
    request.setRecognitionLanguages(&languages);
    request.setUsesLanguageCorrection(true);

    let request_ref: &VNRequest = request.as_ref();
    let requests = NSArray::from_slice(&[request_ref]);
    if handler.performRequests_error(&requests).is_err() {
        return None;
    }

    let observations = request.results()?;
    let mut lines: Vec<(i64, i64, String)> = Vec::new();
    let count = observations.count();
    for i in 0..count {
        let obs = observations.objectAtIndex(i);
        let candidates = obs.topCandidates(1);
        if candidates.count() == 0 {
            continue;
        }
        let best = candidates.objectAtIndex(0);
        let text = best.string().to_string();
        if text.trim().is_empty() {
            continue;
        }
        // Vision boxes are normalized with the origin at the lower-left.
        // Sort top-to-bottom, then left-to-right, so the joined lines read
        // in visual order.
        let rect = unsafe { obs.boundingBox() };
        let top = rect.origin.y + rect.size.height;
        let y_key = (-top * 10_000.0).round() as i64;
        let x_key = (rect.origin.x * 10_000.0).round() as i64;
        lines.push((y_key, x_key, text));
    }
    lines.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    join_ocr_lines(lines.into_iter().map(|(_, _, text)| text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_lines_and_skips_blank() {
        let got = join_ocr_lines(["Hello", "  ", "世界"]).unwrap();
        assert_eq!(got, "Hello\n世界");
    }

    #[test]
    fn empty_input_is_none() {
        assert!(join_ocr_lines(["", "   "]).is_none());
        assert!(join_ocr_lines(Vec::<String>::new()).is_none());
    }

    #[test]
    fn caps_at_4000_chars() {
        let long = "字".repeat(5000);
        let got = join_ocr_lines([long.as_str()]).unwrap();
        assert_eq!(got.chars().count(), OCR_TEXT_MAX_CHARS);
        assert!(got.chars().all(|c| c == '字'));
    }

    #[test]
    fn cap_keeps_a_separator_when_the_next_line_still_fits() {
        let first = "a".repeat(3998);
        let got = join_ocr_lines([first.as_str(), "xyz"]).unwrap();
        assert_eq!(got.chars().count(), OCR_TEXT_MAX_CHARS);
        assert!(got.ends_with("\nx"));
    }

    #[test]
    fn invalid_png_does_not_panic() {
        assert!(recognize_png(b"not a png").is_none());
        assert!(recognize_png(b"").is_none());
    }
}
