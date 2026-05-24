# global-hotkey Specification

## Purpose
TBD - created by archiving change add-clipboard-mvp. Update Purpose after archive.
## Requirements
### Requirement: 默认全局快捷键唤出
应用 SHALL 注册一个默认全局快捷键以唤出/隐藏剪贴板弹窗。

#### Scenario: 首次启动注册默认快捷键
- **WHEN** 应用启动并完成初始化
- **THEN** SHALL 把 `CommandOrControl+Shift+V` 注册为全局快捷键
- **AND** 在 macOS 上为 `Cmd+Shift+V`，在 Windows / Linux 上为 `Ctrl+Shift+V`

#### Scenario: 按下快捷键时切换弹窗
- **WHEN** 主窗口当前隐藏
- **AND** 用户按下注册的全局快捷键
- **THEN** 主窗口 SHALL 显示并获得焦点
- **AND** 同时 emit `popup:toggle` 事件，前端搜索框获得焦点

#### Scenario: 再次按下时隐藏
- **WHEN** 主窗口当前可见
- **AND** 用户按下注册的全局快捷键
- **THEN** 主窗口 SHALL 隐藏

### Requirement: Esc 键关闭
弹窗 SHALL 响应 Esc 键以关闭自身。

#### Scenario: 在主列表按 Esc
- **WHEN** 弹窗主列表可见
- **AND** 用户按下 Esc
- **THEN** 主窗口 SHALL 隐藏

#### Scenario: 在设置面板按 Esc
- **WHEN** 设置面板打开
- **AND** 用户按下 Esc
- **THEN** SHALL 关闭设置面板，回到主列表（不隐藏窗口）

### Requirement: 快捷键设置持久化（v0.2 范围）
用户 SHALL 能在设置中查看当前快捷键文本。运行时变更将于 v0.2 引入。

#### Scenario: 在设置中查看
- **WHEN** 用户打开设置面板
- **THEN** "全局快捷键" 字段显示当前设定值（如 `CommandOrControl+Shift+V`）
- **AND** 旁注提示需重启应用以更换快捷键

### Requirement: 运行时变更全局快捷键
用户 SHALL 能在设置面板中修改全局唤出快捷键，保存后立即生效，不需要重启应用。

#### Scenario: 修改并保存
- **GIVEN** 当前快捷键为 `Cmd+Shift+V`
- **WHEN** 用户在设置中将快捷键改为 `Cmd+Option+C` 并保存
- **THEN** 应用 SHALL 立即 unregister 旧快捷键 → register 新快捷键
- **AND** 设置面板的 "需重启生效" 提示 SHALL 移除

#### Scenario: 注册失败回滚
- **WHEN** 用户输入的 accelerator 无法被 OS 接受（语法错或被占用）
- **THEN** 应用 SHALL 回滚为旧快捷键，并通过事件 `hotkey:error` 告知前端
- **AND** 前端显示一次性 toast 提示失败原因

