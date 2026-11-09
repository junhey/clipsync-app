import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useStore } from "./store";
import { bridge } from "./bridge";
import { fetchRemote, mergeHistory, pushRemote } from "./sync";
import type { AppSettings, ClipItem, SnippetNode } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import {
  eventToAccelerator,
  matchesAccelerator,
  prettyAccelerator,
} from "./accelerator";
import { getVersion } from "@tauri-apps/api/app";
import Market from "./Market";

const SETTINGS_KEY = "clipsync.settings";
const DEVICE_KEY = "clipsync.device";

/// Platform-aware modifier glyph used in UI labels. Detects mac via
/// `navigator.platform` (still the most reliable signal in webviews — the
/// newer `navigator.userAgentData` isn't always populated).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const IS_WINDOWS =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
/// Registered when the user's chosen hotkey is rejected by the OS.
const FALLBACK_HOTKEY = "CommandOrControl+Shift+V";
/// Focus has to land back on the previously active app before the synthetic
/// Cmd/Ctrl+V, otherwise the keystroke is delivered into this webview.
const PASTE_DELAY_MS = 80;
/// Helper: `mod("V")` → `⌘V` on mac, `Ctrl+V` on Win.
function mod(suffix: string): string {
  return IS_MAC ? `⌘${suffix}` : `Ctrl+${suffix}`;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppSettings & {
        sync?: { token?: string };
        _schemaVersion?: unknown;
      };
      // One-time migration: PAT used to live here, now goes to OS keychain.
      if (parsed?.sync?.token) {
        delete parsed.sync.token;
      }
      // Drop the pre-v0.10 schema stamp. pasteOnPick is a live setting
      // again — stripping it here wiped the user's choice on every launch.
      delete (parsed as any)._schemaVersion;
      let ignoreSources = Array.isArray(parsed.ignoreSources)
        ? [...parsed.ignoreSources]
        : [...DEFAULT_SETTINGS.ignoreSources];
      let ignoreSourcesV = parsed.ignoreSourcesV ?? 1;
      if (ignoreSourcesV < 2) {
        for (const name of [
          "1Password*",
          "AgileBits.1Password*",
          "LastPass*",
          "KeePass*",
          "Bitwarden*",
        ]) {
          if (!ignoreSources.includes(name)) ignoreSources.push(name);
        }
        ignoreSourcesV = 2;
      }
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        ignoreSources,
        ignoreSourcesV,
        sync: { ...DEFAULT_SETTINGS.sync, ...parsed.sync },
      };
    }
  } catch {
    /* ignore */
  }
  return freshSettings();
}

/// No saved settings at all (or the blob was unreadable). Ctrl+Shift and
/// Alt+Shift are eaten by the IME / layout switcher on Chinese Windows, so
/// a first launch there uses Ctrl+Alt+V. macOS keeps ⌘⇧V.
function freshSettings(): AppSettings {
  if (IS_WINDOWS) {
    return { ...DEFAULT_SETTINGS, hotkey: "Control+Alt+V" };
  }
  return DEFAULT_SETTINGS;
}

/**
 * If a token was previously stored in localStorage (v0.2 and earlier), move
 * it into the OS keyring and wipe the local copy. Returns true if a migration
 * happened so callers can refresh in-memory state.
 */
async function migrateTokenIfAny(): Promise<void> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const legacyToken: string | undefined = parsed?.sync?.token;
    if (legacyToken) {
      await bridge.setToken(legacyToken);
      delete parsed.sync.token;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
  } catch {
    /* ignore */
  }
}

