# presentation-mode Specification

## Purpose
TBD - created by archiving change add-presentation-mode. Update Purpose after archive.
## Requirements
### Requirement: 三种应用呈现模式
应用 SHALL 提供三种 presentation mode 供用户选择：仅菜单栏、仅 Dock、菜单栏+Dock。

#### Scenario: 默认菜单栏
- **GIVEN** 应用首次安装
- **WHEN** 应用启动
- **THEN** SHALL 以菜单栏 app 形式运行：无 Dock 图标，菜单栏有图标
- **AND** macOS ActivationPolicy SHALL 为 Accessory

#### Scenario: 切换到仅 Dock
- **WHEN** 用户在设置中选择 "Dock"
- **THEN** 应用 SHALL 隐藏菜单栏图标
- **AND** ActivationPolicy SHALL 切到 Regular（Dock 图标出现）
- **AND** 应用 SHALL 弹一次提示：「菜单栏图标已隐藏，仍可通过全局快捷键唤出」

#### Scenario: 切换到 Dock + 菜单栏
- **WHEN** 用户选择 "Both"
- **THEN** 菜单栏图标 SHALL 保留可见
- **AND** ActivationPolicy SHALL 为 Regular（Dock 图标可见）

#### Scenario: 重启保持
- **GIVEN** 用户上次设置为 "dock"
- **WHEN** 应用重启
- **THEN** 应用 SHALL 自动应用为 Dock 模式（Regular policy + 菜单栏图标隐藏）

### Requirement: 切换无需重启
切换 presentation mode 在保存时 SHALL 立即生效，不需要重启应用。

#### Scenario: 实时切换
- **WHEN** 用户在设置面板从 "menubar" 切到 "both" 并保存
- **THEN** Dock 图标 SHALL 立即出现
- **AND** 菜单栏图标 SHALL 仍然可见
- **AND** 当前历史与片段状态 SHALL 不丢失

