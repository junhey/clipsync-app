import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { SnippetNode } from "./types";

/**
 * The Snippet Editor — a separate window (`label: "snippets"` in tauri.conf).
 * Visual layout follows Clipy: toolbar across the top (add / folder / delete /
 * toggle / import / export) with a tree on the left and a textarea on the right.
 */
export default function SnippetsApp() {
  const [tree, setTree] = useState<SnippetNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  return (
    <div className="snippet-app">
      <div className="snippet-toolbar">
        <ToolBtn label="添加片段" icon="📝" onClick={addSnippet} />
        <ToolBtn label="添加文件夹" icon="📁" onClick={addFolder} />
        <ToolBtn label="删除" icon="➖" onClick={deleteSelected} disabled={!selectedId} />
        <ToolBtn
          label="启用/禁用"
          icon={
            selected?.kind === "snippet" && selected.enabled
              ? "🟢"
              : selected?.kind === "snippet"
              ? "⚪"
              : "⏻"
          }
          onClick={toggleSelected}
          disabled={!selectedId || selected?.kind !== "snippet"}
        />
        <div className="toolbar-spacer" />
        <ToolBtn label="导入" icon="⬇" onClick={importAll} />
        <ToolBtn label="导出" icon="⬆" onClick={exportAll} />
      </div>

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
    </div>
  );
}

function ToolBtn({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="tool-btn"
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      <span className="tool-icon">{icon}</span>
      <span className="tool-label">{label}</span>
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
  // If selected is a folder, insert into it; if snippet, insert at root
  // (mirrors what Clipy does).
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
