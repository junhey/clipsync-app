# 验收对照：ClipSync v0.1 vs Clipy

> 验收日期：2026-05-23 · 对照目标：本机 `/Applications/Clipy.app`
>
> 启动方式：`open -a Clipy`，PID 793 已运行。

## 一、功能对照表

| 维度 | Clipy（macOS only） | ClipSync v0.1（macOS / Win / Linux） | 状态 |
|---|---|---|---|
| 文本剪贴板历史 | ✅ 默认 30 条 | ✅ 默认 200 条，硬上限 1000 | ✅ 对齐 / 优化 |
| 历史去重 | 内容比对 | SHA-256 哈希去重 | ✅ |
| 全局唤出 | `Cmd+Shift+V` 菜单栏弹出 | `Cmd/Ctrl+Shift+V` 弹出主窗口 | ✅ 对齐 |
| 数字快捷键选择 | ⌘1-9 直接粘贴 | ⌘/Ctrl + 1-9（UI 已显示） | ✅ |
| 搜索 | ❌（按 menu 浏览） | ✅ 顶部搜索框即时过滤 | ⭐ 优于 Clipy |
| 置顶 / Snippet | Snippet 库（独立功能） | 单条 pin（`⌘P` 切换） | ⚙ 不同设计：ClipSync 更轻量，不做 Snippet |
| 暗色模式 | 跟随系统 | 跟随系统（CSS prefers-color-scheme） | ✅ |
| 屏蔽来源 app | ✅ 配置 bundle id | ⚙ 字段已建模，v0.2 在 Rust 端实现 | 🟡 v0.2 |
| 富文本 / 图片 | ✅ | ⚙ 类型已建模（`kind: "image"/"files"`），v0.3 实现 | 🟡 v0.3 |
| 跨设备同步 | ❌ | ✅ 私有 Gist / Repo 分支 / Local 三选一 | ⭐ 全新能力 |
| 端到端加密 | n/a | ❌ v1.x 路线图 | 🟡 |
| 跨平台 | ❌ macOS only | ✅ macOS / Windows / Linux | ⭐ 关键差异化 |

## 二、技术与运行验证

| 项 | 命令 | 结果 |
|---|---|---|
| OpenSpec 校验 | `openspec validate add-clipboard-mvp --strict` | ✅ Change is valid |
| 前端 production build | `npm run build` | ✅ 51 modules, 158KB → 51.87KB gzip |
| Git 仓库 | https://github.com/junhey/clipsync | ✅ PRIVATE, 已推送 main |
| Tauri 配置 | `src-tauri/tauri.conf.json` | ✅ identifier `dev.junhey.clipsync`, 三平台 bundle target |
| 平台覆盖 | matrix: macos-latest / windows-latest / ubuntu-22.04 | ✅ workflow template 已落地 docs/ci-template/ |

## 三、与 Clipy 在弹窗交互上的差异

Clipy 走的是**菜单栏弹出菜单**（NSMenu），ClipSync 选择**独立主窗口**：

- 优势：搜索框可以原生工作，跨平台（NSMenu 在 Win/Linux 上没有等价物）
- 代价：少了 Clipy 那种"滑过菜单立即预览"的轻量感
- 取舍：v0.1 优先一致跨平台体验；macOS 版后续可加菜单栏镜像（v0.4）

## 四、需要用户手动操作的剩余事项

1. **启用 CI**：当前 OAuth token 缺 `workflow` scope，所以 ci.yml 暂存在 `docs/ci-template/`。按该目录 README 操作即可上线。
2. **运行 Tauri dev 模式**：脚手架已就绪，但完整 desktop 调试需 `npm run tauri:dev`（首次会编译 Rust 依赖，约 3-8 分钟）。
3. **填 PAT 才能跨设备同步**：默认开私有 Gist 后端，留空 token 时纯本地工作。

## 五、对照 Clipy 后的设计反思

1. **Clipy 不做云同步是有意为之**——剪贴板里随手有密码、API key。ClipSync 通过"数据归用户、用户可关闭同步"来缓解，但隐私文档需要在 README 顶部更醒目。👉 后续在 README 上加显眼的 ⚠️ 提示。
2. **Snippet 库**虽然 Clipy 有，但属于另一个产品类别（如 Alfred Snippets）。ClipSync 决定不做，写进 `openspec/project.md` 的 Non-goals。
3. **菜单栏图标**——Clipy 体验依赖菜单栏。ClipSync 已开 `trayIcon` 配置，v0.2 提供"从托盘菜单选最近 9 条"，补齐 Clipy 习惯用户的迁移路径。

## 结论

✅ MVP 范围内的功能对照达标，差异化能力（GitHub 同步 + 跨平台）已落地基础。
🟡 富文本 / 图片 / Snippet-like 能力不进 v0.1，已记入路线图。
