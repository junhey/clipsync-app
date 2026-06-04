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

const SETTINGS_KEY = "clipsync.settings";
const DEVICE_KEY = "clipsync.device";

/// Platform-aware modifier glyph used in UI labels. Detects mac via
/// `navigator.platform` (still the most reliable signal in webviews — the
/// newer `navigator.userAgentData` isn't always populated).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
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
        /** Schema version of the persisted settings blob. Bumped each
         * time we want to silently re-default a field for existing
         * installs. Absent on stores written before v0.10.0. */
        _schemaVersion?: number;
      };
      // One-time migration: PAT used to live here, now goes to OS keychain.
      // The legacy field is stripped; the actual move-to-keychain happens
      // asynchronously in App.useEffect right after settings load.
      if (parsed?.sync?.token) {
        delete parsed.sync.token;
      }
      // Schema v2 (v0.10.0): paste-on-pick became the default. Anyone
      // upgrading from <=v0.9.x had it explicitly false in storage, so a
      // plain default-merge wouldn't flip it. We flip once, then stamp
      // the version so users can still turn it off in Settings without
      // it bouncing back next launch.
      const schema = parsed._schemaVersion ?? 1;
      if (schema < 2) {
        parsed.pasteOnPick = true;
        parsed._schemaVersion = 2;
      }
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        sync: { ...DEFAULT_SETTINGS.sync, ...parsed.sync },
      };
    }
  } catch {
    /* ignore */
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
  const [tab, setTab] = useState<"history" | "snippets">("history");
  const [snippets, setSnippets] = useState<SnippetNode[]>([]);
  const flatSnippets = useMemo(() => flattenSnippets(snippets), [snippets]);

  /// Timestamp of the most recent keyboard navigation (arrow keys / typing).
  /// `onMouseEnter` consults this so casual mouse drift across the list
  /// after a keyboard selection doesn't snatch `activeIndex` away from the
  /// user. The window is short (200ms) so intentional mouse use still wins.
  const lastKeyAt = useRef(0);

  /// Helper for switching tabs cleanly: also clears the query and resets the
  /// cursor, otherwise the list silently reshapes around stale search text
  /// from the previous tab.
  function switchTab(next: "history" | "snippets") {
    setTab(next);
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }

  const filtered = useMemo(() => {
    if (tab === "snippets") return [] as ClipItem[];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.text.toLowerCase().includes(q));
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

  // Save settings to localStorage on change (token never lands here — it's
  // in the OS keychain via Rust commands).
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Persist history whenever it changes (Tauri only).
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge.saveHistory(items).catch((e) => console.warn(e));
  }, [items]);

  // Subscribe to Rust clipboard events.
  useEffect(() => {
    if (!tauriAvailable) return;
    const un1 = bridge.onClipboardChange((it) => upsertItem(it));
    // The popup is hidden — not destroyed — when it loses focus, so the
    // React state survives between sessions. Without this reset, hitting
    // the hotkey while Settings was open last time would re-show Settings
    // instead of the history picker, and hitting it from the Snippets tab
    // would land back in Snippets. Every hotkey trigger now starts fresh:
    // History tab, empty search, cursor at the top, input focused.
    const un2 = bridge.onHotkeyToggle(() => {
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

  // Push hotkey changes to the OS in real time (no app restart needed).
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge
      .setHotkey(settings.hotkey)
      .catch((e) => console.warn("setHotkey", e));
  }, [tauriAvailable, settings.hotkey]);

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
      // Two-stage close, mirroring Alfred/Raycast/Spotlight behaviour:
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
      switchTab(tab === "history" ? "snippets" : "history");
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

  async function onPickSnippet(id: string, content: string) {
    if (tauriAvailable) {
      try {
        await bridge.useSnippet(id);
        if (settings.pasteOnPick) {
          await new Promise((r) => setTimeout(r, 80));
          try {
            await bridge.simulatePaste();
          } catch (err) {
            console.warn("simulatePaste failed", err);
          }
        }
      } catch (e: any) {
        alert("调用片段失败：" + (e?.message || e));
      }
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
        if (settings.pasteOnPick) {
          // Give the previous app a moment to regain focus before sending Cmd/Ctrl+V.
          await new Promise((r) => setTimeout(r, 80));
          try {
            await bridge.simulatePaste();
          } catch (err) {
            console.warn("simulatePaste failed (need Accessibility permission?)", err);
          }
        }
      } catch (e: any) {
        if (item.kind === "image") {
          alert(`图片二进制不在本机：${e?.message || e}`);
          return;
        }
        throw e;
      }
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
        <input
          ref={inputRef}
          autoFocus
          placeholder={tab === "history" ? "搜索剪贴板历史..." : "搜索片段..."}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
      </div>

      <div className="list">
        {tab === "snippets" ? (
          filteredSnippets.length === 0 ? (
            <div className="empty">
              {flatSnippets.length === 0
                ? `还没有片段。${
                    editorShortcutLabel
                      ? `按 ${editorShortcutLabel} 打开编辑器`
                      : "打开编辑器"
                  } 添加。`
                : "没有匹配的片段。"}
            </div>
          ) : (
            filteredSnippets.map((s, i) => (
              <div
                key={s.id}
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
                    📄 <Highlight text={s.name} q={query} />
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
            {filtered.length === 0 && (
              <div className="empty">
                {items.length === 0
                  ? "复制点东西就会出现在这里。"
                  : "没有匹配项。"}
              </div>
            )}
        {filtered.map((it, i) => (
          <div
            key={it.id}
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
                {it.kind === "image" ? (
                  `📷 ${it.width ?? "?"}×${it.height ?? "?"} · ${formatBytes(it.bytes)}`
                ) : (
                  <Highlight text={it.text.replace(/\s+/g, " ").slice(0, 200)} q={query} />
                )}
              </div>
              <div className="meta">
                {new Date(it.updatedAt).toLocaleString()} · {it.kind}
                {it.hits > 1 ? ` · ${it.hits}×` : ""}
              </div>
            </div>
            {it.pinned && <div className="pin" title="已置顶">★</div>}
          </div>
        ))}
          </>
        )}
      </div>

      <div className="footer">
        <span>{filtered.length} / {items.length} 条</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button onClick={() => doSync(true)} disabled={settings.sync.backend === "local"}>
            立即同步
          </button>
          <button onClick={() => setShowSettings(true)}>⚙ 设置</button>
        </span>
      </div>

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
  const [tokenDraft, setTokenDraft] = useState<string>(""); // empty means "no change"
  const [tokenStatus, setTokenStatus] = useState<"loading" | "set" | "unset">("loading");
  const [autostartActual, setAutostartActual] = useState<boolean | null>(null);
  // `null` while loading; `"sm_app_service"` → 出现在系统设置 "登录时打开"
  // 段；`"launch_agent"` → 出现在 "允许在后台" 段。让设置页可以告诉用户
  // 当前生效的是哪种后端 —— 这是 dev 和 release 两种 binary 之间唯一会
  // 感知到的差异。
  const [autostartBackend, setAutostartBackend] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
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
    // 3) PasteOnPick first-enable: nudge user about Accessibility permission
    if (
      tauriAvailable &&
      draft.pasteOnPick &&
      !settings.pasteOnPick &&
      confirm(
        "「选中后自动粘贴」需要 macOS 辅助功能权限。\n保存后请到「系统设置 → 隐私与安全 → 辅助功能」中勾选 ClipSync。\n点确定立即跳转到该页面。"
      )
    ) {
      bridge.openAccessibilitySettings().catch(() => {});
    }
    setSettings(draft);
    setShowSettings(false);
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
      {/* Sticky title bar — Save/Cancel always reachable without scrolling. */}
      <div className="settings-bar">
        <span className="settings-bar-title">设置</span>
        <span className="settings-bar-actions">
          <button onClick={() => setShowSettings(false)}>取消</button>
          <button className="primary" onClick={onSave}>保存</button>
        </span>
      </div>

      <div className="settings-body">
        {/* ── 核心 ───────────────────────────────────────── */}
        <section className="settings-section">
          <div className="settings-section-title">核心</div>

          <div className="field">
            <label>全局快捷键</label>
            <input
              value={draft.hotkey}
              onChange={(e) => update("hotkey", e.target.value)}
              placeholder="CommandOrControl+Shift+V"
            />
          </div>

          <div className="field">
            <label>片段编辑器快捷键（仅在 popup 内生效）</label>
            <ShortcutInput
              value={draft.popupEditorShortcut}
              onChange={(v) => update("popupEditorShortcut", v)}
              placeholder="点击后按下任意组合键…"
            />
            <div className="hint">
              这个快捷键只在 ClipSync popup 已打开 + 输入框 focused
              时生效，不会跟其它应用的全局快捷键冲突。留空则禁用。
            </div>
          </div>

          <div className="field">
            <label>外观</label>
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
                    if (tauriAvailable) {
                      bridge.setPresentationMode(m).catch(console.warn);
                    }
                  }}
                >
                  {m === "menubar" ? "菜单栏" : m === "dock" ? "Dock" : "两者"}
                </button>
              ))}
            </div>
          </div>

          <div className="field-row">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.autostart}
                onChange={(e) => update("autostart", e.target.checked)}
              />
              开机自启
              {/* When the user has flipped the checkbox locally but the
                  draft hasn't been saved yet, autostartActual still
                  reflects the last *applied* state. Show a chip only if
                  the saved state matches the draft, so the user sees a
                  truthful "registered" / "not registered" indicator. */}
              {autostartActual !== null &&
                draft.autostart === autostartActual && (
                  <span
                    className={`chip chip-${autostartActual ? "set" : "unset"}`}
                  >
                    {autostartActual ? "已注册" : "未注册"}
                  </span>
                )}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.pasteOnPick}
                onChange={(e) => update("pasteOnPick", e.target.checked)}
              />
              选中后自动粘贴
            </label>
          </div>

          {IS_MAC && (
            <div className="field" style={{ marginTop: -4 }}>
              {/* The chip says "已注册" — but registered *where*?
                  macOS 13+ shows our LaunchAgent under "允许在后台" and
                  our SMAppService entry under "登录时打开". Surface
                  which one so a user staring at an empty "登录时打开"
                  list doesn't think autostart is broken. */}
              {autostartActual && autostartBackend && (
                <div className="hint" style={{ marginBottom: 6 }}>
                  {autostartBackend === "sm_app_service"
                    ? "已注册到「系统设置 → 登录项与扩展 → 登录时打开」"
                    : "已注册到「系统设置 → 登录项与扩展 → 允许在后台」（开机仍会自动启动；仅安装到 /Applications 的正式版才会出现在「登录时打开」段）"}
                </div>
              )}
              <button
                type="button"
                className="link-btn"
                onClick={() => bridge.autostartOpenSettings().catch(() => {})}
              >
                在「系统设置 → 登录项与扩展」中查看 →
              </button>
            </div>
          )}

          <div className="field">
            <label>历史条数上限</label>
            <input
              type="number"
              value={draft.maxItems}
              onChange={(e) => update("maxItems", Number(e.target.value) || 200)}
            />
          </div>
        </section>

        {/* ── 同步 ───────────────────────────────────────── */}
        <section className="settings-section">
          <div className="settings-section-title">同步</div>

          <div className="field">
            <label>存储后端</label>
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
          </div>

          {draft.sync.backend !== "local" && (
            <div className="field">
              <label className="label-with-chip">
                GitHub PAT
                <span className={`chip chip-${tokenStatus}`}>
                  {tokenStatus === "set"
                    ? "已存于钥匙串"
                    : tokenStatus === "loading"
                    ? "加载中"
                    : "未设置"}
                </span>
              </label>
              <input
                type="password"
                className="mono"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder={
                  tokenStatus === "set" ? "•••••••• (留空保持不变)" : "ghp_..."
                }
              />
              {tokenStatus === "set" && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={onClearToken}
                >
                  清除已保存的 PAT
                </button>
              )}
            </div>
          )}

          {draft.sync.backend === "repo" && (
            <div className="field">
              <label>仓库</label>
              <input
                value={draft.sync.repo || ""}
                onChange={(e) => updateSync("repo", e.target.value)}
                placeholder="owner/repo · 留空用 <账号>/clipsync"
              />
            </div>
          )}

          {draft.sync.backend === "gist" && (
            <>
              <div className="field">
                <label>Gist ID</label>
                <input
                  value={draft.sync.gistId || ""}
                  onChange={(e) => updateSync("gistId", e.target.value)}
                  placeholder="留空则首次同步自动创建"
                />
              </div>
              <div className="hint">
                Gist 单文件 1MB 上限，长期使用会撑爆。
                <button
                  type="button"
                  className="link-btn"
                  onClick={async () => {
                    if (!tauriAvailable) return;
                    if (
                      !confirm(
                        "把 Gist 中的剪贴板历史迁到 repo 后端？\n· 内容按内容哈希 dedupe\n· 永远只 1 个 commit\n· 旧 Gist 不会被自动删除"
                      )
                    )
                      return;
                    try {
                      const n = await bridge.migrateFromGist();
                      alert(`迁移完成：${n} 条记录已搬到 repo 后端`);
                      setDraft({
                        ...draft,
                        sync: { ...draft.sync, backend: "repo" },
                      });
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
        </section>

        {/* ── 高级 (默认折叠) ─────────────────────────────── */}
        <section className="settings-section">
          <button
            type="button"
            className="settings-section-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            <span className="settings-section-title">高级</span>
            <span className="settings-section-caret">
              {showAdvanced ? "−" : "+"}
            </span>
          </button>

          {showAdvanced && (
            <>
              <div className="field-row">
                <div className="field" style={{ flex: 1 }}>
                  <label>自动同步间隔 (秒, 0 关闭)</label>
                  <input
                    type="number"
                    value={draft.sync.intervalSec}
                    onChange={(e) =>
                      updateSync("intervalSec", Number(e.target.value) || 0)
                    }
                  />
                </div>
                <label className="check" style={{ flex: 1, alignSelf: "flex-end" }}>
                  <input
                    type="checkbox"
                    checked={draft.sync.pushOnChange}
                    onChange={(e) => updateSync("pushOnChange", e.target.checked)}
                  />
                  复制后立即推送
                </label>
              </div>

              <div className="field">
                <label>忽略来源</label>
                <textarea
                  value={draft.ignoreSources.join("\n")}
                  onChange={(e) =>
                    update(
                      "ignoreSources",
                      e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean)
                    )
                  }
                  rows={3}
                  className="mono"
                  placeholder="每行一个 bundle id 模式，支持 *"
                />
              </div>

              <div className="field">
                <label>数据</label>
                <div className="btn-row">
                  <button onClick={onExportHistory} disabled={!tauriAvailable}>
                    导出历史 JSON
                  </button>
                  <label className="btn-as-label">
                    <input
                      type="file"
                      accept=".json"
                      onChange={onImportHistory}
                    />
                    导入历史 JSON
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
              </div>
            </>
          )}
        </section>

        {appVersion && (
          <div className="settings-version">ClipSync v{appVersion}</div>
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
          你的剪贴板内容只会留在本机和你自己的 GitHub Gist 上。
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
