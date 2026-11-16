/**
 * One-shot sealer for the private catalog sample.
 * Encrypts with docs/pages/seal.js, then checks src/seal.ts can open it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openSnippet as openJs, sealSnippet, newShareKey } from "../docs/pages/seal.js";

const payload = {
  name: "事故复盘",
  summary: "出问题之后按这个顺序写，避免只贴日志。",
  tags: ["复盘", "协作"],
  content:
    "影响：谁受影响，持续了多久\n开始时间：\n发现方式：告警 / 用户反馈 / 自己发现\n原因：\n已经做的：\n接下来：\n怎么避免再出现：\n",
};

const key = newShareKey();
const envelope = await sealSnippet(payload, key);
const opened = await openJs(envelope, key);
if (!opened || opened.content !== payload.content || opened.name !== payload.name) {
  console.error("seal.js round-trip failed");
  process.exit(1);
}

let openTs;
try {
  ({ openSnippet: openTs } = await import("../src/seal.ts"));
} catch {
  openTs = null;
}
if (openTs) {
  const fromTs = await openTs(envelope, key);
  if (!fromTs || fromTs.content !== payload.content) {
    console.error("src/seal.ts could not open a seal.js envelope");
    process.exit(1);
  }
}

const file = {
  version: 1,
  entries: [{ id: "incident-review", ...envelope }],
};
writeFileSync(
  new URL("../catalog/private.json", import.meta.url),
  `${JSON.stringify(file, null, 2)}\n`
);
const note = `# 本地密钥，不要提交，也不要写进 Issue 或网页

## incident-review

密钥：\`${key}\`

名称：事故复盘
`;
writeFileSync(new URL("../catalog/keys.local.md", import.meta.url), note);
if (readFileSync(new URL("../catalog/private.json", import.meta.url), "utf8").includes(key)) {
  console.error("key leaked into private.json");
  process.exit(1);
}
if (readFileSync(new URL("../catalog/private.json", import.meta.url), "utf8").includes("事故复盘")) {
  console.error("plaintext leaked into private.json");
  process.exit(1);
}
console.log(key);
