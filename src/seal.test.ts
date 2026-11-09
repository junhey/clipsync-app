import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newShareKey, openSnippet, sealSnippet } from "./seal";

describe("share seal", () => {
  it("round-trips a snippet and rejects the wrong key", async () => {
    const key = newShareKey();
    const payload = {
      name: "事故复盘",
      summary: "按顺序写",
      tags: ["复盘"],
      content: "影响：\n",
    };
    const envelope = await sealSnippet(payload, key);
    expect(envelope.v).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain("事故复盘");
    expect(JSON.stringify(envelope)).not.toContain(key);

    const opened = await openSnippet(envelope, key);
    expect(opened).toEqual(payload);
    expect(await openSnippet(envelope, `${key}x`)).toBeNull();
    expect(await openSnippet(envelope, "")).toBeNull();
  });

  it("opens the committed private sample with the local key", async () => {
    const keyPath = new URL("../catalog/keys.local.md", import.meta.url);
    const catalogPath = new URL("../catalog/private.json", import.meta.url);
    if (!existsSync(keyPath)) return;
    const key = readFileSync(keyPath, "utf8").match(/cs1_[A-Za-z0-9_-]+/)?.[0];
    const entry = JSON.parse(readFileSync(catalogPath, "utf8")).entries[0];
    expect(key).toBeTruthy();
    const opened = await openSnippet(entry, key!);
    expect(opened?.name).toBe("事故复盘");
    expect(opened?.content.startsWith("影响：")).toBe(true);
    expect(await openSnippet(entry, `${key}x`)).toBeNull();
  });
});
