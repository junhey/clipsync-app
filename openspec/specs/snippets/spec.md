# snippets Specification

## Purpose
TBD - created by archiving change add-snippets. Update Purpose after archive.
## Requirements
### Requirement: 片段数据模型
应用 SHALL 维护一组用户管理的、长期保留的片段（snippets），可组织在嵌套文件夹中，独立于自动捕获的剪贴板历史。

#### Scenario: 数据模型与持久化
- **WHEN** 用户创建一个片段
- **THEN** 片段 SHALL 持久化到 `<app_data_dir>/snippets.json`
- **AND** 片段拥有：`id`（uuid）、`name`、`content`（纯文本）、`enabled`（默认 true）、`createdAt`、`updatedAt`

#### Scenario: 文件夹组织
- **WHEN** 用户创建文件夹并把片段拖入
- **THEN** snippets.json 的树形结构 SHALL 反映该层级
- **AND** 文件夹自身仅有 `id, name, children[]`，无 content

### Requirement: 片段编辑器窗口
应用 SHALL 提供独立的「片段编辑器」窗口用于增删改查。

#### Scenario: 打开编辑器
- **WHEN** 用户在主弹窗按 ⌘E（在片段 tab 时）
- **OR** 用户按下设置中的「片段编辑器」全局快捷键
- **OR** 用户在设置面板点击「打开片段编辑器…」
- **THEN** 应用 SHALL 显示 `snippets` window（带标题栏、可缩放、关闭仅隐藏不退出）

#### Scenario: 工具栏功能完整
- **GIVEN** 编辑器窗口已打开
- **THEN** 工具栏 SHALL 提供 6 个操作：添加片段、添加文件夹、删除、启用/禁用、导入、导出

#### Scenario: 启用/禁用
- **WHEN** 用户切换某片段的启用状态为 false
- **THEN** 该片段在主弹窗的片段 tab 中 SHALL 灰显
- **AND** 仍可被点击调用，但不会出现在该 tab 的搜索快捷匹配里

### Requirement: 主弹窗调用片段
主弹窗 SHALL 提供片段 tab 与历史 tab 之间的切换，用户可在片段 tab 直接选择片段写回剪贴板。

#### Scenario: tab 切换
- **GIVEN** 主弹窗可见
- **WHEN** 用户按数字键之外的 `H`（历史） / `S`（片段），或点击对应 tab
- **THEN** 主弹窗 SHALL 切换到对应内容
- **AND** 状态保留至下次唤出

#### Scenario: 选中片段 → 写回剪贴板
- **WHEN** 用户在片段 tab 中点击或 Enter 选中某片段
- **THEN** 应用 SHALL 把片段 content 写回系统剪贴板（与 history 选中行为一致）
- **AND** 若设置中 `pasteOnPick=true`，SHALL 在 80ms 后模拟 Cmd/Ctrl+V

### Requirement: 导入 / 导出
应用 SHALL 支持把 snippets 导入或导出为 JSON 文件，便于备份和迁移。

#### Scenario: 导出
- **WHEN** 用户在编辑器工具栏点击「导出」
- **THEN** 应用 SHALL 弹出保存对话框，写入完整 snippets.json 到用户选定路径

#### Scenario: 导入
- **WHEN** 用户选择有效的 ClipSync snippets json 文件
- **THEN** 应用 SHALL 把内容合并到现有片段树（按 id 去重，新条目追加）

### Requirement: 树形行内重命名
片段编辑器中文件夹与片段的名称 SHALL 支持在树形列表中行内编辑，无需弹出对话框。

#### Scenario: 双击或 F2 进入编辑
- **GIVEN** 片段编辑器中某个节点被选中
- **WHEN** 用户双击该节点的标签 OR 按下 F2
- **THEN** 该行的标签 SHALL 变为 `<input>`，自动获得焦点并全选当前文本

#### Scenario: 提交编辑
- **WHEN** 用户在编辑态按 Enter，或失焦（blur）
- **AND** 输入非空
- **THEN** 节点的 name SHALL 被更新为新值
- **AND** 节点回到普通展示态

#### Scenario: 取消编辑
- **WHEN** 用户按 Esc
- **THEN** 节点 name SHALL 保持不变
- **AND** 节点回到普通展示态

#### Scenario: 同步编辑器右侧名字
- **GIVEN** 用户在右侧编辑器顶部的 name input 中改了名字
- **THEN** 左侧树中对应节点的标签 SHALL 立即同步显示新名字

