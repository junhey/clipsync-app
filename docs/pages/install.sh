#!/usr/bin/env bash
# ClipSync 一键安装脚本
# 用法: curl -fsSL https://junhey.github.io/clipsync-app/install.sh | bash
#
# 做的事:
#   1. 检查 macOS 平台 + 架构
#   2. 从 GitHub Releases 拉最新 .tar.gz / .dmg
#   3. 解到 /Applications/ClipSync.app
#   4. 移除 com.apple.quarantine 属性（绕过未签名警告）
#   5. ad-hoc 签名（codesign --sign -）
#   6. 启动应用

set -euo pipefail

REPO="junhey/clipsync-app"
APP_NAME="ClipSync.app"
APP_PATH="/Applications/${APP_NAME}"

# ── pretty output ────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
info()  { printf '   %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m⚠\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

bold "🚀 ClipSync 一键安装"
echo

# ── 1. platform check ────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "目前仅支持 macOS。其他平台请到 https://github.com/${REPO}/releases 手动下载。"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ASSET_SUFFIX="aarch64.app.tar.gz" ;;
  x86_64) ASSET_SUFFIX="x64.app.tar.gz"     ;;
  *) die "未知架构 $ARCH";;
esac
ok "平台检测通过 (macOS / $ARCH)"

# ── 2. find latest release asset ─────────────────────────────────────────
info "查询最新版本..."
LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
  || die "无法连接到 GitHub API。检查网络或代理。")"

VERSION="$(printf '%s' "$LATEST_JSON" | grep -m1 '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
[ -n "$VERSION" ] || die "未找到 Release。请到 https://github.com/${REPO}/releases 检查。"
ok "最新版本: $VERSION"

ASSET_URL="$(printf '%s' "$LATEST_JSON" \
  | grep -m1 -E "browser_download_url.*${ASSET_SUFFIX}\"" \
  | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/')"

if [ -z "$ASSET_URL" ]; then
  warn "未找到匹配 $ASSET_SUFFIX 的 release 资产，尝试通用 .tar.gz..."
  ASSET_URL="$(printf '%s' "$LATEST_JSON" \
    | grep -m1 'browser_download_url.*\.app\.tar\.gz' \
    | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/')"
fi
[ -n "$ASSET_URL" ] || die "找不到可下载的 .app 资产。"

# ── 3. quit existing instance ────────────────────────────────────────────
if pgrep -f "${APP_NAME}/Contents/MacOS" >/dev/null 2>&1; then
  info "退出已运行的 ClipSync..."
  osascript -e 'tell application "ClipSync" to quit' 2>/dev/null || true
  sleep 1
fi

# ── 4. download to tempdir ───────────────────────────────────────────────
TMP="$(mktemp -d -t clipsync-install)"
trap 'rm -rf "$TMP"' EXIT
info "下载: $ASSET_URL"
curl -fsSL "$ASSET_URL" -o "$TMP/clipsync.tar.gz" || die "下载失败"
ok "下载完成 ($(du -h "$TMP/clipsync.tar.gz" | cut -f1))"

# ── 5. extract + install ────────────────────────────────────────────────
info "解压..."
tar -xzf "$TMP/clipsync.tar.gz" -C "$TMP"
APP_SRC="$(find "$TMP" -maxdepth 3 -type d -name "${APP_NAME}" | head -1)"
[ -n "$APP_SRC" ] || die "压缩包里没找到 ${APP_NAME}"

info "安装到 ${APP_PATH}..."
rm -rf "$APP_PATH"
cp -R "$APP_SRC" "/Applications/"
ok "已安装到 /Applications"

# ── 6. clear quarantine + ad-hoc sign ───────────────────────────────────
info "解除 macOS 隔离标记..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

info "ad-hoc 签名 (绕过未签名警告)..."
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || warn "签名跳过（可能影响首次启动）"

# ── 7. launch ────────────────────────────────────────────────────────────
ok "安装完成 — ClipSync $VERSION"
echo
bold "🎉 接下来"
echo
echo "  • 应用已启动，在屏幕右上角菜单栏找 📋 图标"
echo "  • 全局快捷键: ⌘⇧V        唤起弹窗"
echo "  • 直达粘贴:   ⌘⇧⌥1-9    不唤窗直接粘最近 N 条"
echo
echo "  GitHub 同步配置 (可选):"
echo "    1) 在 GitHub 创建一个名为 clipsync 的私有仓库"
echo "    2) 生成有 repo scope 的 fine-grained PAT"
echo "    3) 菜单栏 → 设置 → GitHub 同步 → 粘 PAT"
echo
echo "  文档: https://junhey.github.io/clipsync-app"
echo

open -a "$APP_PATH" || warn "自动启动失败，请手动打开应用"