/// Returns a per-machine identifier for sync. Prefers the backend-managed
/// stable id (persisted as <app_data_dir>/device-id, format
/// `<os>-<hostname>-<random6>`); falls back to a localStorage random value
/// only in non-Tauri contexts (e.g. running the bare web app in dev).
async function resolveDeviceId(tauriAvailable: boolean): Promise<string> {
  if (tauriAvailable) {
    try {
      const id = await bridge.getDeviceId();
      if (id && id.length > 0) {
        localStorage.setItem(DEVICE_KEY, id); // mirror for any sync-side reads
        return id;
      }
    } catch {
      // fall through to local fallback
    }
  }
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) {
    d = `${navigator.platform || "device"}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    localStorage.setItem(DEVICE_KEY, d);
  }
  return d;
}

export default function App() {
  const {
    items,
    query,
    activeIndex,
    showSettings,
    settings,
    syncStatus,
    syncMessage,
    setItems,
    upsertItem,
    removeItem,
    togglePin,
    setQuery,
    setActiveIndex,
    setShowSettings,
    setSettings,
    setSyncStatus,
  } = useStore();

  const inputRef = useRef<HTMLInputElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  /**
   * Pretty-printed in-popup shortcut for the snippet editor (e.g. "⌘E"
   * on macOS, "Ctrl+E" on Windows). Empty string when the user has
   * disabled the shortcut in Settings — UI should hide its keybinding
   * hint in that case rather than showing an awkward bracketed "()".
   */
  const editorShortcutLabel = prettyAccelerator(settings.popupEditorShortcut);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [tab, setTab] = useState<"history" | "snippets" | "market">("history");
  const [snippets, setSnippets] = useState<SnippetNode[]>([]);
  const [booted, setBooted] = useState(false);
  /// Ticks so relative timestamps ("3 分钟前") don't freeze while the popup
  /// stays open. 10s is enough resolution for minute-scale labels.
  const [now, setNow] = useState(() => Date.now());
  const flatSnippets = useMemo(() => flattenSnippets(snippets), [snippets]);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  /// Timestamp of the most recent keyboard navigation (arrow keys / typing).
  /// `onMouseEnter` consults this so casual mouse drift across the list
  /// after a keyboard selection doesn't snatch `activeIndex` away from the
  /// user. The window is short (200ms) so intentional mouse use still wins.
  const lastKeyAt = useRef(0);

  /// Helper for switching tabs cleanly: also clears the query and resets the
  /// cursor, otherwise the list silently reshapes around stale search text
  /// from the previous tab. The market page keeps its own search field.
  function switchTab(next: "history" | "snippets" | "market") {
    setTab(next);
    setQuery("");
    setActiveIndex(0);
    if (next !== "market") inputRef.current?.focus();
  }

  const filtered = useMemo(() => {
    if (tab === "snippets") return [] as ClipItem[];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      if (it.text.toLowerCase().includes(q)) return true;
      // Screenshots often have an empty `text` marker; the useful words
      // live in the OCR transcript.
      return (
        it.kind === "image" &&
        !!it.ocrText &&
        it.ocrText.toLowerCase().includes(q)
      );
    });
  }, [items, query, tab]);
  const filteredSnippets = useMemo(() => {
    if (tab !== "snippets") return [] as Array<{ id: string; name: string; content: string; enabled: boolean }>;
    const q = query.trim().toLowerCase();
    if (!q) return flatSnippets;
    return flatSnippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.content.toLowerCase().includes(q)
    );
  }, [flatSnippets, query, tab]);

  // Initial load: settings + history (from Rust if available, else seed demo).
  useEffect(() => {
    const loaded = loadSettings();
    setSettings(loaded);
    // Gate the hotkey effect on this so the zustand default (⌘⇧V) isn't
    // registered for a beat before a fresh Windows install's Ctrl+Alt+V
    // lands. Both updates batch into the next render.
    setBooted(true);
    (async () => {
      if (tauriAvailable) {
        await migrateTokenIfAny();
        try {
          const hist = await bridge.loadHistory();
          setItems(hist);
        } catch (e) {
          console.warn("load_history failed", e);
        }
        // First-run onboarding: nudge user to enable autostart so the app
        // really runs in the background after reboots, without making it
        // the default (autostart silently is creepy).
        if (!loaded.onboardingShown) {
          try {
            const enabled = await bridge.autostartGet();
            if (!enabled) {
              setShowOnboarding(true);
            } else {
              setSettings({ ...loaded, autostart: true, onboardingShown: true });
            }
          } catch {
            /* ignore */
          }
        }
        // Self-heal: keep the OS-level registration in sync with what
        // the user opted into. Two scenarios are worth fixing silently:
        //
        //   (a) repair  — settings.autostart=true but neither backend is
        //       registered (app was moved, macOS revoked the agent,
        //       previous version wrote a broken plist).
        //   (b) upgrade — we're now running from a .app bundle (release
        //       build) and SMAppService is available, but the user is
        //       still being served by the LaunchAgent fallback from a
        //       previous dev-build install. Re-enabling moves them into
        //       "登录时打开" instead of "允许在后台" — exactly what the
        //       user means when they say "我要它出现在登录项里".
        if (loaded.autostart) {
          try {
            const diag = await bridge.autostartDiagnose();
            const registered =
              diag.smStatus === "enabled" ||
              (diag.plistExists && diag.launchctlLoaded);
            const stuckOnFallback =
              diag.inAppBundle &&
              diag.backend === "sm_app_service" &&
              diag.smStatus !== "enabled" &&
              diag.launchctlLoaded;
            if (!registered || stuckOnFallback) {
              await bridge.autostartSet(true);
            }
          } catch (e) {
            console.warn("autostart self-heal failed", e);
          }
        }
      } else {
        setItems(seedDemo());
      }
    })();
  }, []);

  // Persist after the initial loadSettings() has landed. Writing the zustand
  // default on the first paint would clobber localStorage before that read
  // finishes — StrictMode runs effects twice, so a fresh Windows install
  // would then load the macOS hotkey it had just written.
  useEffect(() => {
    if (!booted) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [booted, settings]);

  // Persist history whenever it changes (Tauri only).
  // Debounced 300ms so bulk operations (import, sync pull) don't trigger
  // a disk write on every single array mutation.
  const saveHistoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!tauriAvailable) return;
    if (saveHistoryTimer.current) clearTimeout(saveHistoryTimer.current);
    saveHistoryTimer.current = setTimeout(() => {
      bridge.saveHistory(items).catch((e) => console.warn(e));
    }, 300);
    return () => {
      if (saveHistoryTimer.current) clearTimeout(saveHistoryTimer.current);
    };
  }, [items]);

  // Subscribe to Rust clipboard events.
  useEffect(() => {
    if (!tauriAvailable) return;
    const un1 = bridge.onClipboardChange((it) => upsertItem(it));
    // The popup is hidden — not destroyed — when it loses focus, so the
    // React state survives between sessions. Without this reset, hitting
    // the hotkey while Settings was open last time would re-show Settings
    // instead of the history picker, and hitting it from Snippets or the
    // market would reopen on that page. Every hotkey trigger now starts fresh:
    // History tab, empty search, cursor at the top, input focused.
    const un2 = bridge.onHotkeyToggle(() => {
      notifyPopupVisible();
      setShowSettings(false);
      setTab("history");
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
      inputRef.current?.select?.();
      // Replay the fade-in animation. CSS animations don't re-run on
      // attribute changes alone; the canonical trick is to clear `animation`,
      // force a reflow, then set it back. Cheap (~0.1ms) and predictable.
      const el = appRef.current;
      if (el) {
        el.style.animation = "none";
        void el.offsetWidth;
        el.style.animation = "";
      }
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [tauriAvailable]);

  // Expose a global so Rust tray can open Settings via webview eval.
  useEffect(() => {
    (window as any).__openSettings = () => setShowSettings(true);
    return () => { delete (window as any).__openSettings; };
  }, [setShowSettings]);

  // Push hotkey changes to the OS in real time (no app restart needed).
  // If registration fails and the user isn't already on the portable
  // default, fall back to that default and say so — a silent failure
  // leaves the popup unreachable.
  useEffect(() => {
    if (!tauriAvailable || !booted) return;
    const requested = settings.hotkey;
    let cancelled = false;
    (async () => {
      try {
        await bridge.setHotkey(requested);
      } catch (e) {
        console.warn("setHotkey", e);
        if (cancelled || requested === FALLBACK_HOTKEY) return;
        try {
          await bridge.setHotkey(FALLBACK_HOTKEY);
        } catch (e2) {
          console.warn("setHotkey fallback", e2);
          return;
        }
        if (cancelled) return;
        const cur = useStore.getState().settings;
        if (cur.hotkey !== requested) return;
        useStore.getState().setSettings({ ...cur, hotkey: FALLBACK_HOTKEY });
        const label = prettyAccelerator(FALLBACK_HOTKEY) || "Ctrl+Shift+V";
        pushToast({
          id: "hotkey-fallback",
          message: `热键被占用，已回退为 ${label}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tauriAvailable, booted, settings.hotkey]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // Keep the keyboard cursor inside the scroller. Mouse moves also update
  // activeIndex, but `nearest` is a no-op when the row is already fully
  // visible, so hovering doesn't yank the list.
  useEffect(() => {
    const id =
      tab === "history"
        ? filtered[activeIndex]?.id
        : filteredSnippets[activeIndex]?.id;
    if (!id) return;
    rowRefs.current.get(`${tab}:${id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, tab, filtered, filteredSnippets]);

  // Push ignore-source patterns to Rust whenever they change.
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge.setIgnoreSources(settings.ignoreSources).catch(() => {});
  }, [tauriAvailable, settings.ignoreSources]);

  // Apply presentation mode (Dock + menubar visibility) on every change,
  // including the initial load — so the saved choice persists across restarts.
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge
      .setPresentationMode(settings.presentationMode || "menubar")
      .catch((e) => console.warn("setPresentationMode", e));
  }, [tauriAvailable, settings.presentationMode]);

  // Mirror sync settings into Rust so the backend timer keeps syncing
  // even when the webview is suspended (macOS does this for hidden popups).
  // Uses an async device id lookup so we receive the backend-managed stable
  // id (the backend will ignore the value when it already has one).
  useEffect(() => {
    if (!tauriAvailable) return;
    (async () => {
      const device = await resolveDeviceId(tauriAvailable);
      bridge
        .setSyncSettings(settings.sync, device, settings.maxItems)
        .catch(() => {});
    })();
  }, [tauriAvailable, settings.sync, settings.maxItems]);

  // Live history updates pushed by the Rust sync timer.
  useEffect(() => {
    if (!tauriAvailable) return;
    const un1 = bridge.onHistoryUpdated((items) => setItems(items));
    const un2 = bridge.onSyncStatus((s) => {
      if (s.phase === "syncing") setSyncStatus("syncing");
      else if (s.phase === "ok")
        setSyncStatus("ok", new Date(s.at || Date.now()).toLocaleTimeString());
      else if (s.phase === "err") setSyncStatus("err", s.message || "同步没有完成");
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [tauriAvailable]);

  // Snippets: load once + listen for updates pushed by other windows
  // (e.g. the editor window's saves come through here too).
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge.listSnippets().then(setSnippets).catch(() => {});
    const un = bridge.onSnippetsUpdated((nodes) => setSnippets(nodes));
    return () => {
      un.then((f) => f());
    };
  }, [tauriAvailable]);

  // Listen for keyboard shortcuts at the window level (capture phase) so
  // they fire even when the search <input> has focus. React's onKeyDown on
  // the wrapper div doesn't receive them while the input is editing.
  //
  // Previously the effect ran on every render (no deps) and add+remove'd
  // the global listener each time — wasteful for an input that re-renders
  // on every keystroke. We now register the listener once and route to the
  // freshest `onKeyDown` through a ref, avoiding both the churn and the
  // stale-closure trap of `useEffect(..., [])` + inline handler.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDownRef.current(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Foreground "立即同步" button — delegates to Rust so the same code path
  // works whether the popup is visible or not.
  async function doSync(_forcePush: boolean) {
    if (tauriAvailable) {
      try {
        await bridge.syncNow();
      } catch (e: any) {
        setSyncStatus("err", e?.message ?? String(e));
      }
      return;
    }
    // Browser preview fallback (no Tauri).
    setSyncStatus("syncing");
    try {
      const token = null;
      const remote = await fetchRemote(settings, token);
      const merged = mergeHistory(items, remote?.items ?? [], settings.maxItems);
      setItems(merged);
      setSyncStatus("ok", new Date().toLocaleTimeString());
    } catch (e: any) {
      setSyncStatus("err", e?.message ?? String(e));
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // The market search lives inside the page. Capturing arrows and Enter
    // here would freeze the caret. Tab still cycles, and the editor
    // shortcut still falls through to the handler below.
    if (
      tab === "market" &&
      e.key !== "Tab" &&
      !matchesAccelerator(e, settings.popupEditorShortcut)
    ) {
      if (e.key === "Escape") {
        const target = e.target;
        if (
          target instanceof HTMLInputElement &&
          target.closest(".market") &&
          target.value.length > 0
        ) {
          return;
        }
        e.preventDefault();
        if (showSettings) {
          setShowSettings(false);
        } else if (tauriAvailable) {
          bridge.hidePopup();
        }
      }
      return;
    }
    const list = tab === "history" ? filtered : filteredSnippets;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      lastKeyAt.current = Date.now();
      setActiveIndex(Math.min(activeIndex + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      lastKeyAt.current = Date.now();
      setActiveIndex(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (tab === "history") {
        const it = filtered[activeIndex];
        if (it) onPick(it);
      } else {
        const s = filteredSnippets[activeIndex];
        if (s) onPickSnippet(s.id, s.content);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Two-stage close:
      //   1. If Settings overlay is open → close it (stay in popup).
      //   2. Else if there's a search query → clear it (let the user start
      //      a new search without dismissing the popup).
      //   3. Else → actually hide the popup.
      // Without stage 2, a single Esc destroys both the search context and
      // the popup, which is jarring when the user just wanted to retry.
      if (showSettings) {
        setShowSettings(false);
      } else if (query.trim().length > 0) {
        setQuery("");
        setActiveIndex(0);
      } else if (tauriAvailable) {
        bridge.hidePopup();
      }
    } else if (e.key.toLowerCase() === "p" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (tab === "history") {
        const it = filtered[activeIndex];
        if (it) togglePin(it.id);
      }
    } else if (matchesAccelerator(e, settings.popupEditorShortcut)) {
      // User-customisable in-popup shortcut (Settings → 自定义片段编辑器
      //快捷键). Empty string in settings disables it entirely so the
      // user can free up ⌘E for the underlying webview.
      e.preventDefault();
      if (tauriAvailable) bridge.openSnippetsWindow().catch(console.warn);
    } else if (e.key === "Tab") {
      e.preventDefault();
      // One direction across the three pages: history, snippets, market.
      switchTab(
        tab === "history" ? "snippets" : tab === "snippets" ? "market" : "history"
      );
    } else if (
      (e.metaKey || e.ctrlKey) &&
      e.key >= "1" &&
      e.key <= "9"
    ) {
      e.preventDefault();
      const idx = parseInt(e.key, 10) - 1;
      if (tab === "history") {
        const it = filtered[idx];
        if (it) onPick(it);
      } else {
        const s = filteredSnippets[idx];
        if (s) onPickSnippet(s.id, s.content);
      }
    }
  }

  /// Copy already succeeded and the popup is hidden. Synthesize paste only
  /// when the user opted in; a rejection surfaces a toast instead of an alert
  /// because the window the user is looking at is no longer this one.
  async function pasteIfEnabled() {
    if (!settings.pasteOnPick) return;
    await delay(PASTE_DELAY_MS);
    try {
      await bridge.simulatePaste();
    } catch (e) {
      pushToast(pasteFailureToast(e));
    }
  }

  async function onPickSnippet(id: string, content: string) {
    if (tauriAvailable) {
      try {
        await bridge.useSnippet(id);
      } catch (e: any) {
        alert("调用片段失败：" + (e?.message || e));
        return;
      }
      await pasteIfEnabled();
    } else {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        /* ignore */
      }
    }
  }

  async function onPick(item: ClipItem) {
    if (tauriAvailable) {
      try {
        await bridge.copyToClipboard(item);
        await bridge.hidePopup();
      } catch (e: any) {
        if (item.kind === "image") {
          alert(`图片二进制不在本机：${e?.message || e}`);
          return;
        }
        throw e;
      }
      await pasteIfEnabled();
    } else {
      try {
        await navigator.clipboard.writeText(item.text);
      } catch {
        /* ignore */
      }
    }
    upsertItem({ ...item, updatedAt: Date.now(), hits: (item.hits || 0) + 1 });
  }

  return (
    <div className="app" tabIndex={-1} ref={appRef}>
      <div className="chrome">
      <div className="tab-strip">
        <button
          className={tab === "history" ? "active" : ""}
          onClick={() => switchTab("history")}
        >
          历史
        </button>
        <button
          className={tab === "snippets" ? "active" : ""}
          onClick={() => switchTab("snippets")}
        >
          片段
          {flatSnippets.length > 0 && (
            <span className="tab-badge">{flatSnippets.length}</span>
          )}
        </button>
        <button
          className={tab === "market" ? "active" : ""}
          onClick={() => switchTab("market")}
        >
          市场
        </button>
        <div style={{ flex: 1 }} />
        {tab === "snippets" && (
          <button
            className="tab-edit"
            title={
              editorShortcutLabel
                ? `打开片段编辑器 (${editorShortcutLabel})`
                : "打开片段编辑器"
            }
            onClick={() => bridge.openSnippetsWindow().catch(console.warn)}
          >
            {editorShortcutLabel ? `${editorShortcutLabel} 编辑器` : "编辑器"}
          </button>
        )}
      </div>
      <div className="toolbar">
        {tab === "market" ? (
          <div className="toolbar-spacer" />
        ) : (
          <input
            ref={inputRef}
            autoFocus
            placeholder={tab === "history" ? "搜索剪贴板历史..." : "搜索片段..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <span
          className={`sync-status ${
            syncStatus === "ok" ? "ok" : syncStatus === "err" ? "err" : ""
          }`}
          title={syncMessage || ""}
        >
          {syncStatus === "syncing"
            ? "同步中…"
            : syncStatus === "ok"
            ? `已同步 ${syncMessage}`
            : syncStatus === "err"
            ? `失败`
            : settings.sync.backend === "local"
            ? "本地"
            : "未同步"}
        </span>
        {settings.sync.backend !== "local" && (
          <button type="button" className="toolbar-btn" onClick={() => doSync(true)}>
            同步
          </button>
        )}
        <button
          type="button"
          className="toolbar-btn toolbar-btn-icon"
          title="设置"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
      </div>
      </div>

      <div className={tab === "market" ? "list list-fill" : "list"}>
        {tab === "market" ? (
          <Market snippets={snippets} onChange={setSnippets} />
        ) : tab === "snippets" ? (
          filteredSnippets.length === 0 ? (
            flatSnippets.length === 0 ? (
              <EmptyState
                icon="✨"
                title="还没有片段"
                sub={
                  editorShortcutLabel
                    ? `按 ${editorShortcutLabel} 打开编辑器，把常用文本存下来。`
                    : "打开编辑器，把常用文本存下来。"
                }
              />
            ) : (
              <EmptyState icon="🔍" title="没有匹配的片段" sub="换个关键词试试。" />
            )
          ) : (
            filteredSnippets.map((s, i) => (
              <div
                key={s.id}
                ref={(el) => {
                  const key = `snippets:${s.id}`;
                  if (el) rowRefs.current.set(key, el);
                  else rowRefs.current.delete(key);
                }}
                className={`item ${i === activeIndex ? "active" : ""} ${
                  s.enabled ? "" : "disabled"
                }`}
                onMouseEnter={() => {
                  // Ignore mouse drift right after a key press, otherwise
                  // arrow-key selection gets immediately overridden by the
                  // pointer hovering over a random row.
                  if (Date.now() - lastKeyAt.current < 200) return;
                  setActiveIndex(i);
                }}
                onClick={() => onPickSnippet(s.id, s.content)}
              >
                <div
                  className="idx"
                  title={i < 9 ? `${mod(String(i + 1))} 直接粘贴` : undefined}
                >
                  {/*
                    On macOS the ⌘ glyph is compact enough to render the full
                    shortcut inside the 18px column ("⌘1"). On Windows the
                    "Ctrl+1" label is far too wide for the same slot and
                    would break the row layout — we fall back to a bare
                    number there and rely on the title tooltip for the
                    modifier hint.
                  */}
                  {i < 9 && IS_MAC ? `⌘${i + 1}` : i + 1}
                </div>
                <div className="body">
                  <div className="preview">
                    <span className="preview-text">
                      📄 <Highlight text={s.name} q={query} />
                    </span>
                  </div>
                  <div className="meta">
                    {s.content
                      .replace(/\s+/g, " ")
                      .slice(0, 80) || "(空片段)"}
                  </div>
                </div>
                {!s.enabled && <div className="pin" title="已禁用">⏻</div>}
              </div>
            ))
          )
        ) : (
          <>
            {filtered.length === 0 &&
              (items.length === 0 ? (
                <EmptyState
                  icon="📋"
                  title="剪贴板是空的"
                  sub="复制文字、图片或文件，它们会出现在这里。"
                />
              ) : (
                <EmptyState icon="🔍" title="没有匹配项" sub="换个关键词，或清空搜索再看看。" />
              ))}
        {filtered.map((it, i) => (
          <div
            key={it.id}
            ref={(el) => {
              const key = `history:${it.id}`;
              if (el) rowRefs.current.set(key, el);
              else rowRefs.current.delete(key);
            }}
            className={`item ${i === activeIndex ? "active" : ""}`}
            onMouseEnter={() => {
              if (Date.now() - lastKeyAt.current < 200) return;
              setActiveIndex(i);
            }}
            onClick={() => onPick(it)}
          >
            <div
              className="idx"
              title={i < 9 ? `${mod(String(i + 1))} 直接粘贴` : undefined}
            >
              {i < 9 && IS_MAC ? `⌘${i + 1}` : i + 1}
            </div>
            {it.kind === "image" ? <ImageThumb item={it} /> : null}
            <div className="body">
              <div className="preview">
                {it.kind === "text" ? <TypeBadge text={it.text} /> : null}
                <span className="preview-text">
                  {it.kind === "image" ? (
                    `📷 ${it.width ?? "?"}×${it.height ?? "?"} · ${formatBytes(it.bytes)}`
                  ) : (
                    <Highlight text={it.text.replace(/\s+/g, " ").slice(0, 200)} q={query} />
                  )}
                </span>
              </div>
              <div className="meta">
                <MetaTime ts={it.updatedAt} now={now} />
                {it.kind !== "text" ? ` · ${it.kind}` : ""}
                {it.hits > 1 ? ` · ${it.hits}×` : ""}
              </div>
              {it.kind === "image" ? <OcrLine text={it.ocrText} query={query} /> : null}
            </div>
            {it.pinned && <div className="pin" title="已置顶">★</div>}
          </div>
        ))}
          </>
        )}
      </div>

      <div className="footer">
        <span className="footer-count">
          {tab === "market"
            ? ""
            : tab === "snippets"
            ? filteredSnippets.length < flatSnippets.length
              ? `${filteredSnippets.length} / ${flatSnippets.length}`
              : `${flatSnippets.length} 个片段`
            : filtered.length < items.length
            ? `${filtered.length} / ${items.length}`
            : `${items.length} 条`}
        </span>
        <FooterHints />
      </div>

      <ToastHost />
      {showSettings && <Settings />}
      {showOnboarding && (
        <Onboarding
          onDecide={async (action) => {
            setShowOnboarding(false);
            const next = { ...settings, onboardingShown: true };
            if (action === "enable") {
              try {
                await bridge.autostartSet(true);
                next.autostart = true;
              } catch (e) {
                console.warn("autostart enable failed", e);
              }
            }
            setSettings(next);
          }}
        />
      )}
    </div>
  );
}

function Settings() {
  const { settings, setSettings, setShowSettings, items, removeItem, setItems } = useStore();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [tokenDraft, setTokenDraft] = useState<string>("");
  const [tokenStatus, setTokenStatus] = useState<"loading" | "set" | "unset">("loading");
  const [syncHint, setSyncHint] = useState("");
  const [checkingSync, setCheckingSync] = useState(false);
  const [autostartActual, setAutostartActual] = useState<boolean | null>(null);
  const [autostartBackend, setAutostartBackend] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  /// null = not checked yet (or the command failed). Only macOS consults this.
  const [a11y, setA11y] = useState<boolean | null>(null);
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  async function refreshAutostartState() {
    try {
      const [enabled, diag] = await Promise.all([
        bridge.autostartGet(),
        bridge.autostartDiagnose(),
      ]);
      setAutostartActual(enabled);
      setAutostartBackend(diag.backend ?? null);
    } catch {
      setAutostartActual(false);
      setAutostartBackend(null);
    }
  }

  // Load token presence and autostart state from OS.
  useEffect(() => {
    if (!tauriAvailable) {
      setTokenStatus("unset");
      return;
    }
    bridge.getToken().then((t) => setTokenStatus(t ? "set" : "unset"));
    refreshAutostartState();
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Accessibility trust can change while System Settings is open and this
  // panel is still mounted underneath. Recheck when the webview is focused
  // again so the chip doesn't stay yellow after the user grants access.
  useEffect(() => {
    if (!tauriAvailable || !IS_MAC) return;
    let dead = false;
    const pull = () => {
      bridge
        .checkAccessibility()
        .then((ok) => {
          if (!dead) setA11y(ok);
        })
        .catch(() => {
          if (!dead) setA11y(null);
        });
    };
    pull();
    window.addEventListener("focus", pull);
    return () => {
      dead = true;
      window.removeEventListener("focus", pull);
    };
  }, [tauriAvailable]);

  function update<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setDraft({ ...draft, [k]: v });
  }
  function updateSync<K extends keyof AppSettings["sync"]>(
    k: K,
    v: AppSettings["sync"][K]
  ) {
    setDraft({ ...draft, sync: { ...draft.sync, [k]: v } });
  }

  async function onSave() {
    // 1) Token: keychain
    if (tauriAvailable && tokenDraft) {
      await bridge.setToken(tokenDraft);
      setTokenDraft("");
      setTokenStatus("set");
    }
    // 2) Autostart: OS
    if (tauriAvailable && draft.autostart !== autostartActual) {
      try {
        await bridge.autostartSet(draft.autostart);
        // Pull the real state (and backend) back from the OS — the user
        // toggled the checkbox, but what actually happened depends on
        // whether SMAppService accepted the registration or fell back to
        // the LaunchAgent. We need the truth, not the optimistic guess.
        await refreshAutostartState();
      } catch (e) {
        console.warn("autostart toggle failed", e);
      }
    }
    setSettings(draft);
    setShowSettings(false);
  }

  async function onCheckSync() {
    if (!tauriAvailable) {
      setSyncHint("浏览器预览里连不上 GitHub。用安装好的 ClipSync 检查。");
      return;
    }
    setCheckingSync(true);
    setSyncHint("正在检查账号和仓库…");
    try {
      if (tokenDraft.trim()) {
        await bridge.setToken(tokenDraft.trim());
        setTokenDraft("");
        setTokenStatus("set");
      }
      const device = await resolveDeviceId(true);
      await bridge.setSyncSettings(draft.sync, device, draft.maxItems);
      setSettings(draft);
      const result = await bridge.syncCheck();
      setSyncHint(result.message);
      if (result.ok && draft.sync.backend !== "local") {
        setSyncHint(result.message.replace(/。$/, "，正在写入…"));
        await bridge.syncNow();
        setSyncHint(result.message);
      }
    } catch (e: any) {
      const message = e?.message || String(e);
      setSyncHint(message);
      useStore.getState().setSyncStatus("err", message);
    } finally {
      setCheckingSync(false);
    }
  }

  async function onClearToken() {
    if (!tauriAvailable) return;
    await bridge.clearToken();
    setTokenStatus("unset");
  }

  async function onExportHistory() {
    if (!tauriAvailable) return;
    try {
      const json = await bridge.exportHistory();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clipsync-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert("导出失败：" + (e?.message || e));
    }
  }

  async function onImportHistory(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      if (tauriAvailable) {
        const added = await bridge.importHistory(text);
        alert(`导入完成：新增 ${added} 条记录`);
        const hist = await bridge.loadHistory();
        setItems(hist);
      } else {
        alert("仅在 Tauri 环境下支持导入");
      }
    } catch (err: any) {
      alert("导入失败：" + (err?.message || err));
    }
    e.target.value = "";
  }


  return (
    <div className="settings">
      <div className="settings-bar">
        <span className="settings-bar-title">设置</span>
        <span className="settings-bar-actions">
          <button onClick={() => setShowSettings(false)}>取消</button>
          <button className="primary" onClick={onSave}>保存</button>
        </span>
      </div>

      <div className="settings-body">
        <div className="field-grid">

          <div className="fg-section-head">常规</div>

          <span className="fg-label">全局快捷键</span>
          <input
            className="fg-input"
            value={draft.hotkey}
            onChange={(e) => update("hotkey", e.target.value)}
            placeholder="CommandOrControl+Shift+V"
            title="唤出 popup 的全局快捷键"
          />

          <span className="fg-label" title="仅在 popup 内生效；留空禁用">片段快捷键</span>
          <ShortcutInput
            value={draft.popupEditorShortcut}
            onChange={(v) => update("popupEditorShortcut", v)}
            placeholder="点击录制…"
          />

          <span className="fg-label">外观</span>
          <div className="seg-group" role="radiogroup">
            {(["menubar", "dock", "both"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`seg ${draft.presentationMode === m ? "active" : ""}`}
                onClick={() => {
                  if (m === "dock" && draft.presentationMode !== "dock") {
                    alert(
                      `切到 Dock-only 模式：菜单栏图标会隐藏。\n仍可用全局快捷键（默认 ${IS_MAC ? "⌘⇧V" : "Ctrl+Shift+V"}）唤出主弹窗。`
                    );
                  }
                  update("presentationMode", m);
                  if (tauriAvailable) bridge.setPresentationMode(m).catch(console.warn);
                }}
              >
                {m === "menubar" ? "菜单栏" : m === "dock" ? "Dock" : "两者"}
              </button>
            ))}
          </div>

          <span className="fg-label" title="最多保留多少条剪贴板记录">历史条数</span>
          <input
            className="fg-input"
            type="number"
            value={draft.maxItems}
            onChange={(e) => update("maxItems", Number(e.target.value) || 200)}
          />

          {/* 开机自启行 — 跨两列 */}
          <div className="fg-full-row">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.autostart}
                onChange={(e) => update("autostart", e.target.checked)}
              />
              开机自启
              {autostartActual !== null && draft.autostart === autostartActual && (
                <span className={`chip chip-${autostartActual ? "set" : "unset"}`}>
                  {autostartActual ? "已注册" : "未注册"}
                </span>
              )}
            </label>
            {IS_MAC && (
              <button
                type="button"
                className="link-btn"
                title={
                  autostartActual && autostartBackend
                    ? autostartBackend === "sm_app_service"
                      ? "出现在「登录时打开」"
                      : "出现在「允许在后台」（需安装到 /Applications）"
                    : undefined
                }
                onClick={() => bridge.autostartOpenSettings().catch(() => {})}
              >
                系统设置 →
              </button>
            )}
          </div>

          <div className="fg-full-row">
            <label className="check" title="关闭则选中后仅复制到剪贴板">
              <input
                type="checkbox"
                checked={draft.pasteOnPick}
                onChange={(e) => update("pasteOnPick", e.target.checked)}
              />
              选中后自动粘贴
              {IS_MAC && a11y !== null && (
                <span className={`chip ${a11y ? "chip-set" : "chip-warn"}`}>
                  {a11y ? "已授权" : "未授权"}
                </span>
              )}
            </label>
            {IS_MAC && a11y === false && (
              <button
                type="button"
                className="link-btn"
                onClick={() => bridge.openAccessibilitySettings().catch(() => {})}
              >
                系统设置 →
              </button>
            )}
          </div>

          {/* ── 分隔线 ── */}
          <div className="fg-divider" />

          {/* ── 同步 ── */}
          <span className="fg-label fg-section">同步</span>
          <div className="seg-group" role="radiogroup">
            {(["repo", "gist", "local"] as const).map((b) => (
              <button
                key={b}
                type="button"
                className={`seg ${draft.sync.backend === b ? "active" : ""}`}
                onClick={() => updateSync("backend", b)}
              >
                {b === "repo" ? "仓库" : b === "gist" ? "Gist" : "仅本地"}
              </button>
            ))}
          </div>

          {draft.sync.backend !== "local" && (
            <>
              <span className="fg-label">GitHub PAT</span>
              <div className="fg-pat-row">
                <span className={`chip chip-${tokenStatus}`}>
                  {tokenStatus === "set" ? "已保存" : tokenStatus === "loading" ? "…" : "未设置"}
                </span>
                <input
                  type="password"
                  className="mono"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder={tokenStatus === "set" ? "•••••••• (留空保持)" : "ghp_..."}
                />
                {tokenStatus === "set" && (
                  <button type="button" className="link-btn" onClick={onClearToken}>
                    清除
                  </button>
                )}
              </div>
            </>
          )}

          {draft.sync.backend === "repo" && (
            <>
              <span className="fg-label" title="owner/repo，留空用账号/clipsync">仓库</span>
              <input
                className="fg-input mono"
                value={draft.sync.repo || ""}
                onChange={(e) => updateSync("repo", e.target.value)}
                placeholder="owner/repo"
              />
            </>
          )}

          {draft.sync.backend === "gist" && (
            <>
              <span className="fg-label" title="需要一条已经建好的私有 Gist">Gist ID</span>
              <div className="fg-input-block">
                <input
                  className="mono"
                  style={{ width: "100%" }}
                  value={draft.sync.gistId || ""}
                  onChange={(e) => updateSync("gistId", e.target.value)}
                  placeholder="已有 Gist 的 ID"
                />
                <button
                  type="button"
                  className="link-btn"
                  style={{ marginTop: 2 }}
                  onClick={async () => {
                    if (!tauriAvailable) return;
                    if (!confirm("把 Gist 中的历史迁到 repo 后端？")) return;
                    try {
                      const n = await bridge.migrateFromGist();
                      alert(`迁移完成：${n} 条`);
                      setDraft({ ...draft, sync: { ...draft.sync, backend: "repo" } });
                    } catch (e: any) {
                      alert("迁移失败：" + (e?.message || e));
                    }
                  }}
                >
                  迁移到 repo
                </button>
              </div>
            </>
          )}

          <span className="fg-label" title="0 表示禁用">同步间隔</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              className="fg-input"
              type="number"
              style={{ width: 72 }}
              value={draft.sync.intervalSec}
              onChange={(e) => updateSync("intervalSec", Number(e.target.value) || 0)}
            />
            <span style={{ fontSize: 11, color: "#8b949e" }}>秒，0 禁用</span>
          </div>

          <span className="fg-label" />
          <label className="check">
            <input
              type="checkbox"
              checked={draft.sync.pushOnChange}
              onChange={(e) => updateSync("pushOnChange", e.target.checked)}
            />
            复制后立即推送
          </label>

          <div className="sync-check">
            <button type="button" onClick={onCheckSync} disabled={checkingSync}>
              {checkingSync ? "检查中…" : "检查连接"}
            </button>
            <p>
              {syncHint ||
                "仓库名留空时，会使用你的用户名/clipsync；还没有这个仓库，就尝试新建私有仓库。Gist 需要填已有的 ID。"}
            </p>
          </div>

          {/* ── 分隔线 ── */}
          <div className="fg-divider" />

          {/* ── 数据 ── */}
          <span className="fg-label fg-section">数据</span>
          <div className="btn-row">
            <button onClick={onExportHistory} disabled={!tauriAvailable}>导出 JSON</button>
            <label className="btn-as-label">
              <input type="file" accept=".json" onChange={onImportHistory} />
              导入 JSON
            </label>
            <button
              className="danger"
              onClick={() => {
                if (confirm("清空全部历史？(置顶项也会清除)")) {
                  for (const it of items) removeItem(it.id);
                }
              }}
            >
              清空历史
            </button>
          </div>

          <span className="fg-label" title="每行一个 bundle id，支持 * 通配">忽略来源</span>
          <textarea
            className="fg-input mono"
            style={{ minHeight: 56, resize: "vertical" }}
            value={draft.ignoreSources.join("\n")}
            onChange={(e) =>
              update("ignoreSources", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))
            }
            rows={3}
            placeholder="每行一个 bundle id"
          />

        </div>

        {appVersion && (
          <div className="settings-version">
            ClipSync v{appVersion}
          </div>
        )}
      </div>
    </div>
  );
}


function seedDemo(): ClipItem[] {
  const now = Date.now();
  return [
    {
      id: "demo-1",
      kind: "text",
      text: "ClipSync demo (浏览器预览模式) — 在 Tauri 中运行可看到真实剪贴板历史",
      createdAt: now - 60000,
      updatedAt: now - 60000,
      hits: 1,
    },
    {
      id: "demo-2",
      kind: "text",
      text: `支持搜索 / ${mod("1")}-${IS_MAC ? "9" : "Ctrl+9"} 快捷选择 / ${mod("P")} 置顶 / Esc 隐藏`,
      createdAt: now - 120000,
      updatedAt: now - 120000,
      hits: 1,
      pinned: true,
    },
  ];
}

// In-memory cache so each image blob is only fetched once per session.
const blobCache = new Map<string, string>();

function ImageThumb({ item }: { item: ClipItem }) {
  const [src, setSrc] = useState<string | null>(blobCache.get(item.id) ?? null);
  const [missing, setMissing] = useState(false);
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (src) return;
    if (!tauriAvailable) return;
    let cancelled = false;
    bridge
      .readBlob(item.id)
      .then((url) => {
        if (cancelled) return;
        blobCache.set(item.id, url);
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  function onEnter() {
    if (!src) return;
    hoverTimer.current = setTimeout(() => setHover(true), 500);
  }
  function onLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(false);
  }

  // Compute popover position relative to the thumbnail.
  const popoverStyle: React.CSSProperties = (() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return {};
    const overflowRight = rect.right + 480 > window.innerWidth;
    return overflowRight
      ? { right: window.innerWidth - rect.left + 8, top: rect.top }
      : { left: rect.right + 8, top: rect.top };
  })();

  if (missing) {
    return (
      <div className="thumb thumb-missing" title="远端图片，本机无副本">
        📷
      </div>
    );
  }
  return (
    <div
      ref={wrapRef}
      className="thumb-wrap"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {src ? (
        <img className="thumb" src={src} alt={item.text} />
      ) : (
        <div className="thumb thumb-loading" />
      )}
      {hover && src && (
        <div className="image-popover" style={popoverStyle}>
          <img src={src} alt={item.text} />
          <div className="image-popover-meta">
            {item.width}×{item.height} · {formatBytes(item.bytes)}
          </div>
        </div>
      )}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const lneedle = needle.toLowerCase();
  const parts: Array<{ s: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lneedle, i);
    if (idx === -1) {
      parts.push({ s: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ s: text.slice(i, idx), hit: false });
    parts.push({ s: text.slice(idx, idx + needle.length), hit: true });
    i = idx + needle.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? <mark key={k}>{p.s}</mark> : <span key={k}>{p.s}</span>
      )}
    </>
  );
}

function formatBytes(b?: number): string {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

/** Flatten the snippet tree into an ordered list (folders sorted before
 * snippets within each level, mirroring the editor's visual order). */
function flattenSnippets(
  nodes: SnippetNode[]
): Array<{ id: string; name: string; content: string; enabled: boolean }> {
  const out: Array<{ id: string; name: string; content: string; enabled: boolean }> = [];
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push(...flattenSnippets(n.children));
    } else {
      out.push({ id: n.id, name: n.name, content: n.content, enabled: n.enabled });
    }
  }
  return out;
}

type OnboardingAction = "enable" | "skip" | "never";

/**
 * Click-to-record keyboard shortcut input. Used in Settings for shortcuts
 * scoped to the popup webview (NOT the global hotkey, which is registered
 * via Tauri's GlobalShortcut plugin and lives at OS level — that one
 * still uses the plain text accelerator field for backward compatibility).
 *
 * UX notes:
 *  - When focused, every keydown that includes a non-modifier key writes a
 *    new accelerator. Pure modifier presses (Shift / Ctrl alone) are
 *    ignored so the user can build up a chord.
 *  - Pressing Escape with no modifiers clears the value (= disable).
 *  - The recorder consumes the event (preventDefault + stopPropagation)
 *    so the popup's own keymap doesn't fire while you're recording.
 */
function ShortcutInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [recording, setRecording] = useState(false);
  const display = prettyAccelerator(value) || "";
  return (
    <div className="shortcut-input-row">
      <button
        type="button"
        className={`shortcut-input ${recording ? "recording" : ""}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          // Plain Esc with no modifiers means "I changed my mind" — exit
          // recording without altering the value (clear is a separate
          // explicit button).
          if (
            e.key === "Escape" &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.shiftKey
          ) {
            e.preventDefault();
            e.stopPropagation();
            setRecording(false);
            return;
          }
          const accel = eventToAccelerator(e);
          if (!accel) return;
          e.preventDefault();
          e.stopPropagation();
          onChange(accel);
          setRecording(false);
        }}
        title={recording ? "按下任意组合键…" : "点击录入快捷键"}
      >
        {recording
          ? "按下任意组合键…"
          : display || placeholder || "未设置"}
      </button>
      {value && !recording && (
        <button
          type="button"
          className="shortcut-clear"
          title="清除（禁用）"
          onClick={() => onChange("")}
        >
          ×
        </button>
      )}
    </div>
  );
}

