# github-sync Specification

## Purpose
TBD - created by archiving change add-clipboard-mvp. Update Purpose after archive.
## Requirements
### Requirement: 可选的 GitHub 存储后端
用户 SHALL 能在三种存储后端中选择：私有 Gist（默认）、GitHub 仓库分支、仅本地。

#### Scenario: 默认使用私有 Gist
- **WHEN** 用户首次打开应用并填入有效的 GitHub PAT
- **AND** 未指定 Gist ID
- **THEN** 首次同步时应用 SHALL 自动创建一个私有 Gist 用于存放 `history.json`
- **AND** 把新 Gist 的 ID 持久化到设置中

#### Scenario: 切换到仓库分支后端
- **WHEN** 用户在设置面板把后端改为 `repo`
- **AND** 提供 `owner/repo`、PAT（需有 repo 权限）
- **THEN** 同步时 SHALL 把 `history.json` 写入指定仓库的 `data` 分支（默认）下的 `history.json`（默认）
- **AND** 使用 GitHub Contents API 的 `sha` 字段进行更新而非新增

#### Scenario: 仅本地模式
- **WHEN** 用户选择后端 `local`
- **THEN** 同步指示器显示 "本地"
- **AND** 不发起任何 GitHub API 请求
- **AND** "立即同步" 按钮被禁用

### Requirement: 自动同步
当后端非 `local` 且 `intervalSec > 0` 时，应用 SHALL 周期性同步。

#### Scenario: 周期同步触发
- **WHEN** `intervalSec=60`
- **THEN** 每 60 秒应用 SHALL 调用一次 `fetchRemote` → `mergeHistory` → 必要时 `pushRemote`

#### Scenario: 立即推送开关
- **WHEN** `pushOnChange=true`
- **AND** 本地新增了一条剪贴板记录
- **THEN** 应用 SHALL 在该次新增后立即推送到远端

### Requirement: 多设备合并
应用 SHALL 能合并多台设备并发写入的历史，且不丢数据。

#### Scenario: 两台设备同时复制不同内容
- **GIVEN** 设备 A 和设备 B 上的本地历史在断网下分别新增了一条不同内容
- **WHEN** 两台设备先后同步
- **THEN** 合并后的历史 SHALL 同时包含 A 和 B 的两条新内容
- **AND** 排序按 `updatedAt` 降序

#### Scenario: 同一条目在两端 pinned 状态不同
- **GIVEN** 设备 A 上某条 `pinned=true`，设备 B 上 `pinned=false`
- **WHEN** 合并
- **THEN** 合并结果中该条目 `pinned=true`（取并集）

### Requirement: 同步状态可见
UI SHALL 实时反映同步状态。

#### Scenario: 同步成功
- **WHEN** 一次同步成功完成
- **THEN** 状态指示器显示 "已同步 HH:MM:SS"，颜色为成功态

#### Scenario: 同步失败
- **WHEN** 同步抛出异常（网络 / 认证 / 限流）
- **THEN** 状态指示器显示 "失败"，hover 提示显示错误信息
- **AND** 不阻塞本地剪贴板捕获继续工作

### Requirement: 图片元数据同步默认开启
图片项的 metadata（不含二进制） SHALL 默认参与 `history.json` 的远端同步。

#### Scenario: 远端只看到 metadata
- **WHEN** 用户在设备 A 复制了一张图，并触发同步
- **AND** 设备 B 拉取远端 `history.json`
- **THEN** 设备 B 的列表 SHALL 出现该图片项
- **AND** 该项以占位形式显示（"📷 1920×1080 · 远端图片"），无缩略图
- **AND** 选中该项 Enter 时（在没有本地 blob 的情况下） SHALL 显示"图片二进制不在本机"提示，不抛错

### Requirement: 图片二进制同步可选
图片 PNG 二进制的远端同步 SHALL 默认关闭，可在设置中开启，但仅对 `repo` 后端可用。

#### Scenario: gist 后端禁用图片二进制同步
- **WHEN** 当前后端为 `gist`
- **THEN** 设置面板的 `syncImages` 开关 SHALL 被禁用并显示提示"Gist 不适合存图片，请切换到 repo 后端"

#### Scenario: repo 后端开启 syncImages
- **GIVEN** 后端为 `repo`，`syncImages=true`
- **WHEN** 触发同步
- **THEN** 应用 SHALL 把本地有但远端 `blobs/` 中没有的 PNG，通过 GitHub Contents API PUT 到 `blobs/<id>.png`
- **AND** 应用 SHALL 把远端有但本地没有的 PNG，下载并写入本地 cache

#### Scenario: 单图过大时跳过同步
- **WHEN** 某张图片的 PNG 字节数 > 5MB
- **THEN** 即使 `syncImages=true`，该图也 SHALL NOT 被推送到远端
- **AND** 该图项的 metadata 仍参与 `history.json` 同步

### Requirement: PAT 通过 OS 凭据存储管理
GitHub PAT SHALL 存储在操作系统的凭据管理器中（macOS Keychain、Windows Credential Manager、Linux secret-service），不再以明文存放在 `localStorage`。

#### Scenario: 用户保存新 PAT
- **WHEN** 用户在设置面板填入 PAT 并点保存
- **THEN** 应用 SHALL 把 PAT 写入 OS 凭据管理器（service = "ClipSync", account = "github_pat"）
- **AND** 不在前端持久化任何 token 副本
- **AND** 设置面板的 PAT 输入框 SHALL 显示为 `••••••` 占位

