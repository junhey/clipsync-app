import type { AppSettings, ClipItem, HistoryFile } from "./types";

/**
 * Fetch the latest history from the configured backend.
 * Returns null when the backend is "local" or has no remote state yet.
 *
 * `token` comes from the OS keyring (loaded once per sync round); we never
 * read or write it from `settings`.
 */
export async function fetchRemote(
  settings: AppSettings,
  token: string | null
): Promise<HistoryFile | null> {
  const { sync } = settings;
  if (sync.backend === "local") return null;
  if (!token) return null;

  if (sync.backend === "gist") {
    if (!sync.gistId) return null;
    const res = await fetch(`https://api.github.com/gists/${sync.gistId}`, {
      headers: ghHeaders(token),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gist fetch failed: ${res.status}`);
    const json = await res.json();
    const file = json.files?.["history.json"];
    if (!file?.content) return null;
    return parseHistory(file.content);
  }

  if (sync.backend === "repo") {
    if (!sync.repo) return null;
    const branch = sync.branch || "data";
    const path = sync.path || "history.json";
    const res = await fetch(
      `https://api.github.com/repos/${sync.repo}/contents/${path}?ref=${branch}`,
      { headers: ghHeaders(token) }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`repo fetch failed: ${res.status}`);
    const json = await res.json();
    const content = atob((json.content || "").replace(/\n/g, ""));
    return parseHistory(content);
  }
  return null;
}

/**
 * Push the merged history to the configured backend. Returns the gist id when
 * a new gist was created so callers can persist it.
 */
export async function pushRemote(
  settings: AppSettings,
  token: string | null,
  items: ClipItem[],
  device: string
): Promise<{ gistId?: string }> {
  const { sync } = settings;
  if (sync.backend === "local") return {};
  if (!token) throw new Error("missing token");

  const file: HistoryFile = {
    version: 1,
    device,
    updatedAt: Date.now(),
    items,
  };
  const content = JSON.stringify(file, null, 2);

  if (sync.backend === "gist") {
    if (sync.gistId) {
      const res = await fetch(`https://api.github.com/gists/${sync.gistId}`, {
        method: "PATCH",
        headers: ghHeaders(token),
        body: JSON.stringify({
          files: { "history.json": { content } },
        }),
      });
      if (!res.ok) throw new Error(`gist push failed: ${res.status}`);
      return {};
    }
    const res = await fetch(`https://api.github.com/gists`, {
      method: "POST",
      headers: ghHeaders(token),
      body: JSON.stringify({
        description: "ClipSync history",
        public: false,
        files: { "history.json": { content } },
      }),
    });
    if (!res.ok) throw new Error(`gist create failed: ${res.status}`);
    const json = await res.json();
    return { gistId: json.id };
  }

  if (sync.backend === "repo") {
    if (!sync.repo) throw new Error("missing repo settings");
    const branch = sync.branch || "data";
    const path = sync.path || "history.json";

    let sha: string | undefined;
    const probe = await fetch(
      `https://api.github.com/repos/${sync.repo}/contents/${path}?ref=${branch}`,
      { headers: ghHeaders(token) }
    );
    if (probe.ok) {
      const probeJson = await probe.json();
      sha = probeJson.sha;
    }

    const res = await fetch(
      `https://api.github.com/repos/${sync.repo}/contents/${path}`,
      {
        method: "PUT",
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: `clipsync: sync ${new Date().toISOString()}`,
          branch,
          content: btoa(unescape(encodeURIComponent(content))),
          sha,
        }),
      }
    );
    if (!res.ok) throw new Error(`repo push failed: ${res.status}`);
  }
  return {};
}

/**
 * Merge local + remote item lists. Newer updatedAt wins; pinned union; hits
 * are summed. Limit by maxItems while keeping pinned entries.
 */
export function mergeHistory(
  local: ClipItem[],
  remote: ClipItem[],
  maxItems: number
): ClipItem[] {
  const map = new Map<string, ClipItem>();
  for (const it of [...local, ...remote]) {
    const prev = map.get(it.id);
    if (!prev) {
      map.set(it.id, it);
      continue;
    }
    map.set(it.id, {
      ...prev,
      ...it,
      pinned: prev.pinned || it.pinned,
      hits: (prev.hits || 0) + (it.hits || 0),
      createdAt: Math.min(prev.createdAt, it.createdAt),
      updatedAt: Math.max(prev.updatedAt, it.updatedAt),
    });
  }
  const merged = [...map.values()].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
  if (merged.length <= maxItems) return merged;
  const pinned = merged.filter((it) => it.pinned);
  const rest = merged.filter((it) => !it.pinned);
  return [...pinned, ...rest.slice(0, Math.max(0, maxItems - pinned.length))];
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function parseHistory(content: string): HistoryFile | null {
  try {
    const j = JSON.parse(content) as HistoryFile;
    if (j && typeof j === "object" && Array.isArray(j.items)) return j;
  } catch {
    /* ignore */
  }
  return null;
}
