//! Shared snippet catalog.
//!
//! Public snippets are fetched from the Pages catalog. A failed fetch keeps
//! the empty stub compiled into the binary (`catalog/bundled.json`). Sealed
//! shares are fetched separately and stay ciphertext; they are not compiled in.

use crate::snippets::SnippetNode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PUBLIC_URL: &str = "https://junhey.github.io/clipsync-app/catalog-public.json";
const PRIVATE_URL: &str = "https://junhey.github.io/clipsync-app/catalog-private.json";
const BUNDLED_CATALOG_FILE: &str = "catalog/bundled.json";
const BUNDLED_CATALOG_JSON: &str = include_str!("../../catalog/bundled.json");

const INBOX_ID: &str = "shared-inbox";
const INBOX_NAME: &str = "来自分享";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogFile {
    pub version: u32,
    pub categories: Vec<CatalogCategory>,
}

impl Default for CatalogFile {
    fn default() -> Self {
        Self {
            version: 0,
            categories: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCategory {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub snippets: Vec<CatalogSnippet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogSnippet {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub author: String,
    pub content: String,
}

/// Ciphertext for one private share. Plaintext fields stay inside `data`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedSnippet {
    pub id: String,
    pub v: u32,
    pub salt: String,
    pub iv: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
struct PrivateFile {
    entries: Vec<SealedSnippet>,
}

/// Payload returned by `load_catalog`: the public catalog, sealed shares,
/// and where the public half came from (`"remote"` or `"bundled"`).
#[derive(Debug, Clone, Serialize)]
pub struct LoadedCatalog {
    pub version: u32,
    pub categories: Vec<CatalogCategory>,
    pub sealed: Vec<SealedSnippet>,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    Added,
    Updated,
}

impl ImportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ImportKind::Added => "added",
            ImportKind::Updated => "updated",
        }
    }
}

/// Catalog JSON compiled into the binary.
///
/// Panics if that file does not parse. The message includes the file name
/// so a broken catalog fails the test run instead of shipping an empty list.
pub fn bundled_catalog() -> CatalogFile {
    serde_json::from_str(BUNDLED_CATALOG_JSON).unwrap_or_else(|err| {
        panic!("failed to parse {BUNDLED_CATALOG_FILE}: {err}");
    })
}

pub fn find_snippet<'a>(catalog: &'a CatalogFile, id: &str) -> Option<&'a CatalogSnippet> {
    catalog
        .categories
        .iter()
        .flat_map(|category| category.snippets.iter())
        .find(|snippet| snippet.id == id)
}

/// Insert `item` into `roots`, or refresh the snippet already imported from it.
///
/// Match is by `source_id` anywhere in the tree. A new snippet is placed at
/// the front of the `shared-inbox` folder (`来自分享`), which is created at
/// the front of `roots` when missing.
pub fn import_into(roots: &mut Vec<SnippetNode>, item: &CatalogSnippet, now_ms: i64) -> ImportKind {
    if update_by_source_id(roots, item, now_ms) {
        return ImportKind::Updated;
    }
    let snippet = SnippetNode::Snippet {
        id: format!("shared-{}", item.id),
        name: item.name.clone(),
        content: item.content.clone(),
        enabled: true,
        created_at: now_ms,
        updated_at: now_ms,
        source_id: Some(item.id.clone()),
    };
    if let Some(snippet) = place_in_inbox(roots, snippet) {
        roots.insert(
            0,
            SnippetNode::Folder {
                id: INBOX_ID.to_string(),
                name: INBOX_NAME.to_string(),
                children: vec![snippet],
            },
        );
    }
    ImportKind::Added
}

/// Fetch the public catalog and the sealed list.
///
/// A failed public fetch falls back to the bundled stub. A failed sealed
/// fetch becomes an empty list. Neither failure panics.
pub async fn fetch_catalog() -> (CatalogFile, Vec<SealedSnippet>, &'static str) {
    let client = match reqwest::Client::builder()
        .user_agent("ClipSync")
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(_) => return (bundled_catalog(), Vec::new(), "bundled"),
    };
    let public_file = fetch_json::<CatalogFile>(&client, PUBLIC_URL);
    let private_file = fetch_json::<PrivateFile>(&client, PRIVATE_URL);
    let (public_file, private_file) = tokio::join!(public_file, private_file);
    let (file, source) = match public_file {
        Some(file) => (file, "remote"),
        None => (bundled_catalog(), "bundled"),
    };
    let sealed = private_file.map(|file| file.entries).unwrap_or_default();
    (file, sealed, source)
}

async fn fetch_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Option<T> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    serde_json::from_str(&body).ok()
}

