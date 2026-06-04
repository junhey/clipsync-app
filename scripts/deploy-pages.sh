#!/usr/bin/env bash
#
# 把 docs/pages/ 部署到 clipsync-app 的 gh-pages 分支.
# GitHub Pages 已配置为从 gh-pages 分支根目录服务,
# 上线后访问 https://junhey.github.io/clipsync-app/

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "不在 git 仓库"; exit 1; }
PAGES_SRC="$REPO_ROOT/docs/pages"
PUBLIC_REPO="${PUBLIC_REPO:-junhey/clipsync-app}"

[ -d "$PAGES_SRC" ] || { echo "找不到 $PAGES_SRC"; exit 1; }

echo "🌐 部署官网到 ${PUBLIC_REPO}#gh-pages"
TMP="$(mktemp -d -t cs-pages)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$PAGES_SRC"/* "$TMP"/
cd "$TMP"
git init -q -b gh-pages
git add -A
git -c user.email=clipsync-pages@local -c user.name="ClipSync Pages" \
    commit -q -m "ClipSync website (auto-generated)"
git remote add origin "https://github.com/${PUBLIC_REPO}.git"
git push -q --force origin gh-pages
echo "✓ 已 push gh-pages, 1-2 分钟后访问 https://junhey.github.io/clipsync-app/"
