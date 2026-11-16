import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { bridge } from "./bridge";
import { openSnippet, type SealPayload } from "./seal";
import type {
  CatalogPayload,
  CatalogSnippet,
  SealedEntry,
  SnippetNode,
} from "./types";

const TAURI_AVAILABLE =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const FLASH_MS = 2400;
const COPIED_NOTE =
  "已复制，打开应用后可以导入到『来自分享』";

/**
 * Shared catalog browser used by the popup and the snippet editor.
 * The desktop bridge imports into the local tree; the web preview can only
 * copy the text, because there is no local snippet store to write to.
 * Private rows stay opaque until a key decrypts them in this component.
 * The key is kept in memory only.
 */
export default function Market({
  snippets,
  onChange,
}: {
  snippets: SnippetNode[];
  onChange: (next: SnippetNode[]) => void;
}) {
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; text: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(
    null
  );
  const [copiedNote, setCopiedNote] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlocked, setUnlocked] = useState<Record<string, SealPayload>>({});
  const importingRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const raw = TAURI_AVAILABLE
        ? await bridge.loadCatalog()
        : await fetchCatalogFile();
      setCatalog(parseCatalog(raw));
    } catch (e) {
      setCatalog(null);
      setLoadError(errorText(e) || "目录加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const owned = useMemo(() => ownedCatalogIds(snippets), [snippets]);
  const sealed = catalog?.sealed ?? [];

  const visible = useMemo(() => {
    const cats = catalog?.categories ?? [];
    const q = query.trim().toLowerCase();
    const rows: CatalogSnippet[] = [];
    for (const cat of cats) {
      if (categoryId !== "all" && cat.id !== categoryId) continue;
      for (const snip of cat.snippets ?? []) {
        if (!q || matchesQuery(snip, q)) rows.push(snip);
      }
    }
    return rows;
  }, [catalog, categoryId, query]);

  const showPrivate = categoryId === "all";
  const q = query.trim().toLowerCase();
  const unlockedRows = sealed.filter((entry) => {
    const payload = unlocked[entry.id];
    if (!payload) return false;
    if (!q) return true;
    return matchesUnlocked(payload, q);
  });
  const lockedCount = sealed.filter((entry) => !unlocked[entry.id]).length;

  function showFlash(id: string, text: string) {
    setFlash({ id, text });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }

  async function importOne(snip: CatalogSnippet) {
    if (importingRef.current) return;
    importingRef.current = snip.id;
    setImportingId(snip.id);
    setRowError((cur) => (cur?.id === snip.id ? null : cur));
    try {
      if (TAURI_AVAILABLE) {
        const result = await bridge.importSharedSnippet(snip.id);
        const next = await bridge.listSnippets();
        onChange(next);
        showFlash(snip.id, result === "updated" ? "已更新" : "已加入来自分享");
      } else {
        await navigator.clipboard.writeText(snip.content);
        setCopiedNote(true);
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setCopiedNote(false), 4000);
      }
    } catch (e) {
      setFlash((cur) => (cur?.id === snip.id ? null : cur));
      setRowError({ id: snip.id, text: errorText(e) || "导入失败" });
    } finally {
      importingRef.current = null;
      setImportingId(null);
    }
  }

  async function importUnlocked(id: string, payload: SealPayload) {
    if (importingRef.current) return;
    importingRef.current = id;
    setImportingId(id);
    setRowError((cur) => (cur?.id === id ? null : cur));
    try {
      if (TAURI_AVAILABLE) {
        const result = await bridge.importUnlockedSnippet(
          id,
          payload.name,
          payload.content
        );
        const next = await bridge.listSnippets();
        onChange(next);
        showFlash(id, result === "updated" ? "已更新" : "已加入来自分享");
      } else {
        await navigator.clipboard.writeText(payload.content);
        setCopiedNote(true);
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setCopiedNote(false), 4000);
      }
    } catch (e) {
      setFlash((cur) => (cur?.id === id ? null : cur));
      setRowError({ id, text: errorText(e) || "导入失败" });
    } finally {
      importingRef.current = null;
      setImportingId(null);
    }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key || unlocking) return;
    setUnlocking(true);
    setKeyError(null);
    try {
      const found: Record<string, SealPayload> = {};
      for (const entry of sealed) {
        if (unlocked[entry.id]) continue;
        const payload = await openSnippet(
          { v: 1, salt: entry.salt, iv: entry.iv, data: entry.data },
          key
        );
        if (payload) found[entry.id] = payload;
      }
      if (Object.keys(found).length === 0) {
        setKeyError("这把密钥打不开未公开的分享");
        return;
      }
      setUnlocked((cur) => ({ ...cur, ...found }));
      setKeyDraft("");
    } finally {
      setUnlocking(false);
    }
  }

  const nothingPublic = !loading && !loadError && visible.length === 0;
  const nothingPrivate =
    !showPrivate || (unlockedRows.length === 0 && lockedCount === 0);

  return (
    <div className="market">
      {catalog?.source === "bundled" && (
        <p className="market-banner">
          正在用安装包里的目录，暂时没连上最新分享
        </p>
      )}
      {copiedNote && <p className="market-note">{COPIED_NOTE}</p>}
      <input
        className="market-search"
        value={query}
        autoFocus
        placeholder="搜索分享…"
        aria-label="搜索分享"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
      />
      <div className="market-cats" role="radiogroup" aria-label="分类">
        <button
          type="button"
          className={`market-seg${categoryId === "all" ? " active" : ""}`}
          onClick={() => setCategoryId("all")}
        >
          全部
        </button>
        {(catalog?.categories ?? []).map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`market-seg${categoryId === cat.id ? " active" : ""}`}
            onClick={() => setCategoryId(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>
      <div className="market-scroll">
        {loadError ? (
          <div className="market-status">
            <span>{loadError}</span>
            <button type="button" className="market-retry" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="market-status">加载中…</div>
        ) : (
          <>
            {showPrivate && sealed.length > 0 && (
              <section className="market-private" aria-label="不公开">
                <div className="market-lock">
                  <div className="market-lock-title">不公开 · {sealed.length} 条</div>
                  <p className="market-summary">
                    这些分享没有名称和内容，输入密钥后才能查看。
                  </p>
                  {lockedCount > 0 && (
                    <form className="market-keyform" onSubmit={(e) => void unlock(e)}>
                      <input
                        className="market-key"
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        placeholder="密钥"
                        aria-label="密钥"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="submit"
                        className="market-import"
                        disabled={unlocking || !keyDraft.trim()}
                      >
                        查看
                      </button>
                    </form>
                  )}
                  {keyError && <div className="market-row-error">{keyError}</div>}
                </div>
                {q && lockedCount > 0 && (
                  <p className="market-summary">
                    还有 {lockedCount} 条未公开，搜索看不到它们。
                  </p>
                )}
                {unlockedRows.map((entry) => {
                  const payload = unlocked[entry.id];
                  const open = openId === entry.id;
                  const ownedRow = owned.has(entry.id);
                  return (
                    <div key={entry.id} className="market-item">
                      <div
                        className={`market-row${open ? " open" : ""}`}
                        onClick={() => setOpenId(open ? null : entry.id)}
                      >
                        <div className="market-main">
                          <div className="market-name">{payload.name}</div>
                          <div className="market-summary">{payload.summary}</div>
                        </div>
                        <button
                          type="button"
                          className="market-import"
                          disabled={importingId !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void importUnlocked(entry.id, payload);
                          }}
                        >
                          {ownedRow ? "更新" : "导入"}
                        </button>
                      </div>
                      {flash?.id === entry.id && (
                        <div className="market-flash">{flash.text}</div>
                      )}
                      {rowError?.id === entry.id && (
                        <div className="market-row-error">{rowError.text}</div>
                      )}
                      {open && <pre className="market-preview">{payload.content}</pre>}
                    </div>
                  );
                })}
              </section>
            )}
            {nothingPublic && nothingPrivate ? (
              <div className="market-empty">没有匹配的分享</div>
            ) : (
              visible.map((snip) => {
                const ownedRow = owned.has(snip.id);
                const open = openId === snip.id;
                return (
                  <div key={snip.id} className="market-item">
                    <div
                      className={`market-row${open ? " open" : ""}`}
                      onClick={() => setOpenId(open ? null : snip.id)}
                    >
                      <div className="market-main">
                        <div className="market-name">{snip.name}</div>
                        <div className="market-summary">{snip.summary}</div>
                      </div>
                      <button
                        type="button"
                        className="market-import"
                        disabled={importingId !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void importOne(snip);
                        }}
                      >
                        {ownedRow ? "更新" : "导入"}
                      </button>
                    </div>
                    {flash?.id === snip.id && (
                      <div className="market-flash">{flash.text}</div>
                    )}
                    {rowError?.id === snip.id && (
                      <div className="market-row-error">{rowError.text}</div>
                    )}
                    {open && <pre className="market-preview">{snip.content}</pre>}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}

async function fetchCatalogFile(): Promise<unknown> {
  const res = await fetch("/catalog-public.json");
  if (!res.ok) throw new Error("目录加载失败");
  const pub = (await res.json()) as Record<string, unknown>;
  let sealed: unknown[] = [];
  try {
    const privRes = await fetch("/catalog-private.json");
    if (privRes.ok) {
      const priv = (await privRes.json()) as { entries?: unknown };
      if (Array.isArray(priv.entries)) sealed = priv.entries;
    }
  } catch {
    sealed = [];
  }
  return { ...pub, sealed };
}

function parseCatalog(raw: unknown): CatalogPayload {
  if (!raw || typeof raw !== "object") throw new Error("目录格式不对");
  const rec = raw as Partial<CatalogPayload>;
  if (!Array.isArray(rec.categories)) throw new Error("目录格式不对");
  const source =
    rec.source === "bundled" || rec.source === "remote" ? rec.source : undefined;
  return {
    version: typeof rec.version === "number" ? rec.version : 0,
    categories: rec.categories,
    sealed: Array.isArray(rec.sealed) ? rec.sealed.filter(isSealed) : [],
    source,
  };
}

function isSealed(value: unknown): value is SealedEntry {
  if (!value || typeof value !== "object") return false;
  const rec = value as SealedEntry;
  return (
    typeof rec.id === "string" &&
    rec.id.length > 0 &&
    rec.v === 1 &&
    typeof rec.salt === "string" &&
    typeof rec.iv === "string" &&
    typeof rec.data === "string"
  );
}

function matchesQuery(snip: CatalogSnippet, q: string): boolean {
  if (snip.name.toLowerCase().includes(q)) return true;
  if ((snip.summary || "").toLowerCase().includes(q)) return true;
  if ((snip.content || "").toLowerCase().includes(q)) return true;
  return (snip.tags || []).some((tag) => tag.toLowerCase().includes(q));
}

function matchesUnlocked(payload: SealPayload, q: string): boolean {
  if (payload.name.toLowerCase().includes(q)) return true;
  if ((payload.summary || "").toLowerCase().includes(q)) return true;
  if ((payload.content || "").toLowerCase().includes(q)) return true;
  return (payload.tags || []).some((tag) => tag.toLowerCase().includes(q));
}

/** Catalog ids already present, either via sourceId or the shared-{id} key. */
function ownedCatalogIds(nodes: SnippetNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: SnippetNode[]) => {
    for (const n of list) {
      if (n.kind === "folder") {
        walk(n.children);
        continue;
      }
      if (n.sourceId) out.add(n.sourceId);
      const prefix = "shared-";
      if (n.id.startsWith(prefix)) out.add(n.id.slice(prefix.length));
    }
  };
  walk(nodes);
  return out;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e.trim();
  if (e instanceof Error && e.message) return e.message;
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg === "string") return msg.trim();
  return "";
}
