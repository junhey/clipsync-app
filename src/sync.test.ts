import { describe, it, expect } from "vitest";
import { mergeHistory } from "./sync";
import type { ClipItem } from "./types";

function mk(
  id: string,
  updatedAt: number,
  pinned = false,
  hits = 1
): ClipItem {
  return {
    id,
    kind: "text",
    text: id,
    createdAt: updatedAt,
    updatedAt,
    hits,
    pinned: pinned || undefined,
  };
}

describe("mergeHistory", () => {
  it("dedupes by id, sums hits, takes latest updatedAt", () => {
    const local = [mk("a", 100, false, 2)];
    const remote = [mk("a", 200, false, 3)];
    const merged = mergeHistory(local, remote, 100);
    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(5);
    expect(merged[0].updatedAt).toBe(200);
  });

  it("union of pinned flags wins", () => {
    const local = [mk("a", 100, true)];
    const remote = [mk("a", 200, false)];
    const merged = mergeHistory(local, remote, 100);
    expect(merged[0].pinned).toBe(true);
  });

  it("sorts pinned first then by updatedAt desc", () => {
    const local = [mk("old", 50), mk("recent", 1000)];
    const remote = [mk("pinned", 10, true)];
    const merged = mergeHistory(local, remote, 100);
    expect(merged.map((i) => i.id)).toEqual(["pinned", "recent", "old"]);
  });

  it("respects maxItems while keeping all pinned", () => {
    const local = [mk("p", 5, true)];
    const remote = Array.from({ length: 10 }, (_, i) =>
      mk(`r${i}`, 100 + i)
    );
    const merged = mergeHistory(local, remote, 3);
    // pinned always kept, plus the 2 most recent non-pinned (r9, r8)
    expect(merged).toHaveLength(3);
    expect(merged.find((i) => i.id === "p")).toBeTruthy();
    expect(merged.find((i) => i.id === "r9")).toBeTruthy();
    expect(merged.find((i) => i.id === "r8")).toBeTruthy();
  });

  it("returns empty when both inputs empty", () => {
    expect(mergeHistory([], [], 10)).toEqual([]);
  });
});
