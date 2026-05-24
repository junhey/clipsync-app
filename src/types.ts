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
  /** Ignore values from these app bundle ids (e.g. password managers). */
  ignoreSources: string[];
  /** Auto-paste after picking a history item (needs Accessibility permission on macOS). */
  pasteOnPick: boolean;
  /** Launch the app at OS login. */
  autostart: boolean;
  /** True after the user has been shown the first-run onboarding. */
  onboardingShown: boolean;
  /** Where the app shows itself: menubar-only / dock-only / both. */
  presentationMode: PresentationMode;
  sync: SyncSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxItems: 200,
  hotkey: "CommandOrControl+Shift+V",
  ignoreSources: [
    "com.agilebits.onepassword*",
    "com.lastpass.LastPass",
    "org.keepassxc.keepassxc",
    "com.bitwarden.desktop",
  ],
  pasteOnPick: false,
  autostart: false,
  onboardingShown: false,
  presentationMode: "menubar",
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
    };
