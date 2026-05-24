//! Content-addressed sync backed by a regular GitHub repository.
//!
//! Layout on the `data` orphan branch:
//!
//! ```text
//!   index.json                # array of metadata records, each with `ref: <sha>`
//!   blobs/<sha[0:2]>/<sha>    # immutable content, dedup'd by sha
//! ```
//!
//! Every push creates a brand-new root commit on `data` (no parent) and
//! force-updates the ref. The repo's working size therefore stays equal to
//! the size of the *current* state — we never accumulate history.

use crate::state::ClipItem;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const API_BASE: &str = "https://api.github.com";
const BRANCH: &str = "data";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    pub id: String,
    pub kind: String,
    /// SHA-256 of the *content* (not of the git blob — those happen to coincide
    /// for utf-8 text since git computes its own sha; see notes below).
    /// For text: the body's SHA-256. For images: the image RGBA-pixel SHA-256.
    pub r#ref: String,
    /// Optional preview text (truncated body for text, placeholder for images).
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub hits: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexFile {
    pub version: u32,
    pub device: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub items: Vec<IndexEntry>,
}

fn blob_path(sha: &str) -> String {
    format!("blobs/{}/{}", &sha[..2], sha)
}

fn content_sha(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

fn ghc(token: &str) -> Client {
    Client::builder()
        .user_agent("ClipSync/0.5 (rust)")
        .timeout(std::time::Duration::from_secs(30))
        .default_headers({
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                "Accept",
                "application/vnd.github+json".parse().unwrap(),
            );
            h.insert(
                "X-GitHub-Api-Version",
                "2022-11-28".parse().unwrap(),
            );
            h.insert(
                "Authorization",
                format!("Bearer {token}").parse().unwrap(),
            );
            h
        })
        .build()
        .expect("reqwest client")
}

