#!/usr/bin/env bash
#
# 把 scripts/hooks/* 安装为 git hooks.
# 用 symlink 而非 cp, 这样以后改 hook 文件能自动生效.
#
# 用法: bash scripts/install-hooks.sh

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$ROOT/scripts/hooks"
HOOKS_DST="$ROOT/.git/hooks"

[ -d "$HOOKS_SRC" ] || { echo "找不到 $HOOKS_SRC"; exit 1; }
mkdir -p "$HOOKS_DST"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }

count=0
for hook_file in "$HOOKS_SRC"/*; do
  [ -f "$hook_file" ] || continue
  name="$(basename "$hook_file")"
  dst="$HOOKS_DST/$name"

  # 备份现有 hook (如果不是我们的 symlink)
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    bak="${dst}.backup.$(date +%s)"
    mv "$dst" "$bak"
    warn "原有 $name 已备份到 $bak"
  elif [ -L "$dst" ]; then
    rm "$dst"
  fi

  ln -s "$hook_file" "$dst"
  chmod +x "$hook_file"
  ok "安装 $name → $dst"
  count=$((count + 1))
done

echo
ok "已安装 $count 个 hook"
echo
info "测试方式:"
info "  改个文件 → git commit → git push"
info "  屏幕会显示「🔁 pre-push: 后台同步公开 mirror」"
info "  详细日志在 .git/clipsync-mirror.log"
echo
info "跳过方式:"
info "  git push --no-verify              (一次性)"
info "  CLIPSYNC_NO_MIRROR=1 git push    (本次跳过)"
