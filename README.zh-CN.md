# ClipSync

> 常驻菜单栏的跨平台剪贴板管理器 —— 同步走**你自己的 GitHub**，数据归你。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/junhey/clipsync-app)](https://github.com/junhey/clipsync-app/releases/latest)
[![Website](https://img.shields.io/badge/website-clipsync--app-blue)](https://junhey.github.io/clipsync-app/)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131)

**[English](README.md)** · **[官网与下载](https://junhey.github.io/clipsync-app/)**

## 特性

- 📋 **剪贴板历史**：文字与图片自动捕获，按时间倒序，重复内容自动合并并累计命中次数
- 🔍 **极速搜索**：一个快捷键唤出，输入即过滤；macOS 上连**截图里的文字**也能搜（本机 OCR，不联网）
- ⚡ **选中即粘贴**：回车选中后直接粘贴回你刚才的应用；也可以关掉，变成「仅复制」
- ⌨️ **全键盘操作**：`⌘/Ctrl+1-9` 粘贴第 N 条，`⌘⇧⌥1-9` 不弹窗直达粘贴，`Tab` 切换页签，`Esc` 两段式关闭
- 📝 **常用片段**：树形文件夹管理常用回复、地址与模板，独立编辑器窗口，可单个停用，支持 JSON 导入导出
- 🎁 **片段市场**：公开分享谁都能看；不公开的只存密文，拿密钥才能打开，密钥不会进仓库。目录文件不在公开源码镜像里。导入后放进本地文件夹「来自分享」。分享时可选公开或不公开，不公开的 Issue 里只有密文
- ☁️ **同步你做主**：私有 Gist / 私有仓库分支 / 仅本地三选一；PAT 只存系统钥匙串，不落任何文件
- 🔐 **默认隐私**：密码管理器（1Password / LastPass / KeePassXC / Bitwarden）默认屏蔽，支持自定义按应用排除
- 🪶 **轻量**：约 5 MB 安装包，原生暗色模式，闲置近零 CPU（0.6s → 3s 自适应轮询）
- 🖥️ **真·跨平台**：macOS / Windows / Linux 同一套代码，基于 Tauri 2

## 安装

**macOS 一键安装：**

```bash
curl -fsSL https://junhey.github.io/clipsync-app/install.sh | bash
```

**手动安装**：从 [Releases](https://github.com/junhey/clipsync-app/releases/latest) 下载 `ClipSync_*_aarch64.app.tar.gz`，拖入 `/Applications`，首次运行前执行一次：

```bash
xattr -dr com.apple.quarantine /Applications/ClipSync.app
```

**自行构建**（需要 Rust 1.77+ 与 Node 20+）：

```bash
git clone https://github.com/junhey/clipsync-app.git
cd clipsync-app
npm install
npm run tauri:build   # 产物在 src-tauri/target/release/bundle/
```

给公开仓库推送 `v*` 标签（或手动跑 Release 工作流）会在 GitHub Actions 里打出 macOS 与 Windows 安装包，先放进 Release 草稿。草稿发布之前，下载页仍是已经发布的 macOS 包。Linux 继续从源码构建。Windows 安装包没有代码签名，SmartScreen 可能提示未知发布者。

## 默认快捷键

| 操作 | macOS | Windows |
|---|---|---|
| 唤出 / 隐藏弹窗 | `⌘⇧V` | `Ctrl+Alt+V`（被占用时回退 `Ctrl+Shift+V`） |
| 粘贴第 1–9 条 | `⌘1-9` | `Ctrl+1-9` |
| 直达粘贴第 N 条（不弹窗） | `⌘⇧⌥1-9` | `Ctrl+Shift+Alt+1-9` |
| 置顶 / 取消置顶 | `⌘P` | `Ctrl+P` |
| 切换 历史 / 片段 | `Tab` | `Tab` |
| 片段编辑器 | `⌘E` | `Ctrl+E` |
| 清搜索 → 隐藏 | `Esc` | `Esc` |

所有快捷键都可以在设置里重绑。

## 同步模型

| 后端 | 适合谁 | 存储位置 |
|---|---|---|
| `repo`（默认） | 想要版本回溯 / 与其他工具集成 | `<你的账号>/clipsync` 私有仓库 `data` 分支下的 `history.json` |
| `gist` | 个人单人多设备 | 私有 Gist 中的 `history.json` |
| `local` | 完全离线 | 仅本机 `app_data_dir/history.json` |

合并策略：`updatedAt` 较新者胜；置顶取并集；命中次数累加；超出 `maxItems` 时优先保留置顶项。图片以 content-addressed blob 存储——相同截图永不重复占空间；`data` 分支每次同步 force-push 为单个根 commit，仓库体积始终 ≈ 当前历史数据量。

开启同步：在 **设置 → 同步** 贴上最小权限的 fine-grained PAT，点「检查连接」。仓库名留空时使用 `<你的用户名>/clipsync`，还没有这个仓库就尝试新建私有仓库。已经填了别的 `owner/repo` 就不会另建。Gist 需要一条已经存在的私有 Gist ID。Token 只存 macOS Keychain / Windows 凭据管理器。检查失败时，设置里会直接写明是 PAT、权限、仓库还是网络。

## 隐私

- 剪贴板内容只存在你的电脑和你自己的 GitHub 上，没有第三个去处
- 来源应用黑名单支持 `*` 通配；密码管理器默认屏蔽（macOS）
- 截图文字识别完全在本机进行，使用系统视觉框架，不联网（macOS）
- `local` 后端可完全离线使用

## 开发

```bash
npm install
npm run tauri:dev     # 桌面端热重载开发
npm run test          # 前端单测（vitest）
cd src-tauri && cargo test   # 后端单测
```

```
clipsync/
├── src/                # React 前端
│   ├── App.tsx         # 主弹窗：历史、搜索、设置
│   ├── SnippetsApp.tsx # 片段编辑器窗口
│   ├── bridge.ts       # JS ↔ Rust IPC 边界
│   └── sync.ts         # GitHub 同步逻辑（浏览器兜底）
├── src-tauri/          # Rust 后端
│   └── src/            # 剪贴板监听、托盘、热键、同步、OCR、存储
├── docs/pages/         # 项目官网（GitHub Pages）
└── openspec/           # 规范驱动开发流程（OpenSpec）
```

规范驱动的变更流程见 `openspec/AGENTS.md`。

## 许可

[MIT](LICENSE) © 2026 junhey