function Onboarding({
  onDecide,
}: {
  onDecide: (a: OnboardingAction) => void;
}) {
  return (
    <div className="onboarding-mask">
      <div className="onboarding-card">
        <div className="onboarding-emoji">🪶</div>
        <h2>让 ClipSync 在后台运行</h2>
        <p>
          ClipSync 设计为常驻菜单栏。建议开启 <b>开机自启</b>， 这样电脑开机后它就会
          静悄悄地等在菜单栏上，<b>无 Dock 图标、自适应轮询、闲置时几乎零 CPU</b>。
        </p>
        <p style={{ fontSize: 11, color: "#8b949e", marginTop: 6 }}>
          剪贴板内容只会留在本机，或你自己的 GitHub。
        </p>
        <div className="onboarding-actions">
          <button className="primary" onClick={() => onDecide("enable")}>
            启用开机自启
          </button>
          <button onClick={() => onDecide("skip")}>暂不启用</button>
          <button onClick={() => onDecide("never")}>不再提示</button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  sub,
}: {
  icon: string;
  title: string;
  sub?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="empty-title">{title}</div>
      {sub ? <div className="empty-sub">{sub}</div> : null}
    </div>
  );
}

function MetaTime({ ts, now }: { ts: number; now: number }) {
  return (
    <span className="meta-time" title={new Date(ts).toLocaleString()}>
      {formatRelative(ts, now)}
    </span>
  );
}