/// GET /user — used to default the repo to "<login>/clipsync".
pub async fn get_login(token: &str) -> Result<String, String> {
    let res = ghc(token)
        .get(format!("{API_BASE}/user"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GET /user: {}", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["login"].as_str().unwrap_or_default().to_string())
}

/// Returns the SHA of the `data` branch tip, or None if the branch doesn't exist yet.
pub async fn get_data_ref(token: &str, repo: &str) -> Result<Option<String>, String> {
    let res = ghc(token)
        .get(format!("{API_BASE}/repos/{repo}/git/ref/heads/{BRANCH}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("GET ref: {}", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["object"]["sha"].as_str().map(String::from))
}

/// Returns the set of file paths under blobs/ in the given tree (recursive).
async fn list_remote_blobs(
    token: &str,
    repo: &str,
    tree_sha: &str,
) -> Result<HashSet<String>, String> {
    let res = ghc(token)
        .get(format!(
            "{API_BASE}/repos/{repo}/git/trees/{tree_sha}?recursive=1"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GET tree: {}", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut out = HashSet::new();
    if let Some(arr) = v["tree"].as_array() {
        for entry in arr {
            if entry["type"].as_str() == Some("blob") {
                if let Some(p) = entry["path"].as_str() {
                    if p.starts_with("blobs/") {
                        out.insert(p.to_string());
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Upload one blob. Returns the git blob sha (we treat content sha as the
/// path, the *git* sha goes into the tree spec).
async fn create_blob(
    token: &str,
    repo: &str,
    content: &str,
    is_binary: bool,
) -> Result<String, String> {
    let body = if is_binary {
        json!({ "content": content, "encoding": "base64" })
    } else {
        json!({ "content": content, "encoding": "utf-8" })
    };
    let res = ghc(token)
        .post(format!("{API_BASE}/repos/{repo}/git/blobs"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let s = res.text().await.unwrap_or_default();
        return Err(format!("POST blob failed: {s}"));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["sha"].as_str().unwrap_or_default().to_string())
}

#[derive(Debug, Serialize)]
struct TreeEntry<'a> {
    path: &'a str,
    mode: &'a str, // "100644"
    r#type: &'a str, // "blob"
    sha: &'a str,
}

/// Build a fresh tree referencing all current blobs + the index. Returns the new tree sha.
async fn create_tree(
    token: &str,
    repo: &str,
    entries: &[TreeEntry<'_>],
) -> Result<String, String> {
    let body = json!({ "tree": entries });
    let res = ghc(token)
        .post(format!("{API_BASE}/repos/{repo}/git/trees"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let s = res.text().await.unwrap_or_default();
        return Err(format!("POST tree failed: {s}"));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["sha"].as_str().unwrap_or_default().to_string())
}

/// Create an *orphan* commit (no parents). Returns the commit sha.
async fn create_commit(
    token: &str,
    repo: &str,
    tree_sha: &str,
    message: &str,
) -> Result<String, String> {
    let body = json!({ "message": message, "tree": tree_sha, "parents": [] });
    let res = ghc(token)
        .post(format!("{API_BASE}/repos/{repo}/git/commits"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let s = res.text().await.unwrap_or_default();
        return Err(format!("POST commit failed: {s}"));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["sha"].as_str().unwrap_or_default().to_string())
}

/// Force-update (or create) refs/heads/data to point at the new commit.
async fn force_update_ref(
    token: &str,
    repo: &str,
    commit_sha: &str,
    create: bool,
) -> Result<(), String> {
    if create {
        let body = json!({ "ref": format!("refs/heads/{BRANCH}"), "sha": commit_sha });
        let res = ghc(token)
            .post(format!("{API_BASE}/repos/{repo}/git/refs"))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("POST ref: {}", res.status()));
        }
        Ok(())
    } else {
        let body = json!({ "sha": commit_sha, "force": true });
        let res = ghc(token)
            .patch(format!(
                "{API_BASE}/repos/{repo}/git/refs/heads/{BRANCH}"
            ))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("PATCH ref: {}", res.status()));
        }
        Ok(())
    }
}

/// Run a single sync round: push local state to the repo's data branch,
/// content-addressed and orphan-committed.
pub async fn sync_repo_once(
    token: &str,
    repo: &str,
    device: &str,
    items: Vec<ClipItem>,
    snippets: Vec<crate::snippets::SnippetNode>,
) -> Result<(), String> {
    // 1) See if data branch already exists. If not, create it from scratch.
    let head_sha = get_data_ref(token, repo).await?;
    let existing_blobs: HashSet<String> = match head_sha.as_deref() {
        Some(sha) => {
            // Resolve commit -> tree
            let res = ghc(token)
                .get(format!("{API_BASE}/repos/{repo}/git/commits/{sha}"))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("GET commit: {}", res.status()));
            }
            let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
            let tree_sha = v["tree"]["sha"].as_str().unwrap_or_default().to_string();
            list_remote_blobs(token, repo, &tree_sha).await?
        }
        None => HashSet::new(),
    };

    // 2) For each item, decide its body and content sha. Build:
    //    - entries: index.json IndexEntry list
    //    - to_upload: HashMap<sha, body>  (only blobs not already remote)
    let mut entries: Vec<IndexEntry> = Vec::with_capacity(items.len());
    let mut to_upload: HashMap<String, String> = HashMap::new();
    for it in items.into_iter() {
        if it.kind == "image" {
            entries.push(IndexEntry {
                id: it.id.clone(),
                kind: it.kind,
                r#ref: it.id.clone(),
                text: it.text,
                created_at: it.created_at,
                updated_at: it.updated_at,
                hits: it.hits,
                pinned: it.pinned,
                width: it.width,
                height: it.height,
                bytes: it.bytes,
                format: it.format,
            });
            continue;
        }
        let body = it.text.clone();
        let csha = content_sha(&body);
        let path = blob_path(&csha);
        if !existing_blobs.contains(&path) {
            to_upload.entry(csha.clone()).or_insert(body.clone());
        }
        entries.push(IndexEntry {
            id: it.id.clone(),
            kind: it.kind,
            r#ref: csha,
            text: body.chars().take(200).collect(),
            created_at: it.created_at,
            updated_at: it.updated_at,
            hits: it.hits,
            pinned: it.pinned,
            width: None,
            height: None,
            bytes: None,
            format: None,
        });
    }

    // Snippets: replace their `content` with the content sha and queue blobs.
    fn rewrite_snippets(
        nodes: Vec<crate::snippets::SnippetNode>,
        existing_blobs: &HashSet<String>,
        to_upload: &mut HashMap<String, String>,
    ) -> Vec<crate::snippets::SnippetNode> {
        nodes
            .into_iter()
            .map(|n| match n {
                crate::snippets::SnippetNode::Folder { id, name, children } => {
                    crate::snippets::SnippetNode::Folder {
                        id,
                        name,
                        children: rewrite_snippets(children, existing_blobs, to_upload),
                    }
                }
                crate::snippets::SnippetNode::Snippet {
                    id,
                    name,
                    content,
                    enabled,
                    created_at,
                    updated_at,
                } => {
                    let csha = content_sha(&content);
                    if !existing_blobs.contains(&blob_path(&csha)) {
                        to_upload.entry(csha.clone()).or_insert(content.clone());
                    }
                    // The serialized form keeps `content` as the SHA — readers
                    // load the blob lazily. Local copies still hold full text.
                    crate::snippets::SnippetNode::Snippet {
                        id,
                        name,
                        content: format!("@blob:{csha}"),
                        enabled,
                        created_at,
                        updated_at,
                    }
                }
            })
            .collect()
    }
    let snippets_serialized = rewrite_snippets(snippets, &existing_blobs, &mut to_upload);

    // 3) Upload missing blobs and remember their git sha.
    let mut blob_git_shas: HashMap<String, String> = HashMap::new();
    for (csha, body) in &to_upload {
        let git_sha = create_blob(token, repo, body, false).await?;
        blob_git_shas.insert(csha.clone(), git_sha);
    }

    // 4) For blobs that already exist remotely, we still need their git sha.
    let mut existing_path_to_sha: HashMap<String, String> = HashMap::new();
    if let Some(head) = head_sha.as_deref() {
        let res = ghc(token)
            .get(format!("{API_BASE}/repos/{repo}/git/commits/{head}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let tree_sha = v["tree"]["sha"].as_str().unwrap_or_default().to_string();
        let res = ghc(token)
            .get(format!(
                "{API_BASE}/repos/{repo}/git/trees/{tree_sha}?recursive=1"
            ))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(arr) = v["tree"].as_array() {
            for entry in arr {
                if entry["type"].as_str() == Some("blob") {
                    if let (Some(p), Some(s)) = (
                        entry["path"].as_str(),
                        entry["sha"].as_str(),
                    ) {
                        existing_path_to_sha.insert(p.to_string(), s.to_string());
                    }
                }
            }
        }
    }

    // 5) Build the tree:
    //    - blobs/<aa>/<sha> for every unique referenced sha (history + snippets)
    //    - index.json (history metadata)
    //    - snippets.json (snippet tree, content rewritten as @blob:<sha>)
    let index_file = IndexFile {
        version: 1,
        device: device.to_string(),
        updated_at: crate::state::now_ms(),
        items: entries.clone(),
    };
    let index_body = serde_json::to_string_pretty(&index_file).unwrap();
    let index_git_sha = create_blob(token, repo, &index_body, false).await?;

    let snippets_body = serde_json::to_string_pretty(&snippets_serialized).unwrap();
    let snippets_git_sha = create_blob(token, repo, &snippets_body, false).await?;

    let mut all_paths: HashSet<String> = HashSet::new();
    for e in &entries {
        if e.kind != "image" {
            all_paths.insert(blob_path(&e.r#ref));
        }
    }
    // Add every snippet content sha to the path set as well.
    fn collect_snippet_paths(
        nodes: &[crate::snippets::SnippetNode],
        out: &mut HashSet<String>,
    ) {
        for node in nodes {
            match node {
                crate::snippets::SnippetNode::Folder { children, .. } => {
                    collect_snippet_paths(children, out);
                }
                crate::snippets::SnippetNode::Snippet { content, .. } => {
                    if let Some(sha) = content.strip_prefix("@blob:") {
                        out.insert(blob_path(sha));
                    }
                }
            }
        }
    }
    collect_snippet_paths(&snippets_serialized, &mut all_paths);

    let mut tree_entries_owned: Vec<(String, String)> = Vec::new();
    for path in &all_paths {
        let sha = if let Some(csha) = path.rsplit('/').next() {
            if let Some(git_sha) = blob_git_shas.get(csha) {
                git_sha.clone()
            } else if let Some(git_sha) = existing_path_to_sha.get(path) {
                git_sha.clone()
            } else {
                continue;
            }
        } else {
            continue;
        };
        tree_entries_owned.push((path.clone(), sha));
    }
    tree_entries_owned.push(("index.json".to_string(), index_git_sha));
    tree_entries_owned.push(("snippets.json".to_string(), snippets_git_sha));

    let tree_entries: Vec<TreeEntry> = tree_entries_owned
        .iter()
        .map(|(p, s)| TreeEntry {
            path: p.as_str(),
            mode: "100644",
            r#type: "blob",
            sha: s.as_str(),
        })
        .collect();

    let new_tree_sha = create_tree(token, repo, &tree_entries).await?;
    let msg = format!(
        "clipsync: {} items, {} blobs ({})",
        entries.len(),
        all_paths.len(),
        chrono_now()
    );
    let new_commit_sha = create_commit(token, repo, &new_tree_sha, &msg).await?;
    force_update_ref(token, repo, &new_commit_sha, head_sha.is_none()).await?;

    Ok(())
}

/// Pull the index.json from the remote and return it.
pub async fn fetch_repo_index(token: &str, repo: &str) -> Result<Option<IndexFile>, String> {
    let head = match get_data_ref(token, repo).await? {
        Some(s) => s,
        None => return Ok(None),
    };
    // Resolve commit -> tree -> file
    let res = ghc(token)
        .get(format!(
            "{API_BASE}/repos/{repo}/contents/index.json?ref={BRANCH}"
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let raw = v["content"].as_str().unwrap_or_default().replace('\n', "");
    let bytes = B64.decode(raw.as_bytes()).map_err(|e| e.to_string())?;
    let s = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let f: IndexFile = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let _ = head;
    Ok(Some(f))
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("ts={secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_path_buckets_by_first_two() {
        assert_eq!(
            blob_path("ab12cdef"),
            "blobs/ab/ab12cdef".to_string()
        );
    }

    #[test]
    fn content_sha_is_stable() {
        let a = content_sha("hello world");
        let b = content_sha("hello world");
        assert_eq!(a, b);
    }
}
