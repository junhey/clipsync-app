# paste-on-pick Specification

## Purpose
TBD - created by archiving change add-quality-of-life. Update Purpose after archive.
## Requirements
### Requirement: 选中后自动粘贴
应用 SHALL 支持 "Paste on pick" 模式：用户从历史中选择一条后，自动模拟系统粘贴快捷键，将内容粘到原前台 app。

#### Scenario: 默认关闭
- **GIVEN** 应用首次安装
- **WHEN** 用户从历史中选择一条
- **THEN** 仅完成"内容写回剪贴板"+"隐藏弹窗"两步，不模拟粘贴

#### Scenario: 开启后自动粘贴
- **GIVEN** 用户在设置中勾选 "选中后自动粘贴"
- **AND** macOS 已为 ClipSync 授予辅助功能权限
- **WHEN** 用户从历史中选择一条
- **THEN** 应用 SHALL 写回剪贴板 → 隐藏弹窗 → 等待 80ms 让前台 app 重新获得焦点 → 模拟 `Cmd+V`（macOS）或 `Ctrl+V`（Win/Linux）

#### Scenario: 缺少辅助功能权限
- **GIVEN** 用户开启 "选中后自动粘贴"
- **AND** 未授权辅助功能
- **WHEN** 用户从历史中选择一条
- **THEN** 内容已写回剪贴板（不会丢）
- **AND** 自动粘贴静默失败，前端显示一次性引导浮层："需要辅助功能权限，点击此处打开系统设置"
- **AND** 浮层提供按钮，跳转到 系统设置 → 隐私与安全 → 辅助功能

### Requirement: 引导链接
首次开启 "选中后自动粘贴" 时，应用 SHALL 提示用户授权流程。

#### Scenario: 首次勾选弹引导
- **WHEN** 用户在设置面板首次把 `pasteOnPick` 从 false 切到 true 并保存
- **THEN** 应用 SHALL 弹出说明对话框，包含权限介绍与"打开系统设置"按钮