#### Scenario: 同步时取出 PAT
- **WHEN** sync 模块需要 PAT
- **THEN** 应用 SHALL 从 OS 凭据管理器读取
- **AND** 内存中的 token 引用在使用后即丢弃，不进入持久化结构

#### Scenario: 一次性迁移
- **GIVEN** 用户从 v0.2 升级到 v0.3
- **AND** 旧版的 `localStorage["clipsync.settings"].sync.token` 仍存在
- **WHEN** 应用启动
- **THEN** 应用 SHALL 把 token 迁移到 OS 凭据管理器
- **AND** 把 `localStorage` 中的 token 字段置空
- **AND** 整个迁移在 1 秒内完成且对用户透明

#### Scenario: 用户清除 PAT
- **WHEN** 用户点击设置面板的"清除 PAT"按钮
- **THEN** 应用 SHALL 从 OS 凭据管理器删除条目
- **AND** 后续同步直到用户重新填入 PAT 前都会跳过

### Requirement: 默认存储后端为仓库的 data orphan 分支
应用 SHALL 默认使用用户的 `<owner>/clipsync` 仓库的 `data` 分支作为同步存储，而不是 Gist。

#### Scenario: 首次配置
- **GIVEN** 用户提供了一个有 `repo` scope 的 PAT
- **WHEN** 应用首次执行同步
- **THEN** 应用 SHALL 自动 GET `/user` 取得登录名，目标仓库默认为 `<login>/clipsync`
- **AND** 仓库不存在时不自动创建（提示用户手动建仓）

#### Scenario: 仓库布局
- **WHEN** 同步成功后查看 `data` 分支根目录
- **THEN** SHALL 包含 `index.json` 与 `blobs/<sha[0:2]>/<sha>` 文件结构
- **AND** index.json 中每个条目以 `ref: <sha>` 字段引用 blob，而非内嵌内容

### Requirement: 内容 content-addressed 去重
相同内容的剪贴板项 SHALL 在远端共享同一个 blob 文件。

#### Scenario: 复制相同内容多次
- **GIVEN** 用户先后 10 次复制完全相同的文本
- **WHEN** 同步完成
- **THEN** 远端 `blobs/` 下 SHALL 仅有 1 个对应 hash 的文件
- **AND** 这 10 次操作在 index.json 中可能仅产生 1 条记录（hits=10）

### Requirement: 单 commit 仓库（force-push）
`data` 分支 SHALL 始终只保留一个 commit，避免历史无限增长。

#### Scenario: 多次同步后 commit 数
- **WHEN** 应用执行了 N 次同步（N ≥ 1）
- **THEN** `git log data` 显示的 commit 数 SHALL 仍为 1
- **AND** 该 commit 没有 parent（orphan）

#### Scenario: 仓库总大小
- **GIVEN** 历史含 200 条文本（合计 50 KB）
- **WHEN** 多次同步后
- **THEN** 仓库总占用 SHALL 接近 50 KB，不会因 commit 累积增长

### Requirement: 同步流量节流
应用 SHALL 在没有变化时不发起 mutation 请求。

#### Scenario: 远端无变更且本地无新增
- **WHEN** sync timer tick 到来
- **AND** 自上次同步以来没有新剪贴板内容
- **THEN** SHALL 仅做一次 cheap 的 GET ref 请求确认 sha 未变
- **AND** SHALL NOT 发起 POST blob/tree/commit 或 PATCH ref

#### Scenario: 远端 sha 已与本地预期一致
- **WHEN** GET ref 返回的 sha 与本地 `last_remote_root_sha` 相同
- **AND** 本地也无新增
- **THEN** SHALL 立即返回，不构造任何 tree

### Requirement: 从 Gist 平滑迁移
应用 SHALL 提供一次性的迁移操作把旧 Gist 历史搬到 repo 后端。

#### Scenario: 用户点迁移按钮
- **GIVEN** 当前 backend=gist 且 gistId 非空
- **WHEN** 用户在设置面板点击「迁移到 repo」
- **THEN** 应用 SHALL 调用 `migrate_from_gist` 命令
- **AND** 把 Gist 中的 history 上传到 repo backend（同样的 content-addressed 流程）
- **AND** 切换 backend 为 repo
- **AND** 不自动删除原 Gist（用户可在 GitHub 上自行处理）

### Requirement: 片段同步到 data 分支
片段树 SHALL 与剪贴板历史共用同一个 `data` orphan 分支同步，但存为独立的 `snippets.json`。

#### Scenario: 仓库布局
- **GIVEN** 用户有 ≥1 个片段
- **WHEN** Rust sync timer 执行同步
- **THEN** `data` 分支根目录 SHALL 同时包含：
  - `index.json`     — 剪贴板历史 metadata
  - `snippets.json`  — 片段树 metadata
  - `blobs/<aa>/<sha>` — 历史与片段共用的内容池

#### Scenario: 片段内容也走 content-addressed
- **WHEN** 一个新片段被推送
- **THEN** 其 content 的 SHA-256 SHALL 作为 blob 文件名
- **AND** 若该 hash 在 blobs/ 中已存在（与某条历史项重复），SHALL 共享一份 blob，不重复上传

#### Scenario: 单 commit 不变
- **WHEN** 同时含历史与片段的同步执行后
- **THEN** `data` 分支的 commit 数 SHALL 仍为 1（orphan + force-push 语义不变）

