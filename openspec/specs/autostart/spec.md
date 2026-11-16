# autostart Specification

## Purpose
TBD - created by archiving change add-quality-of-life. Update Purpose after archive.
## Requirements
### Requirement: 开机自启可配置
应用 SHALL 提供"开机自启"选项；启用后 macOS / Windows / Linux 系统启动登录会自动以菜单栏形式启动 ClipSync。

#### Scenario: 用户首次开启
- **GIVEN** 设置面板"开机自启" 默认未勾选
- **WHEN** 用户勾选并保存设置
- **THEN** SHALL 调用底层 autostart 插件 enable，写入 OS 登录项
- **AND** 重启电脑后 ClipSync 自动以菜单栏 app 形式启动，不弹出主窗口

#### Scenario: 关闭自启
- **WHEN** 用户取消勾选并保存
- **THEN** SHALL 从 OS 登录项移除 ClipSync
- **AND** 下次重启不会自动启动

#### Scenario: 状态实时反映
- **WHEN** 用户打开设置面板
- **THEN** "开机自启"开关状态 SHALL 从插件 `is_enabled()` 实时读取，不依赖前端缓存

### Requirement: 首次启动引导用户启用自启
应用 SHALL 在用户**首次启动后未启用自启**时主动提示一次，并允许用户永久 dismiss。

#### Scenario: 首次启动且自启未开
- **GIVEN** 用户首次安装 ClipSync 并启动
- **AND** 应用读取到 OS 中 autostart 状态为 disabled
- **AND** 设置中 `onboardingShown=false`
- **WHEN** 应用初始化完成
- **THEN** 应用 SHALL 显示一次 onboarding 浮层
- **AND** 浮层 SHALL 包含按钮：「启用开机自启」「暂不启用」「不再提示」

#### Scenario: 选择「启用」
- **WHEN** 用户点击 "启用开机自启"
- **THEN** 应用 SHALL 调 autostart plugin enable
- **AND** 把 settings 的 `autostart=true` 与 `onboardingShown=true` 写回

#### Scenario: 选择「不再提示」
- **WHEN** 用户点击 "不再提示"
- **THEN** 应用 SHALL 把 `onboardingShown=true` 写回
- **AND** 之后启动不再弹出该浮层

#### Scenario: 已开启自启时不打扰
- **GIVEN** OS 中 autostart 已为 enabled
- **WHEN** 应用启动
- **THEN** 应用 SHALL NOT 弹出 onboarding 浮层
- **AND** SHALL 自动把 `onboardingShown` 视为已处理，避免下次再问

