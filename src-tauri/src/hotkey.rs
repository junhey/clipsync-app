use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub fn parse_accelerator(s: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut key: Option<Code> = None;
    for part in s.split('+') {
        match part.trim() {
            "Cmd" | "Command" | "Super" | "Meta" => mods |= Modifiers::SUPER,
            "Ctrl" | "Control" => mods |= Modifiers::CONTROL,
            "CommandOrControl" | "CmdOrCtrl" => {
                #[cfg(target_os = "macos")]
                {
                    mods |= Modifiers::SUPER;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    mods |= Modifiers::CONTROL;
                }
            }
            "Alt" | "Option" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            other => {
                if other.len() == 1 {
                    let c = other.chars().next().unwrap().to_ascii_uppercase();
                    key = match c {
                        'A'..='Z' => Some(letter_code(c)),
                        '0'..='9' => Some(digit_code(c)),
                        _ => None,
                    };
                }
            }
        }
    }
    key.map(|k| Shortcut::new(Some(mods), k))
}

fn letter_code(c: char) -> Code {
    match c {
        'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
        'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
        'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
        'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
        'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
        'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
        'Y' => Code::KeyY, 'Z' => Code::KeyZ,
        _ => Code::KeyV,
    }
}

fn digit_code(c: char) -> Code {
    match c {
        '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2, '3' => Code::Digit3,
        '4' => Code::Digit4, '5' => Code::Digit5, '6' => Code::Digit6, '7' => Code::Digit7,
        '8' => Code::Digit8, '9' => Code::Digit9,
        _ => Code::Digit1,
    }
}