function OcrLine({ text, query }: { text?: string; query: string }) {
  if (!text) return null;
  const line = ocrDisplayLine(text, query);
  if (!line) return null;
  return (
    <div className="ocr-line" title={text}>
      <span className="ocr-mark" aria-hidden>
        📝
      </span>
      <span className="ocr-text">
        <Highlight text={line} q={query} />
      </span>
    </div>
  );
}

const TYPE_META: Record<
  Exclude<TextKind, "color">,
  { glyph: string; label: string }
> = {
  url: { glyph: "↗", label: "链接" },
  email: { glyph: "@", label: "邮箱" },
  path: { glyph: "/", label: "路径" },
  code: { glyph: "{}", label: "代码" },
  text: { glyph: "Aa", label: "文本" },
};

function TypeBadge({ text }: { text: string }) {
  const detected = detectTextKind(text);
  if (detected.kind === "color" && detected.color) {
    return (
      <span
        className="type-swatch"
        title="颜色"
        style={{ background: detected.color }}
      />
    );
  }
  const meta = TYPE_META[detected.kind === "color" ? "text" : detected.kind];
  return (
    <span className={`type-badge type-${detected.kind}`} title={meta.label}>
      {meta.glyph}
    </span>
  );
}

function FooterHints() {
  return (
    <div className="footer-hints">
      <Hint keys={["↑", "↓"]} label="选择" />
      <Hint keys={["↵"]} label="粘贴" />
      <Hint
        keys={IS_MAC ? ["⌘", "1-9"] : ["Ctrl", "1-9"]}
        label="直达"
        tier="secondary"
      />
      <Hint
        keys={IS_MAC ? ["⌘", "P"] : ["Ctrl", "P"]}
        label="置顶"
        tier="tertiary"
      />
      <Hint keys={["Tab"]} label="切换" tier="tertiary" />
      <Hint keys={["Esc"]} label="关闭" />
    </div>
  );
}