fn update_by_source_id(nodes: &mut [SnippetNode], item: &CatalogSnippet, now_ms: i64) -> bool {
    for node in nodes {
        match node {
            SnippetNode::Snippet {
                source_id,
                name,
                content,
                updated_at,
                ..
            } if source_id.as_deref() == Some(item.id.as_str()) => {
                *name = item.name.clone();
                *content = item.content.clone();
                *updated_at = now_ms;
                return true;
            }
            SnippetNode::Folder { children, .. } => {
                if update_by_source_id(children, item, now_ms) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Put `snippet` at the front of the inbox folder, searching the whole tree.
/// Returns the snippet when no inbox folder exists yet.
fn place_in_inbox(nodes: &mut [SnippetNode], mut snippet: SnippetNode) -> Option<SnippetNode> {
    for node in nodes.iter_mut() {
        let SnippetNode::Folder { id, children, .. } = node else {
            continue;
        };
        if id == INBOX_ID {
            children.insert(0, snippet);
            return None;
        }
        match place_in_inbox(children, snippet) {
            None => return None,
            Some(returned) => snippet = returned,
        }
    }
    Some(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(id: &str, name: &str, content: &str) -> CatalogSnippet {
        CatalogSnippet {
            id: id.into(),
            name: name.into(),
            summary: String::new(),
            tags: Vec::new(),
            author: String::new(),
            content: content.into(),
        }
    }

    fn node_count(nodes: &[SnippetNode]) -> usize {
        nodes
            .iter()
            .map(|node| match node {
                SnippetNode::Folder { children, .. } => 1 + node_count(children),
                SnippetNode::Snippet { .. } => 1,
            })
            .sum()
    }

    fn inbox_count(nodes: &[SnippetNode]) -> usize {
        nodes
            .iter()
            .map(|node| match node {
                SnippetNode::Folder { id, children, .. } => {
                    usize::from(id == INBOX_ID) + inbox_count(children)
                }
                SnippetNode::Snippet { .. } => 0,
            })
            .sum()
    }

    #[test]
    fn bundled_catalog_is_an_empty_stub() {
        let catalog = bundled_catalog();
        assert_eq!(catalog.version, 1);
        assert!(catalog.categories.is_empty());
    }

    #[test]
    fn import_twice_updates_in_place() {
        let mut roots = Vec::new();
        let first = sample("port-who-listens", "端口", "lsof 1");
        assert_eq!(import_into(&mut roots, &first, 10), ImportKind::Added);
        assert_eq!(inbox_count(&roots), 1);
        assert_eq!(roots.len(), 1);

        let before = node_count(&roots);
        let second = sample("port-who-listens", "谁在听", "lsof 2");
        assert_eq!(import_into(&mut roots, &second, 20), ImportKind::Updated);
        assert_eq!(node_count(&roots), before);
        assert_eq!(inbox_count(&roots), 1);

        match &roots[0] {
            SnippetNode::Folder { id, name, children } => {
                assert_eq!(id, INBOX_ID);
                assert_eq!(name, INBOX_NAME);
                assert_eq!(children.len(), 1);
                match &children[0] {
                    SnippetNode::Snippet {
                        id,
                        name,
                        content,
                        enabled,
                        created_at,
                        updated_at,
                        source_id,
                    } => {
                        assert_eq!(id, "shared-port-who-listens");
                        assert_eq!(name, "谁在听");
                        assert_eq!(content, "lsof 2");
                        assert!(*enabled);
                        assert_eq!(*created_at, 10);
                        assert_eq!(*updated_at, 20);
                        assert_eq!(source_id.as_deref(), Some("port-who-listens"));
                    }
                    _ => panic!("inbox should hold the imported snippet"),
                }
            }
            _ => panic!("inbox folder should be the only root"),
        }
    }

    #[test]
    fn unknown_id_is_not_found() {
        let catalog = bundled_catalog();
        assert!(find_snippet(&catalog, "does-not-exist").is_none());
        assert!(find_snippet(&catalog, "").is_none());
    }

    #[test]
    fn second_snippet_is_prepended_in_the_same_inbox() {
        let mut roots = vec![SnippetNode::Folder {
            id: "mine".into(),
            name: "mine".into(),
            children: Vec::new(),
        }];
        assert_eq!(
            import_into(&mut roots, &sample("a", "A", "aaa"), 1),
            ImportKind::Added
        );
        assert_eq!(
            import_into(&mut roots, &sample("b", "B", "bbb"), 2),
            ImportKind::Added
        );
        assert_eq!(inbox_count(&roots), 1);
        assert_eq!(roots.len(), 2);
        match &roots[0] {
            SnippetNode::Folder { id, children, .. } => {
                assert_eq!(id, INBOX_ID);
                assert_eq!(children.len(), 2);
                match (&children[0], &children[1]) {
                    (
                        SnippetNode::Snippet { id: newest, .. },
                        SnippetNode::Snippet { id: older, .. },
                    ) => {
                        assert_eq!(newest, "shared-b");
                        assert_eq!(older, "shared-a");
                    }
                    _ => panic!("inbox children should be snippets"),
                }
            }
            _ => panic!("inbox should be inserted at the front"),
        }
    }
}
