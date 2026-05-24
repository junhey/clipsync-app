import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import { bridge } from "./bridge";
import { fetchRemote, mergeHistory, pushRemote } from "./sync";
import type { AppSettings, ClipItem, SnippetNode } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "clipsync.settings";
const DEVICE_KEY = "clipsync.device";

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppSettings & {
        sync?: { token?: string };
      };
      // One-time migration: PAT used to live here, now goes to OS keychain.
      // The legacy field is stripped; the actual move-to-keychain happens
      // asynchronously in App.useEffect right after settings load.
      if (parsed?.sync?.token) {
        delete parsed.sync.token;
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

function getDeviceId(): string {
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
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [tab, setTab] = useState<"history" | "snippets">("history");
  const [snippets, setSnippets] = useState<SnippetNode[]>([]);
  const flatSnippets = useMemo(() => flattenSnippets(snippets), [snippets]);

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
            const m = await import("@tauri-apps/plugin-autostart");
            const enabled = await m.isEnabled();
            if (!enabled) {
              setShowOnboarding(true);
            } else {
              setSettings({ ...loaded, autostart: true, onboardingShown: true });
            }
          } catch {
            /* ignore */
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
    const un2 = bridge.onHotkeyToggle(() => inputRef.current?.focus());
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
  useEffect(() => {
    if (!tauriAvailable) return;
    bridge
      .setSyncSettings(settings.sync, getDeviceId(), settings.maxItems)
      .catch(() => {});
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

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
      setActiveIndex(Math.min(activeIndex + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
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
      if (showSettings) setShowSettings(false);
      else if (tauriAvailable) bridge.hidePopup();
    } else if (e.key.toLowerCase() === "p" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (tab === "history") {
        const it = filtered[activeIndex];
        if (it) togglePin(it.id);
      }
    } else if (e.key.toLowerCase() === "e" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (tauriAvailable) bridge.openSnippetsWindow().catch(console.warn);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setTab(tab === "history" ? "snippets" : "history");
      setActiveIndex(0);
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
    <div className="app" tabIndex={-1}>
      <div className="tab-strip">
        <button
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
        >
          历史
        </button>
        <button
          className={tab === "snippets" ? "active" : ""}
          onClick={() => setTab("snippets")}
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
            title="打开片段编辑器 (⌘E)"
            onClick={() => bridge.openSnippetsWindow().catch(console.warn)}
          >
            ⌘E 编辑器
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
                ? "还没有片段。打开编辑器 ⌘E 添加。"
                : "没有匹配的片段。"}
            </div>
          ) : (
            filteredSnippets.map((s, i) => (
              <div
                key={s.id}
                className={`item ${i === activeIndex ? "active" : ""} ${
                  s.enabled ? "" : "disabled"
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => onPickSnippet(s.id, s.content)}
              >
                <div className="idx">{i < 9 ? `⌘${i + 1}` : i + 1}</div>
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
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => onPick(it)}
          >
            <div className="idx">{i < 9 ? `⌘${i + 1}` : i + 1}</div>
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
                const m = await import("@tauri-apps/plugin-autostart");
                await m.enable();
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
  const { settings, setSettings, setShowSettings, items, removeItem } = useStore();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [tokenDraft, setTokenDraft] = useState<string>(""); // empty means "no change"
  const [tokenStatus, setTokenStatus] = useState<"loading" | "set" | "unset">("loading");
  const [autostartActual, setAutostartActual] = useState<boolean | null>(null);
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  // Load token presence and autostart state from OS.
  useEffect(() => {
    if (!tauriAvailable) {
      setTokenStatus("unset");
      return;
    }
    bridge.getToken().then((t) => setTokenStatus(t ? "set" : "unset"));
    import("@tauri-apps/plugin-autostart")
      .then((m) => m.isEnabled())
      .then((b) => setAutostartActual(b))
      .catch(() => setAutostartActual(false));
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
        const m = await import("@tauri-apps/plugin-autostart");
        if (draft.autostart) await m.enable();
        else await m.disable();
        setAutostartActual(draft.autostart);
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

  return (
    <div className="settings">
      <h2>常规</h2>

      <div className="field">
        <label>历史条数上限</label>
        <input
          type="number"
          value={draft.maxItems}
          onChange={(e) => update("maxItems", Number(e.target.value) || 200)}
        />
      </div>

      <div className="field">
        <label>全局快捷键</label>
        <input
          value={draft.hotkey}
          onChange={(e) => update("hotkey", e.target.value)}
          placeholder="CommandOrControl+Shift+V"
        />
        <div className="hint">保存后立即生效</div>
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
                    "切到 Dock-only 模式：菜单栏图标会隐藏。\n仍可用全局快捷键（默认 ⌘⇧V）唤出主弹窗。"
                  );
                }
                update("presentationMode", m);
                if (tauriAvailable) {
                  bridge.setPresentationMode(m).catch(console.warn);
                }
              }}
            >
              {m === "menubar"
                ? "🪶 仅菜单栏"
                : m === "dock"
                ? "🚢 仅 Dock"
                : "🪶+🚢 两者"}
            </button>
          ))}
        </div>
        <div className="hint">
          切换立即生效，不必重启
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={draft.autostart}
            onChange={(e) => update("autostart", e.target.checked)}
          />{" "}
          开机自启（菜单栏方式启动）
        </label>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={draft.pasteOnPick}
            onChange={(e) => update("pasteOnPick", e.target.checked)}
          />{" "}
          选中后自动粘贴（需辅助功能权限）
        </label>
      </div>

      <h2 style={{ marginTop: 16 }}>隐私</h2>
      <div className="field">
        <label>忽略来源（每行一个 bundle id 模式，支持 * 通配）</label>
        <textarea
          value={draft.ignoreSources.join("\n")}
          onChange={(e) =>
            update(
              "ignoreSources",
              e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)
            )
          }
          rows={4}
          style={{ width: "100%", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}
        />
      </div>

      <h2 style={{ marginTop: 16 }}>GitHub 同步</h2>
      <div className="field">
        <label>存储后端</label>
        <select
          value={draft.sync.backend}
          onChange={(e) =>
            updateSync("backend", e.target.value as AppSettings["sync"]["backend"])
          }
        >
          <option value="repo">仓库 data 分支 (推荐)</option>
          <option value="gist">私有 Gist (旧版)</option>
          <option value="local">仅本地</option>
        </select>
        {draft.sync.backend === "gist" && (
          <div className="hint" style={{ marginTop: 4 }}>
            ⚠️ Gist 单文件 1MB 上限、每次推全文件，长期使用会撑爆。建议{" "}
            <a
              href="#"
              style={{ color: "#0969da" }}
              onClick={async (ev) => {
                ev.preventDefault();
                if (!tauriAvailable) return;
                if (
                  !confirm(
                    "把 Gist 中的剪贴板历史迁到 repo 后端？\n• 内容按内容哈希 dedupe\n• 永远只 1 个 commit\n• 旧 Gist 不会被自动删除"
                  )
                )
                  return;
                try {
                  const n = await bridge.migrateFromGist();
                  alert(`迁移完成：${n} 条记录已搬到 repo 后端`);
                  setDraft({ ...draft, sync: { ...draft.sync, backend: "repo" } });
                } catch (e: any) {
                  alert("迁移失败：" + (e?.message || e));
                }
              }}
            >
              迁移到 repo →
            </a>
          </div>
        )}
        {draft.sync.backend === "repo" && (
          <div className="hint" style={{ marginTop: 4 }}>
            内容按 SHA-256 拆 blob，data 分支单 commit force-push。仓库总大小 ≈ 当前历史，自动去重。
          </div>
        )}
      </div>

      {draft.sync.backend !== "local" && (
        <div className="field">
          <label>
            GitHub PAT (gist 或 repo 权限) ·{" "}
            <span className="hint" style={{ marginLeft: 4 }}>
              {tokenStatus === "set"
                ? "已存于 OS 钥匙串"
                : tokenStatus === "loading"
                ? "加载中…"
                : "未设置"}
            </span>
          </label>
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder={tokenStatus === "set" ? "•••••••• (留空表示不修改)" : "ghp_..."}
          />
          {tokenStatus === "set" && (
            <button
              type="button"
              onClick={onClearToken}
              style={{ marginTop: 4, fontSize: 11 }}
            >
              清除已保存的 PAT
            </button>
          )}
        </div>
      )}

      {draft.sync.backend === "gist" && (
        <div className="field">
          <label>Gist ID (留空则首次同步自动创建)</label>
          <input
            value={draft.sync.gistId || ""}
            onChange={(e) => updateSync("gistId", e.target.value)}
          />
        </div>
      )}

      {draft.sync.backend === "repo" && (
        <>
          <div className="field">
            <label>仓库 (owner/repo) — 留空自动用 &lt;你的GitHub用户名&gt;/clipsync</label>
            <input
              value={draft.sync.repo || ""}
              onChange={(e) => updateSync("repo", e.target.value)}
              placeholder="junhey/clipsync (默认)"
            />
          </div>
        </>
      )}

      <div className="field">
        <label>自动同步间隔 (秒, 0 关闭)</label>
        <input
          type="number"
          value={draft.sync.intervalSec}
          onChange={(e) =>
            updateSync("intervalSec", Number(e.target.value) || 0)
          }
        />
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={draft.sync.pushOnChange}
            onChange={(e) => updateSync("pushOnChange", e.target.checked)}
          />{" "}
          每次复制后立即推送
        </label>
      </div>

      <div className="actions">
        <button className="primary" onClick={onSave}>
          保存
        </button>
        <button onClick={() => setShowSettings(false)}>取消</button>
        <button
          onClick={() => {
            if (confirm("清空全部历史？(置顶项也会清除)")) {
              for (const it of items) removeItem(it.id);
            }
          }}
        >
          清空历史
        </button>
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: "#8b949e" }}>
        提示：建议为 token 单独创建 fine-grained PAT，仅授予所需权限。PAT 现存于 OS 钥匙串。
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
      text: "支持搜索 / ⌘1-9 快捷选择 / ⌘P 置顶 / Esc 隐藏",
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
