# ClipSync

> A cross-platform clipboard manager that lives in your menu bar — and syncs through **your own GitHub**. Your data stays yours.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/junhey/clipsync-app)](https://github.com/junhey/clipsync-app/releases/latest)
[![Website](https://img.shields.io/badge/website-clipsync--app-blue)](https://junhey.github.io/clipsync-app/)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131)

**[简体中文文档](README.zh-CN.md)** · **[Website & Download](https://junhey.github.io/clipsync-app/)**

## Features

- 📋 **Clipboard history** — text and images captured automatically, newest first, deduped and merged
- 🔍 **Instant search** — invoke with one hotkey, type to filter; on macOS even text *inside* screenshots is searchable (on-device OCR, nothing leaves your machine)
- ⚡ **Paste straight back** — pick an entry and it's pasted into the app you came from; or switch to copy-only mode
- ⌨️ **Keyboard-first** — `⌘/Ctrl+1-9` to paste the Nth item, direct-paste hotkeys (`⌘⇧⌥1-9`) that skip the popup entirely, `Tab` to switch tabs, `Esc` to dismiss
- 📝 **Snippets** — keep reusable replies, addresses and templates in a folder tree; a dedicated editor window, per-snippet enable/disable, JSON import/export
- 🎁 **Shared snippets** — a market of ready-to-paste snippets. Public ones are readable by anyone. Private ones are stored as ciphertext and open only with a key the sharer keeps; that key is never written into the repo. The catalog files are not part of the public source mirror. Import lands in a local folder named 来自分享. Sharing opens a GitHub issue: a public submission includes the text, a private one includes only the sealed blob
- ☁️ **Sync on your terms** — private Gist, a private repo branch, or local-only. Your PAT lives in the OS keychain, never in a file
- 🔐 **Privacy by default** — password managers (1Password / LastPass / KeePassXC / Bitwarden) are blocked out of the box; custom per-app ignore rules
- 🪶 **Featherweight** — ~5 MB bundle, native dark mode, near-zero CPU when idle (adaptive polling 0.6 s → 3 s)
- 🖥️ **Truly cross-platform** — one codebase for macOS, Windows and Linux, built on Tauri 2

## Install

**macOS — one line:**

```bash
curl -fsSL https://junhey.github.io/clipsync-app/install.sh | bash
```

**Manual:** download `ClipSync_*_aarch64.app.tar.gz` from [Releases](https://github.com/junhey/clipsync-app/releases/latest), drag to `/Applications`, then once:

```bash
xattr -dr com.apple.quarantine /Applications/ClipSync.app
```

**Build from source** (Rust 1.77+, Node 20+):

```bash
git clone https://github.com/junhey/clipsync-app.git
cd clipsync-app
npm install
npm run tauri:build   # bundles land in src-tauri/target/release/bundle/
```

Pushing a `v*` tag to the public repo (or running the Release workflow by hand) builds macOS and Windows installers in GitHub Actions and uploads them to a draft release. Until that draft is published, the download page still serves the macOS build that is already released. Linux stays a source build. The Windows installer is unsigned, so SmartScreen may warn about an unknown publisher.

## Default shortcuts

| Action | macOS | Windows |
|---|---|---|
| Toggle popup | `⌘⇧V` | `Ctrl+Alt+V` (falls back to `Ctrl+Shift+V` if taken) |
| Paste item 1–9 | `⌘1-9` | `Ctrl+1-9` |
| Direct-paste Nth item (no popup) | `⌘⇧⌥1-9` | `Ctrl+Shift+Alt+1-9` |
| Pin / unpin | `⌘P` | `Ctrl+P` |
| Switch History / Snippets | `Tab` | `Tab` |
| Snippet editor | `⌘E` | `Ctrl+E` |
| Clear search → hide | `Esc` | `Esc` |

All shortcuts are remappable in Settings.

## Sync model

| Backend | Best for | Storage |
|---|---|---|
| `repo` (default) | Version history, integrating with other tools | `history.json` on the `data` branch of `<you>/clipsync` |
| `gist` | Single user, multiple devices | `history.json` inside a private Gist |
| `local` | Fully offline | `app_data_dir/history.json` only |

Merge strategy: newest `updatedAt` wins; pins are unioned; hit counts add up; pinned items survive when `maxItems` trims the list. Images are stored as content-addressed blobs — identical screenshots never take double space, and the `data` branch is force-pushed as a single root commit so the repo never grows beyond your current history.

To enable sync: paste a fine-grained PAT into **Settings → Sync** and press 「检查连接」. An empty repo field uses `<your login>/clipsync` and creates that private repo when it is missing. A repo name you typed yourself is never created for you. Gist sync needs the id of a private Gist that already exists. The token is stored in macOS Keychain / Windows Credential Manager. A failed check stays in Settings and says whether the problem is the PAT, its permissions, the repo, or the network.

## Privacy

- Clipboard contents live on your machine and (optionally) your own GitHub — nowhere else
- Source-app blacklist with `*` wildcards; password managers blocked by default (macOS)
- Screenshot OCR runs entirely on-device via the OS vision framework (macOS)
- `local` backend works completely offline

## Development

```bash
npm install
npm run tauri:dev     # run the desktop app with hot reload
npm run test          # frontend unit tests (vitest)
cd src-tauri && cargo test   # backend unit tests
```

```
clipsync/
├── src/                # React frontend
│   ├── App.tsx         # main popup: history, search, settings
│   ├── SnippetsApp.tsx # snippet editor window
│   ├── bridge.ts       # JS ↔ Rust IPC boundary
│   └── sync.ts         # GitHub sync logic (browser fallback)
├── src-tauri/          # Rust backend
│   └── src/            # clipboard watcher, tray, hotkeys, sync, OCR, storage
├── docs/pages/         # project website (GitHub Pages)
└── openspec/           # spec-driven development workflow (OpenSpec)
```

Spec-driven changes live in `openspec/` — see `openspec/AGENTS.md` for the workflow.

## License

[MIT](LICENSE) © 2026 junhey
