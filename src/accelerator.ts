/**
 * Accelerator <-> KeyboardEvent helpers.
 *
 * Tauri's accelerator format is the source of truth (e.g. "CommandOrControl+Shift+E").
 * We use the same vocabulary for in-popup shortcuts even though they aren't
 * registered globally — keeps storage consistent with the main hotkey, and
 * lets future code re-use the same string for either purpose.
 */

const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export interface ParsedAccelerator {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercased main key, e.g. "e", "v", "f1", "arrowdown". */
  key: string;
}

/**
 * Parse a Tauri accelerator string into a normalised modifier set.
 * Returns null for empty / invalid input — callers should treat that as
 * "shortcut disabled".
 */
export function parseAccelerator(s: string | null | undefined): ParsedAccelerator | null {
  if (!s) return null;
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: ParsedAccelerator = {
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: "",
  };
  for (const p of parts) {
    const lc = p.toLowerCase();
    switch (lc) {
      case "cmd":
      case "command":
      case "super":
        out.meta = true;
        break;
      case "ctrl":
      case "control":
        out.ctrl = true;
        break;
      // CommandOrControl / CmdOrCtrl: meta on macOS, ctrl elsewhere — we
      // accept either modifier at match time, so set both flags here and
      // let the matcher accept (meta || ctrl) when both are set.
      case "cmdorctrl":
      case "commandorcontrol":
        if (IS_MAC) out.meta = true;
        else out.ctrl = true;
        break;
      case "alt":
      case "option":
      case "opt":
        out.alt = true;
        break;
      case "shift":
        out.shift = true;
        break;
      default:
        out.key = lc;
    }
  }
  return out.key ? out : null;
}

/**
 * Render a parsed accelerator back into a human-friendly string.
 * macOS uses the standard glyph row (⌃⌥⇧⌘); other platforms use words.
 */
export function formatAccelerator(p: ParsedAccelerator | null): string {
  if (!p) return "";
  const parts: string[] = [];
  if (IS_MAC) {
    if (p.ctrl) parts.push("⌃");
    if (p.alt) parts.push("⌥");
    if (p.shift) parts.push("⇧");
    if (p.meta) parts.push("⌘");
    parts.push(formatKeyForDisplay(p.key));
    return parts.join("");
  } else {
    if (p.ctrl) parts.push("Ctrl");
    if (p.alt) parts.push("Alt");
    if (p.shift) parts.push("Shift");
    if (p.meta) parts.push("Win");
    parts.push(formatKeyForDisplay(p.key).toUpperCase());
    return parts.join("+");
  }
}

function formatKeyForDisplay(key: string): string {
  // Special cases we want to render with a glyph or pretty word.
  switch (key) {
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "arrowleft":
      return "←";
    case "arrowright":
      return "→";
    case " ":
    case "space":
      return "Space";
    case "escape":
      return "Esc";
    case "enter":
    case "return":
      return "↵";
    case "backspace":
      return "⌫";
    case "delete":
      return "⌦";
    case "tab":
      return "⇥";
  }
  return key.length === 1 ? key.toUpperCase() : capitalise(key);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Test whether a keyboard event matches a stored accelerator string.
 * Treats `CommandOrControl` as "either meta or ctrl OK", which is the
 * same behaviour the user sees from the global hotkey.
 */
export function matchesAccelerator(
  e: KeyboardEvent | React.KeyboardEvent,
  accel: string | null | undefined
): boolean {
  const p = parseAccelerator(accel);
  if (!p) return false;
  // Modifier presence on the event.
  const eMeta = (e as KeyboardEvent).metaKey;
  const eCtrl = (e as KeyboardEvent).ctrlKey;
  const eAlt = (e as KeyboardEvent).altKey;
  const eShift = (e as KeyboardEvent).shiftKey;

  // CommandOrControl: at parse time we set whichever of meta/ctrl matches
  // the platform. Here we *also* accept the other one — many users hit
  // Ctrl+E on macOS by muscle memory and it should still work.
  const wantsMeta = p.meta;
  const wantsCtrl = p.ctrl;
  const cmdOrCtrlOk = (wantsMeta && eMeta) || (wantsCtrl && eCtrl);
  if (wantsMeta || wantsCtrl) {
    if (!cmdOrCtrlOk) return false;
  } else if (eMeta || eCtrl) {
    // Shortcut doesn't ask for any cmd/ctrl modifier — reject events
    // that have one (otherwise plain "E" would fire on every ⌘E, ⌃E, …).
    return false;
  }
  if (p.alt !== eAlt) return false;
  if (p.shift !== eShift) return false;

  return e.key.toLowerCase() === p.key;
}

/**
 * Build an accelerator string from a keyboard event the user just pressed
 * — used by the recorder UI in Settings. Returns "" for events that are
 * pure modifier presses (no main key yet).
 */
export function eventToAccelerator(e: KeyboardEvent | React.KeyboardEvent): string {
  const k = e.key;
  if (!k || k === "Meta" || k === "Control" || k === "Alt" || k === "Shift") {
    return "";
  }
  const parts: string[] = [];
  // Prefer "CommandOrControl" when both meta and ctrl are unset and we
  // have just one of them — keeps the recorded shortcut portable across
  // macOS / Windows. We only emit a literal "Cmd" or "Ctrl" if the user
  // explicitly used the *other* one of the pair.
  const eMeta = (e as KeyboardEvent).metaKey;
  const eCtrl = (e as KeyboardEvent).ctrlKey;
  if (eMeta && eCtrl) {
    parts.push("Control");
    parts.push("Command");
  } else if (eMeta && IS_MAC) {
    parts.push("CommandOrControl");
  } else if (eCtrl && !IS_MAC) {
    parts.push("CommandOrControl");
  } else if (eMeta) {
    parts.push("Command");
  } else if (eCtrl) {
    parts.push("Control");
  }
  if ((e as KeyboardEvent).altKey) parts.push("Alt");
  if ((e as KeyboardEvent).shiftKey) parts.push("Shift");

  // Normalise the main key to a Tauri-friendly form. Single-char keys
  // become uppercase; named keys keep their KeyboardEvent.key value.
  let main = k;
  if (main.length === 1) {
    main = main.toUpperCase();
  }
  parts.push(main);
  return parts.join("+");
}

/** Pretty-print an accelerator string directly. */
export function prettyAccelerator(s: string | null | undefined): string {
  return formatAccelerator(parseAccelerator(s));
}
