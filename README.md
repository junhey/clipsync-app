# ClipSync 官网

静态站，零依赖。

## 本地预览

```bash
# 任意 HTTP 服务即可
cd docs/pages && python3 -m http.server 8000
# 访问 http://localhost:8000
```

## 部署

### EdgeOne Pages（推荐，国内访问快）

1. 在 EdgeOne 控制台新建 Pages 项目，连接 `junhey/clipsync` 仓库
2. **Build 命令**：留空（纯静态）
3. **输出目录**：`docs/pages`
4. 推送即自动部署

### GitHub Pages

```bash
# 仓库设置 → Pages → Source: Branch=main, /docs
# 但 Pages 默认根目录是 /docs（不能指定 docs/pages）
# 所以最简单是在 main 分支建一个独立的 gh-pages branch:
git subtree push --prefix docs/pages origin gh-pages
```

或者用 Cloudflare Pages：构建命令 `cp -r docs/pages dist`，输出 `dist`。

## 内容结构

- `index.html` — 主页（Hero / Features / Hotkeys / Install / FAQ）
- `style.css` — 全部样式，深浅色自动切换
- `favicon.svg` — 渐变方块 + 剪贴板图标

下载链接 (`#install`) 现在指向 `https://github.com/junhey/clipsync/releases`，记得在第一个 Release 上传 `.dmg` 或 `.app.tar.gz`。
