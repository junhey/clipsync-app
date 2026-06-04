# ClipSync

> 跨平台剪贴板管理器 · 灵感来自 [Clipy](https://github.com/Clipy/Clipy) · 数据存在你自己的 GitHub 上

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/junhey/clipsync-app)](https://github.com/junhey/clipsync-app/releases/latest)
[![Website](https://img.shields.io/badge/website-clipsync--app-blue)](https://junhey.github.io/clipsync-app/)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131)

## 特性

- 📋 **剪贴板历史**：自动捕获文本剪贴板，按最近使用排序
- 🔍 **快速搜索**：⌘+Shift+V 唤出，输入关键字即时过滤
- ⌨️ **全键盘操作**：⌘1-9 一键粘贴，⌘P 置顶，Esc 隐藏
- ☁️ **自带同步层**：私有 Gist (默认) / GitHub 仓库分支 / 仅本地，三选一
- 🔐 **数据归你**：内容只在你的 GitHub 账号 / 本机；token 用 fine-grained PAT
- 🖥️ **真·跨平台**：macOS / Windows / Linux 同一套代码 (基于 Tauri 2)
- 🌗 **原生暗色模式**

## 截图

> 第一次启动会问你要 GitHub PAT；不填也能用，只是不同步。

## 同步模型

| 后端 | 适合谁 | 文件 |
|---|---|---|
| `gist` (默认) | 个人单人多设备 | 私有 Gist 中的 `history.json` |
| `repo` | 想要版本回溯 / 与其他工具集成 | `<owner>/<repo>` 的 `data` 分支下 `history.json` |
| `local` | 不想联网 | 仅本机 `app_data_dir/history.json` |

合并策略：`updatedAt` 较新者胜；置顶取并集；命中次数累加；超出 `maxItems` 时优先保留置顶项。

## 开发

```bash
# 1. 装依赖
npm install

# 2. 跑桌面端
npm run tauri:dev

# 3. 打包 (产物在 src-tauri/target/release/bundle/)
npm run tauri:build
```

### 仅在浏览器里预览 UI

```bash
npm run dev
# 打开 http://localhost:5173 — 演示模式 (假数据)
```

## 项目布局

```
clipsync/
├── src/                # React 前端
│   ├── App.tsx         # 主界面 + 设置
│   ├── bridge.ts       # JS ↔ Rust IPC
│   ├── sync.ts         # GitHub 同步逻辑
│   └── types.ts        # 数据模型
├── src-tauri/          # Rust 后端
│   └── src/lib.rs      # 剪贴板监听 + 全局快捷键 + 持久化
├── openspec/           # 规范驱动开发流程 (OpenSpec)
└── docs/               # 技术文档
```

## 规范驱动开发

本项目使用 [OpenSpec](https://github.com/Fission-AI/OpenSpec)。任何新特性都先走变更提案：

```bash
openspec list                        # 查看活动变更
openspec show add-clipboard-history  # 看某个变更的细节
openspec validate add-clipboard-history --strict
```

详见 `openspec/AGENTS.md`。

## 鸣谢

- [Clipy](https://github.com/Clipy/Clipy) — 思想来源，macOS 上的经典剪贴板工具
- [Tauri](https://tauri.app/) — 跨平台桌面壳
- [OpenSpec](https://openspec.pro/) — 规范优先的 AI 协作流程

## 许可

MIT © 2026 junhey
