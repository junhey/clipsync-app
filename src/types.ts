export type ClipKind = "text" | "image" | "files";

export interface ClipItem {
  /** SHA-256 of the content body — also used to dedupe. */
  id: string;
  kind: ClipKind;
  /** Plain-text body (or a short marker for non-text kinds). */
  text: string;
  /** First seen timestamp (ms). */
  createdAt: number;
  /** Last seen timestamp (ms) — updated when the same content reappears. */
  updatedAt: number;
  /** Times this item has been re-copied. */
  hits: number;
  pinned?: boolean;
  /** Source app bundle id, if known. */
  source?: string;
  /** Origin device for cross-device sync conflict hints. */
  device?: string;
  // Image-only metadata (kind === "image")
  width?: number;
  height?: number;
  bytes?: number;
  format?: "png";
  /** macOS Vision OCR of a screenshot, possibly multi-line. Only set on
   * image items, and only after the local recognizer finishes. */
  ocrText?: string;
}

export type StorageBackend = "local" | "gist" | "repo";

export interface SyncSettings {
  backend: StorageBackend;
  /** For backend = "gist": gist id. Empty -> auto-create on first push. */
  gistId?: string;
  /** For backend = "repo": owner/repo. */
  repo?: string;
  /** For backend = "repo": branch (default: data). */
  branch?: string;
  /** For backend = "repo": file path inside the repo (default: history.json). */
  path?: string;
  /** Auto sync interval in seconds. 0 disables auto sync. */
  intervalSec: number;
  /** Whether to push immediately after each new clip. */
  pushOnChange: boolean;
}

export type PresentationMode = "menubar" | "dock" | "both";

export interface AppSettings {
  /** Max number of items to keep in history. */
  maxItems: number;
  /** Global hotkey to open the popup, accelerator string. */
  hotkey: string;
  /** In-popup shortcut to open the snippet editor window — accelerator
   * string scoped to the popup webview only (not registered globally),
   * so empty string disables it without affecting other apps. */
  popupEditorShortcut: string;
  /** Ignore values from these app bundle ids (e.g. password managers). */
  ignoreSources: string[];
  /** 2 after Windows process names were merged into a saved ignore list. */
  ignoreSourcesV?: number;
  /** Launch the app at OS login. */
  autostart: boolean;
  /** True after the user has been shown the first-run onboarding. */
  onboardingShown: boolean;
  /** Where the app shows itself: menubar-only / dock-only / both. */
  presentationMode: PresentationMode;
  /** Pick copies the item and then synthesizes Cmd/Ctrl+V. Off = copy only. */
  pasteOnPick: boolean;
  sync: SyncSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxItems: 200,
  hotkey: "CommandOrControl+Shift+V",
  popupEditorShortcut: "CommandOrControl+E",
  ignoreSources: [
    "com.agilebits.onepassword*",
    "com.lastpass.LastPass",
    "org.keepassxc.keepassxc",
    "com.bitwarden.desktop",
    "1Password*",
    "AgileBits.1Password*",
    "LastPass*",
    "KeePass*",
    "Bitwarden*",
  ],
  autostart: false,
  onboardingShown: false,
  presentationMode: "menubar",
  pasteOnPick: true,
  sync: {
    backend: "repo",
    intervalSec: 60,
    pushOnChange: false,
    branch: "data",
    path: "history.json",
  },
};

export interface HistoryFile {
  version: 1;
  device: string;
  updatedAt: number;
  items: ClipItem[];
}

/**
 * Snippet tree node — either a Folder (with children) or a Snippet (leaf).
 * Mirrors `crate::snippets::SnippetNode` on the Rust side. Serde uses an
 * internally-tagged enum keyed by `kind`.
 */
export type SnippetNode =
  | {
      kind: "folder";
      id: string;
      name: string;
      children: SnippetNode[];
    }
  | {
      kind: "snippet";
      id: string;
      name: string;
      content: string;
      enabled: boolean;
      createdAt: number;
      updatedAt: number;
      /**
       * Catalog id this snippet was imported from. Omitted when the user
       * creates a snippet locally. Save paths must pass the field through:
       * dropping it makes the next import insert a second copy.
       */
      sourceId?: string;
    };

/** One shared snippet in the catalog served to the market view. */
export interface CatalogSnippet {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  author: string;
  content: string;
}

export interface CatalogCategory {
  id: string;
  name: string;
  blurb: string;
  snippets: CatalogSnippet[];
}

/** Ciphertext for one private share. Name and content stay inside `data`. */
export interface SealedEntry {
  id: string;
  v: number;
  salt: string;
  iv: string;
  data: string;
}

/**
 * `source` is set by the desktop command. The static file used in the web
 * preview has no source, which means "this is just the file on disk".
 * `sealed` lists private shares. Their plaintext is not in this payload.
 */
export interface CatalogPayload {
  version: number;
  categories: CatalogCategory[];
  sealed?: SealedEntry[];
  source?: "remote" | "bundled";
}
