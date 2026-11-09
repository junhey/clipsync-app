import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "./bridge";
import Market from "./Market";
import { newShareId, newShareKey, sealSnippet } from "./seal";
import type { SnippetNode } from "./types";

/** Same submission page the desktop command opens. The query carries the
 *  title and body so the web preview can submit without the bridge. */
const SHARE_ISSUE_BASE = "https://github.com/junhey/clipsync-app/issues/new";

/**
 * The Snippet Editor — a separate window (`label: "snippets"` in tauri.conf).
 * Visual layout: toolbar across the top (add / folder / delete /
 * toggle / import / export) with a tree on the left and a textarea on the right.
 */
export default function SnippetsApp() {
  const [tree, setTree] = useState<SnippetNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showMarket, setShowMarket] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareKey, setShareKey] = useState<string | null>(null);
  const [shareBody, setShareBody] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  // Initial load + live updates.
  useEffect(() => {
    if (!tauriAvailable) {
      setTree(seed());
      return;
    }
    bridge.listSnippets().then(setTree);
    const un = bridge.onSnippetsUpdated((nodes) => setTree(nodes));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // F2 enters rename mode for the selected node.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2" && selectedId && !editingId) {
        // Rename belongs to the tree. Don't steal F2 from the market search.
        const target = e.target;
        if (target instanceof HTMLElement && target.closest(".market")) return;
        e.preventDefault();
        setEditingId(selectedId);
      } else if (e.key === "Escape" && editingId) {
        setEditingId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, editingId]);

  function persist(next: SnippetNode[]) {
    // Whole nodes go across, including sourceId. Rebuilding a snippet
    // field by field would drop the import link and the next import
    // would insert a duplicate.
    setTree(next);
    if (tauriAvailable) bridge.saveSnippets(next).catch(console.warn);
  }

  function addSnippet() {
    const id = makeId();
    const now = Date.now();
    const node: SnippetNode = {
      kind: "snippet",
      id,
      name: "新片段",
      content: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      // sourceId stays unset: this snippet was created here, not imported.
    };
    const next = insertInto(tree, currentFolderId(tree, selectedId), node);
    persist(next);
    setSelectedId(id);
    setEditingId(id);
  }

  function addFolder() {
    const id = makeId();
    const node: SnippetNode = {
      kind: "folder",
      id,
      name: "新文件夹",
      children: [],
    };
    const next = insertInto(tree, currentFolderId(tree, selectedId), node);
    persist(next);
    setSelectedId(id);
    setEditingId(id);
  }

  function deleteSelected() {
    if (!selectedId) return;
    const target = findNode(tree, selectedId);
    if (!target) return;
    const desc =
      target.kind === "folder"
        ? `文件夹「${target.name}」及其全部内容`
        : `片段「${target.name}」`;
    if (!confirm(`确定要删除${desc}？`)) return;
    persist(removeNode(tree, selectedId));
    setSelectedId(null);
  }

  function toggleSelected() {
    if (!selectedId) return;
    persist(updateNode(tree, selectedId, (n) =>
      n.kind === "snippet" ? { ...n, enabled: !n.enabled, updatedAt: Date.now() } : n
    ));
  }

  async function exportAll() {
    if (tauriAvailable) {
      const json = await bridge.exportSnippets();
      // Use a download link for now (no Tauri dialog plugin enabled).
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clipsync-snippets-${dateStamp()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      alert(JSON.stringify(tree, null, 2));
    }
  }

  function importAll() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      if (tauriAvailable) {
        try {
          const n = await bridge.importSnippets(text);
          alert(`已导入 ${n} 项`);
        } catch (e: any) {
          alert("导入失败：" + (e?.message || e));
        }
      } else {
        try {
          const parsed = JSON.parse(text) as SnippetNode[];
          setTree([...tree, ...parsed]);
        } catch (e: any) {
          alert("解析失败：" + e.message);
        }
      }
    };
    input.click();
  }

  const selected = selectedId ? findNode(tree, selectedId) : null;

  function shareSelected() {
    if (!selected || selected.kind !== "snippet") return;
    setShareKey(null);
    setShareBody(null);
    setShareCopied(false);
    setShareOpen(true);
  }

  async function openIssue(title: string, body: string) {
    if (tauriAvailable) {
      await bridge.openShareIssue(title, body);
      return;
    }
    window.open(shareIssueUrl(title, body), "_blank", "noopener,noreferrer");
  }

  async function sharePublic() {
    if (!selected || selected.kind !== "snippet" || shareBusy) return;
    const { name, content } = selected;
    setShareBusy(true);
    try {
      await openIssue(
        `分享片段：${name}`,
        `请把这条加入 catalog/public.json。\n\n名称：${name}\n\n内容：\n\`\`\`\n${content}\n\`\`\``
      );
      setShareOpen(false);
    } catch (e: unknown) {
      alert("打开投稿页失败：" + (errorText(e) || "请稍后再试"));
    } finally {
      setShareBusy(false);
    }
  }

  async function preparePrivate() {
    if (!selected || selected.kind !== "snippet" || shareBusy) return;
    const { name, content } = selected;
    setShareBusy(true);
    try {
      const key = newShareKey();
      const envelope = await sealSnippet(
        { name, summary: "", tags: [], content },
        key
      );
      const record = { id: newShareId(), ...envelope };
      setShareKey(key);
      setShareCopied(false);
      setShareBody(
        `请把下面的密文加入 catalog/private.json 的 entries。不要把密钥写进仓库或这条 Issue。\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``
      );
    } catch (e: unknown) {
      alert("加密失败：" + (errorText(e) || "请稍后再试"));
    } finally {
      setShareBusy(false);
    }
  }

  async function copyShareKey() {
    if (!shareKey) return;
    try {
      await navigator.clipboard.writeText(shareKey);
      setShareCopied(true);
    } catch {
      setShareCopied(false);
      alert("复制失败，请手动选中密钥复制。没有这把密钥就打不开这条分享。");
    }
  }

  async function openPrivateIssue() {
    if (!shareBody || !shareCopied || shareBusy) return;
    setShareBusy(true);
    try {
      await openIssue("分享片段（不公开）", shareBody);
      setShareOpen(false);
    } catch (e: unknown) {
      alert("打开投稿页失败：" + (errorText(e) || "请稍后再试"));
    } finally {
      setShareBusy(false);
    }
  }

  return (
    <div className="snippet-app">
      <div className="snippet-toolbar">
        <ToolBtn label="添加片段" variant="primary" onClick={addSnippet} />
        <ToolBtn label="添加文件夹" variant="secondary" onClick={addFolder} />
        <ToolBtn label="删除" variant="danger" onClick={deleteSelected} disabled={!selectedId} />
        <ToolBtn
          label={selected?.kind === "snippet" && selected.enabled ? "禁用" : "启用"}
          variant={selected?.kind === "snippet" && selected.enabled ? "warning" : "success"}
          onClick={toggleSelected}
          disabled={!selectedId || selected?.kind !== "snippet"}
        />
        <div className="toolbar-spacer" />
        <ToolBtn label="市场" onClick={() => setShowMarket((v) => !v)} />
        <ToolBtn
          label="分享"
          onClick={() => void shareSelected()}
          disabled={!selected || selected.kind !== "snippet"}
        />
        <ToolBtn label="导入" onClick={importAll} />
        <ToolBtn label="导出" onClick={exportAll} />
      </div>

      {showMarket ? (
        <div className="snippet-market">
          <Market snippets={tree} onChange={setTree} />
        </div>
      ) : (
      <div className="snippet-body">
        <div className="snippet-tree">
          <Tree
            nodes={tree}
            selectedId={selectedId}
            editingId={editingId}
            onSelect={(id) => {
              if (editingId && editingId !== id) setEditingId(null);
              setSelectedId(id);
            }}
            onRename={(id, name) =>
              persist(updateNode(tree, id, (n) => ({ ...n, name })))
            }
            onStartEdit={(id) => setEditingId(id)}
            onStopEdit={() => setEditingId(null)}
          />
        </div>
        <div className="snippet-editor">
          {selected && selected.kind === "snippet" ? (
            <>
              <div className="snippet-editor-meta">
                <input
                  className="snippet-editor-name"
                  value={selected.name}
                  onChange={(e) =>
                    persist(
                      updateNode(tree, selected.id, (n) => ({
                        ...n,
                        name: e.target.value,
                      }))
                    )
                  }
                />
                <span
                  className="snippet-status"
                  data-enabled={selected.enabled ? "yes" : "no"}
                >
                  {selected.enabled ? "已启用" : "已禁用"}
                </span>
              </div>
              <textarea
                value={selected.content}
                onChange={(e) =>
                  persist(
                    updateNode(tree, selected.id, (n) =>
                      n.kind === "snippet"
                        ? { ...n, content: e.target.value, updatedAt: Date.now() }
                        : n
                    )
                  )
                }
                placeholder="在此输入片段内容…"
                spellCheck={false}
              />
            </>
          ) : selected && selected.kind === "folder" ? (
            <div className="snippet-empty">
              <div className="snippet-folder-name">📁 {selected.name}</div>
              <p>选中片段以编辑内容，或在此文件夹下添加新片段。</p>
            </div>
          ) : (
            <div className="snippet-empty">
              <p>选择左侧列表中的片段开始编辑。</p>
              <p>或点击 ➕ 创建第一个片段。</p>
            </div>
          )}
        </div>
      </div>
      )}
      {shareOpen && selected && selected.kind === "snippet" && (
        <div
          className="share-mask"
          onClick={() => {
            if (!shareBusy) setShareOpen(false);
          }}
        >
          <div
            className="share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="share-title">分享这条片段</h2>
            {shareKey ? (
              <>
                <p>
                  这把密钥只显示这一次。投稿页和仓库里都不会出现它，丢了就打不开。
                </p>
                <input
                  className="share-key"
                  readOnly
                  value={shareKey}
                  aria-label="密钥"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="share-actions">
                  <button type="button" onClick={() => void copyShareKey()}>
                    {shareCopied ? "已复制密钥" : "复制密钥"}
                  </button>
                  {!shareCopied && (
                    <button type="button" onClick={() => setShareCopied(true)}>
                      我已抄下密钥
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!shareCopied || shareBusy}
                    onClick={() => void openPrivateIssue()}
                  >
                    打开投稿
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>公开的名称和内容会出现在市场里。不公开的只提交密文。</p>
                <div className="share-actions">
                  <button
                    type="button"
                    disabled={shareBusy}
                    onClick={() => void sharePublic()}
                  >
                    公开
                  </button>
                  <button
                    type="button"
                    disabled={shareBusy}
                    onClick={() => void preparePrivate()}
                  >
                    不公开
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function shareIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `${SHARE_ISSUE_BASE}?${params.toString()}`;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === "string" ? msg : "";
}

function ToolBtn({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "success" | "warning";
}) {
  return (
    <button
      type="button"
      className={["tool-btn", variant ? `tool-btn-${variant}` : ""].filter(Boolean).join(" ")}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function Tree({
  nodes,
  selectedId,
  editingId,
  onSelect,
  onRename,
  onStartEdit,
  onStopEdit,
  depth = 0,
}: {
  nodes: SnippetNode[];
  selectedId: string | null;
  editingId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onStartEdit: (id: string) => void;
  onStopEdit: () => void;
  depth?: number;
}) {
  return (
    <ul className="tree" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      {nodes.map((n) =>
        n.kind === "folder" ? (
          <li key={n.id}>
            <div
              className={`tree-node folder ${selectedId === n.id ? "active" : ""}`}
              onClick={() => onSelect(n.id)}
              onDoubleClick={() => onStartEdit(n.id)}
            >
              <span className="tree-icon">📁</span>
              {editingId === n.id ? (
                <RenameInput
                  initial={n.name}
                  onCommit={(v) => {
                    if (v) onRename(n.id, v);
                    onStopEdit();
                  }}
                  onCancel={onStopEdit}
                />
              ) : (
                <span className="tree-label">{n.name}</span>
              )}
            </div>
            {n.children.length > 0 && (
              <Tree
                nodes={n.children}
                selectedId={selectedId}
                editingId={editingId}
                onSelect={onSelect}
                onRename={onRename}
                onStartEdit={onStartEdit}
                onStopEdit={onStopEdit}
                depth={depth + 1}
              />
            )}
          </li>
        ) : (
          <li key={n.id}>
            <div
              className={`tree-node snippet ${selectedId === n.id ? "active" : ""} ${
                n.enabled ? "" : "disabled"
              }`}
              onClick={() => onSelect(n.id)}
              onDoubleClick={() => onStartEdit(n.id)}
            >
              <span className="tree-icon">📄</span>
              {editingId === n.id ? (
                <RenameInput
                  initial={n.name}
                  onCommit={(v) => {
                    if (v) onRename(n.id, v);
                    onStopEdit();
                  }}
                  onCancel={onStopEdit}
                />
              ) : (
                <span className="tree-label">{n.name}</span>
              )}
            </div>
          </li>
        )
      )}
    </ul>
  );
}

/** Inline rename input with auto-focus + select-all + Enter/Esc handling. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="tree-rename-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(v.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(v.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        // Don't bubble Tab/space etc. to outer key handlers.
        e.stopPropagation();
      }}
    />
  );
}

// ── Tree helpers (immutable update) ──────────────────────────────────────

function findNode(tree: SnippetNode[], id: string): SnippetNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.kind === "folder") {
      const r = findNode(n.children, id);
      if (r) return r;
    }
  }
  return null;
}

function currentFolderId(tree: SnippetNode[], id: string | null): string | null {
  if (!id) return null;
  // If selected is a folder, insert into it; if snippet, insert at root.
  const n = findNode(tree, id);
  return n && n.kind === "folder" ? id : null;
}

function insertInto(
  tree: SnippetNode[],
  parentId: string | null,
  node: SnippetNode
): SnippetNode[] {
  if (!parentId) return [...tree, node];
  return tree.map((n) => {
    if (n.kind === "folder") {
      if (n.id === parentId) return { ...n, children: [...n.children, node] };
      return { ...n, children: insertInto(n.children, parentId, node) };
    }
    return n;
  });
}

function removeNode(tree: SnippetNode[], id: string): SnippetNode[] {
  const out: SnippetNode[] = [];
  for (const n of tree) {
    if (n.id === id) continue;
    if (n.kind === "folder") {
      out.push({ ...n, children: removeNode(n.children, id) });
    } else {
      out.push(n);
    }
  }
  return out;
}

function updateNode(
  tree: SnippetNode[],
  id: string,
  fn: (n: SnippetNode) => SnippetNode
): SnippetNode[] {
  return tree.map((n) => {
    if (n.id === id) return fn(n);
    if (n.kind === "folder") return { ...n, children: updateNode(n.children, id, fn) };
    return n;
  });
}

function makeId(): string {
  return `snip-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(
    36
  )}`;
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function seed(): SnippetNode[] {
  const now = Date.now();
  return [
    {
      kind: "folder",
      id: "demo-git",
      name: "git",
      children: [
        {
          kind: "snippet",
          id: "demo-1",
          name: "codebuddy",
          content: "codebuddy --dangerously-skip-permissions",
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ];
}
