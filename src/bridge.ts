import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClipItem, SnippetNode } from "./types";

/**
 * Tauri command bridge. The Rust side owns the canonical history; the JS side
 * is a thin reactive view over it. This file is the only place that knows the
 * command names, so refactors stay small.
 */
export const bridge = {
  async loadHistory(): Promise<ClipItem[]> {
    return await invoke<ClipItem[]>("load_history");
  },
  async saveHistory(items: ClipItem[]): Promise<void> {
    await invoke("save_history", { items });
  },
  async copyToClipboard(item: ClipItem): Promise<void> {
    await invoke("copy_to_clipboard", { item });
  },
  async readBlob(id: string): Promise<string> {
    return await invoke<string>("read_blob", { id });
  },
  async deleteItem(id: string): Promise<void> {
    await invoke("delete_item", { id });
  },
  async hidePopup(): Promise<void> {
    await invoke("hide_popup");
  },

  // ── Hotkey ──────────────────────────────────────────────────────────────
  async setHotkey(accelerator: string): Promise<void> {
    await invoke("set_hotkey", { accelerator });
  },

  // ── Secrets (PAT in OS keychain) ────────────────────────────────────────
  async setToken(token: string): Promise<void> {
    await invoke("set_token", { token });
  },
  async getToken(): Promise<string | null> {
    return (await invoke<string | null>("get_token")) ?? null;
  },
  async clearToken(): Promise<void> {
    await invoke("clear_token");
  },

  // ── Privacy ─────────────────────────────────────────────────────────────
  async setIgnoreSources(patterns: string[]): Promise<void> {
    await invoke("set_ignore_sources", { patterns });
  },

  // ── Sync (Rust-side, keeps working while popup is hidden) ───────────────
  async setSyncSettings(
    settings: unknown,
    device: string,
    maxItems: number
  ): Promise<void> {
    await invoke("set_sync_settings", { settings, device, maxItems });
  },
  async syncNow(): Promise<void> {
    await invoke("sync_now");
  },
  async migrateFromGist(): Promise<number> {
    return await invoke<number>("migrate_from_gist");
  },

  // ── Paste on pick ───────────────────────────────────────────────────────
  async simulatePaste(): Promise<void> {
    await invoke("simulate_paste");
  },
  async openAccessibilitySettings(): Promise<void> {
    await invoke("open_accessibility_settings");
  },

  // ── Presentation mode (Dock + menubar visibility) ───────────────────────
  async setPresentationMode(mode: "menubar" | "dock" | "both"): Promise<void> {
    await invoke("set_presentation_mode", { mode });
  },

  // ── Snippets ────────────────────────────────────────────────────────────
  async listSnippets(): Promise<SnippetNode[]> {
    return await invoke<SnippetNode[]>("list_snippets");
  },
  async saveSnippets(nodes: SnippetNode[]): Promise<void> {
    await invoke("save_snippets", { nodes });
  },
  async deleteSnippet(id: string): Promise<void> {
    await invoke("delete_snippet", { id });
  },
  async toggleSnippet(id: string): Promise<void> {
    await invoke("toggle_snippet", { id });
  },
  async useSnippet(id: string): Promise<void> {
    await invoke("use_snippet", { id });
  },
  async openSnippetsWindow(): Promise<void> {
    await invoke("open_snippets_window");
  },
  async importSnippets(text: string): Promise<number> {
    return await invoke<number>("import_snippets", { text });
  },
  async exportSnippets(): Promise<string> {
    return await invoke<string>("export_snippets");
  },
  onSnippetsUpdated(cb: (nodes: SnippetNode[]) => void) {
    return listen<SnippetNode[]>("snippets:updated", (e) => cb(e.payload));
  },

  // ── Events ──────────────────────────────────────────────────────────────
  onClipboardChange(cb: (item: ClipItem) => void) {
    return listen<ClipItem>("clipboard:new", (e) => cb(e.payload));
  },
  onHotkeyToggle(cb: () => void) {
    return listen("popup:toggle", () => cb());
  },
  onHistoryUpdated(cb: (items: ClipItem[]) => void) {
    return listen<ClipItem[]>("history:updated", (e) => cb(e.payload));
  },
  onSyncStatus(cb: (s: { phase: string; at?: number }) => void) {
    return listen<{ phase: string; at?: number }>("sync:status", (e) => cb(e.payload));
  },
};
