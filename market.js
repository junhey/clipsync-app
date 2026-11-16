import { openSnippet } from "./seal.js";

const root = document.querySelector("#market-root");
const contents = new Map();

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function card(snip, id) {
  const key = String(id);
  contents.set(key, snip.content || "");
  const tags = (snip.tags || [])
    .map((tag) => `<li>${esc(tag)}</li>`)
    .join("");
  const hay = [snip.name, snip.summary, snip.content, ...(snip.tags || [])]
    .join(" ")
    .replace(/\s+/g, " ");
  return `<article class="snip" data-hay="${esc(hay)}">
    <div>
      <h3 class="snip-name">${esc(snip.name)}</h3>
      <p class="snip-summary">${esc(snip.summary || "")}</p>
      ${tags ? `<ul class="snip-tags">${tags}</ul>` : ""}
    </div>
    <pre class="snip-code" hidden>${esc(snip.content || "")}</pre>
    <div class="snip-actions">
      <button type="button" class="snip-toggle" aria-expanded="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.2 5.5 8 10.3l4.8-4.8 1.1 1.1L8 12.5 2.1 6.6z"/></svg>
        <span>查看内容</span>
      </button>
      <button type="button" class="btn btn-primary btn-sm snip-copy" data-id="${esc(key)}">复制</button>
    </div>
  </article>`;
}

function bind(scope) {
  scope.querySelectorAll(".snip-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = contents.get(btn.getAttribute("data-id")) || "";
      const label = btn.querySelector("span") || btn;
      const old = label.textContent;
      const done = (next) => {
        label.textContent = next;
        setTimeout(() => {
          label.textContent = old;
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => done("已复制"),
          () => done("请手动复制")
        );
      } else {
        done("请手动复制");
      }
    });
  });
  scope.querySelectorAll(".snip-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const article = btn.closest(".snip");
      const code = article.querySelector(".snip-code");
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      btn.querySelector("span").textContent = open ? "查看内容" : "收起内容";
      code.hidden = open;
      article.classList.toggle("is-open", !open);
    });
  });
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const state = { sealed: [], unlocked: {}, query: "", cat: "all" };

function renderPublic(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return `<p class="market-msg">暂时没有公开分享。</p>`;
  }
  return categories
    .map((cat) => {
      const cards = (cat.snippets || []).map((snip) => card(snip, snip.id)).join("");
      return `<section class="market-list" data-cat="${esc(cat.id)}">
        <h2 class="market-cat-title">${esc(cat.name || "")}</h2>
        <p class="market-blurb">${esc(cat.blurb || "")}</p>
        <div class="market-grid">${cards}</div>
      </section>`;
    })
    .join("");
}

function renderPrivate() {
  const total = state.sealed.length;
  if (total === 0) return "";
  const opened = state.sealed.filter((entry) => state.unlocked[entry.id]);
  const locked = total - opened.length;
  const cards = opened.map((entry) => card(state.unlocked[entry.id], entry.id)).join("");
  return `<section class="market-lockbox" id="private">
    <div>
      <h2>不公开 · ${total} 条</h2>
      <p class="market-blurb">这些分享没有名称和内容。密钥只在分享的人那里。</p>
    </div>
    ${
      locked
        ? `<form class="market-keyrow" id="key-form">
            <label class="visually-hidden" for="share-key">密钥</label>
            <input id="share-key" name="key" autocomplete="off" spellcheck="false" placeholder="输入密钥" />
            <button class="btn btn-primary" type="submit">查看</button>
          </form>
          <p class="market-msg" id="key-msg" hidden></p>
          <p class="market-locked-note">还有 ${locked} 条未打开。</p>`
        : `<div></div>`
    }
    ${cards ? `<div class="market-grid" style="grid-column: 1 / -1">${cards}</div>` : ""}
  </section>`;
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  let shown = 0;
  root.querySelectorAll(".market-list").forEach((section) => {
    const catOk = state.cat === "all" || section.dataset.cat === state.cat;
    let count = 0;
    section.querySelectorAll(".snip").forEach((article) => {
      const ok = catOk && (!q || (article.dataset.hay || "").toLowerCase().includes(q));
      article.hidden = !ok;
      if (ok) count += 1;
    });
    section.hidden = count === 0;
    shown += count;
  });
  root.querySelectorAll("#private .snip").forEach((article) => {
    const ok =
      state.cat === "all" && (!q || (article.dataset.hay || "").toLowerCase().includes(q));
    article.hidden = !ok;
    if (ok) shown += 1;
  });
  const empty = root.querySelector(".market-empty");
  if (empty) empty.hidden = shown > 0;
}

function paint(categories) {
  const cats = categories || [];
  root.innerHTML = `
    <div class="market-tools">
      <div class="market-filters" role="tablist" aria-label="分类">
        <button type="button" class="market-chip${state.cat === "all" ? " is-on" : ""}" data-cat="all" role="tab" aria-selected="${state.cat === "all"}">全部</button>
        ${cats
          .map(
            (cat) =>
              `<button type="button" class="market-chip${state.cat === cat.id ? " is-on" : ""}" data-cat="${esc(cat.id)}" role="tab" aria-selected="${state.cat === cat.id}">${esc(cat.name || "")}</button>`
          )
          .join("")}
      </div>
      <label class="market-search">
        <span class="visually-hidden">搜索分享</span>
        <input type="search" placeholder="搜索名称或内容" value="${esc(state.query)}" />
      </label>
    </div>
    ${renderPrivate()}
    <div id="market-lists">${renderPublic(cats)}</div>
    <p class="market-empty" hidden>没有匹配的分享</p>`;
  bind(root);
  root.querySelectorAll(".market-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.cat = chip.dataset.cat || "all";
      root.querySelectorAll(".market-chip").forEach((item) => {
        const on = item === chip;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-selected", on ? "true" : "false");
      });
      applyFilter();
    });
  });
  const search = root.querySelector(".market-search input");
  search.addEventListener("input", () => {
    state.query = search.value;
    applyFilter();
  });
  const form = root.querySelector("#key-form");
  if (form) {
    const remembered = form.querySelector("input");
    if (state.keyDraft) remembered.value = state.keyDraft;
    remembered.addEventListener("input", () => {
      state.keyDraft = remembered.value;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = remembered.value.trim();
      const msg = root.querySelector("#key-msg");
      if (!key) return;
      const submit = form.querySelector("button");
      submit.disabled = true;
      let found = 0;
      for (const entry of state.sealed) {
        if (state.unlocked[entry.id]) continue;
        const payload = await openSnippet(entry, key);
        if (payload) {
          state.unlocked[entry.id] = payload;
          found += 1;
        }
      }
      submit.disabled = false;
      if (!found) {
        msg.hidden = false;
        msg.textContent = "这把密钥打不开未公开的分享";
        return;
      }
      state.keyDraft = "";
      paint(categories);
    });
  }
  applyFilter();
}

try {
  const pub = await loadJson("./catalog-public.json");
  try {
    const priv = await loadJson("./catalog-private.json");
    state.sealed = Array.isArray(priv.entries) ? priv.entries : [];
  } catch {
    state.sealed = [];
  }
  paint(pub.categories || []);
} catch {
  root.innerHTML = `<p class="market-msg">目录暂时加载不了，请稍后再打开这一页。</p>`;
}
