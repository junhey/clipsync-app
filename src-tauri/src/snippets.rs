//! User-managed snippets — long-lived clipboard templates organised in a
//! folder tree, separate from the auto-captured clipboard history.
//!
//! Persisted as `<app_data_dir>/snippets.json`. Synced to `data` branch as
//! `snippets.json`, with each snippet's content addressed in `blobs/`
//! exactly like history items (so dedup with history is automatic).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const SNIPPETS_FILE: &str = "snippets.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SnippetNode {
    Folder {
        id: String,
        name: String,
        #[serde(default)]
        children: Vec<SnippetNode>,
    },
    Snippet {
        id: String,
        name: String,
        content: String,
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default, rename = "createdAt")]
        created_at: i64,
        #[serde(default, rename = "updatedAt")]
        updated_at: i64,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Default)]
#[allow(dead_code)] // wired via AppState::snippets directly
pub struct SnippetsState {
    pub roots: Arc<Mutex<Vec<SnippetNode>>>,
}

fn snippets_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join(SNIPPETS_FILE)
}

pub fn load(app: &AppHandle) -> Vec<SnippetNode> {
    match std::fs::read_to_string(snippets_path(app)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save(app: &AppHandle, nodes: &[SnippetNode]) {
    if let Ok(json) = serde_json::to_string_pretty(nodes) {
        let _ = std::fs::write(snippets_path(app), json);
    }
}

/// Find a snippet by id (depth-first), returning a clone of its content + name.
pub fn find_snippet_content(roots: &[SnippetNode], id: &str) -> Option<(String, String)> {
    for node in roots {
        match node {
            SnippetNode::Snippet {
                id: nid,
                name,
                content,
                ..
            } if nid == id => {
                return Some((name.clone(), content.clone()));
            }
            SnippetNode::Folder { children, .. } => {
                if let Some(found) = find_snippet_content(children, id) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

/// Toggle enabled flag in-place.
pub fn toggle_enabled(roots: &mut [SnippetNode], id: &str) -> bool {
    for node in roots.iter_mut() {
        match node {
            SnippetNode::Snippet {
                id: nid, enabled, ..
            } if nid == id => {
                *enabled = !*enabled;
                return true;
            }
            SnippetNode::Folder { children, .. } => {
                if toggle_enabled(children, id) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Delete a node by id, anywhere in the tree.
pub fn delete_node(roots: &mut Vec<SnippetNode>, id: &str) -> bool {
    if let Some(pos) = roots.iter().position(|n| node_id(n) == id) {
        roots.remove(pos);
        return true;
    }
    for node in roots.iter_mut() {
        if let SnippetNode::Folder { children, .. } = node {
            if delete_node(children, id) {
                return true;
            }
        }
    }
    false
}

fn node_id(n: &SnippetNode) -> &str {
    match n {
        SnippetNode::Folder { id, .. } | SnippetNode::Snippet { id, .. } => id,
    }
}

/// Flatten tree into [(snippet_id, content)] for sync. Currently unused at
/// runtime — kept for the unit test and future bulk export.
#[allow(dead_code)]
pub fn flatten_snippets(roots: &[SnippetNode]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    walk(roots, &mut out);
    out
}

#[allow(dead_code)]
fn walk(nodes: &[SnippetNode], out: &mut Vec<(String, String)>) {
    for node in nodes {
        match node {
            SnippetNode::Snippet { id, content, .. } => {
                out.push((id.clone(), content.clone()));
            }
            SnippetNode::Folder { children, .. } => walk(children, out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(id: &str, content: &str) -> SnippetNode {
        SnippetNode::Snippet {
            id: id.into(),
            name: id.into(),
            content: content.into(),
            enabled: true,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn find_in_nested_folder() {
        let tree = vec![SnippetNode::Folder {
            id: "f1".into(),
            name: "git".into(),
            children: vec![snip("a", "git status")],
        }];
        let found = find_snippet_content(&tree, "a");
        assert_eq!(found.unwrap().1, "git status");
    }

    #[test]
    fn delete_removes_root_and_nested() {
        let mut tree = vec![
            snip("a", "x"),
            SnippetNode::Folder {
                id: "f1".into(),
                name: "f".into(),
                children: vec![snip("b", "y")],
            },
        ];
        assert!(delete_node(&mut tree, "b"));
        assert!(delete_node(&mut tree, "a"));
        assert_eq!(tree.len(), 1); // just the empty folder
    }

    #[test]
    fn flatten_visits_every_snippet() {
        let tree = vec![
            snip("a", "x"),
            SnippetNode::Folder {
                id: "f1".into(),
                name: "f".into(),
                children: vec![
                    snip("b", "y"),
                    SnippetNode::Folder {
                        id: "f2".into(),
                        name: "g".into(),
                        children: vec![snip("c", "z")],
                    },
                ],
            },
        ];
        let flat = flatten_snippets(&tree);
        let ids: Vec<&str> = flat.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }
}