function Hint({
  keys,
  label,
  tier,
}: {
  keys: string[];
  label: string;
  tier?: "secondary" | "tertiary";
}) {
  return (
    <span className={`hint-group${tier ? ` hint-${tier}` : ""}`}>
      <span className="hint-keys">
        {keys.map((k) => (
          <kbd key={k}>{k}</kbd>
        ))}
      </span>
      <span className="hint-label">{label}</span>
    </span>
  );
}

type TextKind = "url" | "email" | "path" | "color" | "code" | "text";

function detectTextKind(raw: string): { kind: TextKind; color?: string } {
  const text = raw.trim();
  if (!text) return { kind: "text" };
  const color = parseColor(text);
  if (color) return { kind: "color", color };
  if (isEmail(text)) return { kind: "email" };
  if (isUrl(text)) return { kind: "url" };
  if (isPath(text)) return { kind: "path" };
  if (isCode(raw)) return { kind: "code" };
  return { kind: "text" };
}

function isEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text) || /^www\.\S+\.\S+$/i.test(text);
}

function isPath(text: string): boolean {
  if (text.includes("\n") || text.length > 300) return false;
  return /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/]|\\\\)/.test(text);
}

/// `=>`, a brace pair, an indented continuation line, or `;` next to other
/// syntax. A sentence that merely contains ";" stays plain text.
function isCode(text: string): boolean {
  if (text.includes("=>")) return true;
  if (text.includes("{") && text.includes("}")) return true;
  const lines = text.split("\n");
  if (lines.length >= 2 && lines.some((l) => /^[ \t]{2,}\S/.test(l))) return true;
  if (text.includes(";") && /[{}()=]/.test(text)) return true;
  return false;
}

function parseColor(text: string): string | null {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
    return text;
  }
  const rgb = text.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i
  );
  if (!rgb) return null;
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (channels.some((n) => n > 255)) return null;
  return text;
}

/// First non-empty OCR line, unless the query hits a later line — then that
/// line, windowed to 80 characters so the match stays on screen.
function ocrDisplayLine(ocrText: string, query: string): string {
  const lines = ocrText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const q = query.trim();
  const lq = q.toLowerCase();
  let line = lines[0];
  if (lq) {
    const hit = lines.find((l) => l.toLowerCase().includes(lq));
    if (hit) line = hit;
  }
  return clipAround(line, lq ? q : "", 80);
}

function clipAround(line: string, needle: string, max: number): string {
  if (line.length <= max) return line;
  let start = 0;
  if (needle) {
    const idx = line.toLowerCase().indexOf(needle.toLowerCase());
    if (idx >= 0) {
      const ideal = idx - Math.floor((max - needle.length) / 2);
      start = Math.max(0, Math.min(ideal, line.length - max));
    }
  }
  const end = Math.min(line.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return prefix + line.slice(start, end) + suffix;
}

function formatRelative(ts: number, now: number): string {
  const then = new Date(ts);
  if (Number.isNaN(then.getTime())) return "";
  const n = new Date(now);
  const startThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const startNow = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const dayDiff = Math.round((startNow - startThen) / 86_400_000);
  if (dayDiff <= 0) {
    const sec = Math.max(0, Math.floor((now - ts) / 1000));
    if (sec < 5) return "刚刚";
    if (sec < 60) return `${sec} 秒前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    return `${Math.floor(min / 60)} 小时前`;
  }
  if (dayDiff === 1) {
    const hh = String(then.getHours()).padStart(2, "0");
    const mm = String(then.getMinutes()).padStart(2, "0");
    return `昨天 ${hh}:${mm}`;
  }
  if (dayDiff <= 7) return `${dayDiff} 天前`;
  if (then.getFullYear() === n.getFullYear()) {
    return `${then.getMonth() + 1}月${then.getDate()}日`;
  }
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  const msg = (e as { message?: unknown }).message;
  if (typeof msg === "string" && msg.trim()) return msg;
  const asStr = String(e);
  return asStr === "[object Object]" ? "" : asStr;
}

function pasteFailureToast(e: unknown): ToastInput {
  if (IS_MAC) {
    return {
      id: "paste-fail",
      message: "自动粘贴失败：需要辅助功能权限",
      action: {
        label: "打开设置",
        onClick: () => {
          bridge.openAccessibilitySettings().catch(() => {});
        },
      },
      deferUntilVisible: true,
    };
  }
  return {
    id: "paste-fail",
    message: errorText(e) || "自动粘贴失败",
    deferUntilVisible: true,
  };
}

type ToastAction = { label: string; onClick: () => void };
type ToastInput = {
  id: string;
  message: string;
  action?: ToastAction;
  durationMs?: number;
  /// Paste failures happen after the popup hides. Hold the countdown until
  /// the window is on screen again, or the toast expires unseen.
  deferUntilVisible?: boolean;
};
type ToastEntry = ToastInput & { nonce: number };

let emitToast: ((t: ToastInput) => void) | null = null;
let popupVisibleListener: (() => void) | null = null;

function pushToast(t: ToastInput) {
  emitToast?.(t);
}

function notifyPopupVisible() {
  popupVisibleListener?.();
}

function ToastHost() {
  const [current, setCurrent] = useState<ToastEntry | null>(null);
  const [phase, setPhase] = useState<"in" | "out">("in");
  const queueRef = useRef<ToastEntry[]>([]);
  const currentRef = useRef<ToastEntry | null>(null);
  const phaseRef = useRef<"in" | "out">("in");
  const timerRef = useRef<number | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const exitConsumed = useRef(false);

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    detachRef.current?.();
    detachRef.current = null;
  };

  const finishExit = () => {
    if (exitConsumed.current) return;
    if (phaseRef.current !== "out") return;
    exitConsumed.current = true;
    const next = queueRef.current.shift() ?? null;
    if (next) {
      present(next);
      return;
    }
    currentRef.current = null;
    phaseRef.current = "in";
    setCurrent(null);
  };

  const requestExit = () => {
    if (phaseRef.current === "out") return;
    phaseRef.current = "out";
    setPhase("out");
  };

  const arm = (entry: ToastEntry) => {
    clearTimer();
    const ms = entry.durationMs ?? 3800;
    const start = () => {
      if (timerRef.current != null) return;
      detachRef.current?.();
      detachRef.current = null;
      timerRef.current = window.setTimeout(requestExit, ms);
    };
    const hidden =
      document.visibilityState === "hidden" || !document.hasFocus();
    if (entry.deferUntilVisible && hidden) {
      const kick = () => start();
      const onVis = () => {
        if (document.visibilityState === "visible") kick();
      };
      window.addEventListener("focus", kick);
      document.addEventListener("visibilitychange", onVis);
      popupVisibleListener = kick;
      detachRef.current = () => {
        window.removeEventListener("focus", kick);
        document.removeEventListener("visibilitychange", onVis);
        if (popupVisibleListener === kick) popupVisibleListener = null;
      };
      return;
    }
    start();
  };

  const present = (entry: ToastEntry) => {
    exitConsumed.current = false;
    currentRef.current = entry;
    phaseRef.current = "in";
    setCurrent(entry);
    setPhase("in");
    arm(entry);
  };

  useEffect(() => {
    emitToast = (input) => {
      const entry: ToastEntry = { ...input, nonce: Date.now() + Math.random() };
      const qi = queueRef.current.findIndex((q) => q.id === input.id);
      if (qi >= 0) queueRef.current.splice(qi, 1);
      const showing = currentRef.current;
      if (!showing || (showing.id === input.id && phaseRef.current !== "out")) {
        present(entry);
        return;
      }
      queueRef.current.push(entry);
    };
    return () => {
      emitToast = null;
      clearTimer();
    };
    // present/arm close over refs only; the subscription is once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "out") return;
    const t = window.setTimeout(finishExit, 220);
    return () => window.clearTimeout(t);
  }, [phase, current?.nonce]);

  if (!current) return null;
  return (
    <div
      key={current.nonce}
      className={`toast-host ${phase}`}
      role="status"
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (phase === "out") finishExit();
      }}
    >
      <div className="toast">
        <span className="toast-msg">{current.message}</span>
        {current.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              current.action?.onClick();
              clearTimer();
              requestExit();
            }}
          >
            {current.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
