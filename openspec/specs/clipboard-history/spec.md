# clipboard-history Specification

## Purpose
TBD - created by archiving change add-clipboard-mvp. Update Purpose after archive.
## Requirements
### Requirement: 系统剪贴板捕获
应用 SHALL 在后台监听系统剪贴板，将新增的文本内容收录进本地历史，且对相同内容自动去重。

#### Scenario: 用户复制一段新文本
- **WHEN** 用户在任意应用中执行 Cmd/Ctrl+C 复制一段非空文本
- **THEN** 不超过 1.5 秒内，该文本会出现在 ClipSync 历史的最顶部
- **AND** 历史条目带有 `createdAt` / `updatedAt` 时间戳和初始 `hits=1`

#### Scenario: 用户重复复制相同内容
- **WHEN** 用户复制了 ClipSync 历史中已存在的文本（按 SHA-256 判断相同）
- **THEN** 不创建新条目，原条目的 `updatedAt` 更新为现在
- **AND** 原条目的 `hits` 自增 1
- **AND** 该条目被移到列表顶部

#### Scenario: 应用本身写回剪贴板
- **WHEN** 用户从 ClipSync 列表里选择一条历史项触发"再次复制"
- **THEN** ClipSync SHALL NOT 把这次自身的写入再次记录为新条目

### Requirement: 历史持久化
历史 SHALL 在应用退出后仍然保留，并在下次启动时被恢复。

#### Scenario: 应用重启
- **WHEN** 用户关闭 ClipSync 后重新打开
- **THEN** 之前的历史按原顺序被还原，置顶状态保留

### Requirement: 搜索与键盘操作
弹窗 SHALL 支持即时搜索过滤和全键盘操作。

#### Scenario: 输入关键字搜索
- **WHEN** 用户在搜索框输入字符
- **THEN** 列表实时过滤为内容（不区分大小写）包含该关键字的条目

#### Scenario: 数字快捷键选择
- **WHEN** 弹窗可见且列表非空
- **AND** 用户按下 `Cmd/Ctrl+1` 到 `Cmd/Ctrl+9`
- **THEN** 对应索引（1 起）的条目被复制回剪贴板，弹窗隐藏

#### Scenario: 置顶 / 取消置顶
- **WHEN** 列表中某项处于活动选中状态
- **AND** 用户按下 `Cmd/Ctrl+P`
- **THEN** 该条目的 `pinned` 状态翻转
- **AND** 列表重新排序，置顶项排在前面

### Requirement: 历史容量上限
历史项数量 SHALL 受 `maxItems` 设置约束，超出时按规则裁剪。

#### Scenario: 超过 maxItems 时裁剪
- **WHEN** 历史项总数超过 `maxItems`（默认 200）
- **THEN** 所有 `pinned=true` 的条目都保留
- **AND** 非置顶条目按 `updatedAt` 降序保留前 `maxItems - 置顶数` 条

### Requirement: 图片剪贴板捕获
应用 SHALL 在后台监听系统图片剪贴板，将新增的图片捕获到本地历史，并按内容去重。

#### Scenario: 用户截屏后内容进入历史
- **WHEN** 用户使用 `Cmd+Shift+4` / 截图工具复制了一张图片到剪贴板
- **THEN** 不超过 1.5 秒内，该图片以缩略图形式出现在 ClipSync 历史顶部
- **AND** 历史条目的 `kind="image"`，并带有 `width`、`height`、`bytes`、`format="png"` 元信息

#### Scenario: 重复截取相同图像内容
- **WHEN** 用户再次复制视觉上相同的图像（按 RGBA 像素哈希判定相同）
- **THEN** 不创建新条目，原条目 `updatedAt` 更新、`hits` 自增
- **AND** 该条目被移到列表顶部

#### Scenario: 应用本身把图片写回剪贴板
- **WHEN** 用户从 ClipSync 列表里选择一条图片项触发"再次复制"
- **THEN** 应用 SHALL NOT 把这次写入再次记录为新条目

### Requirement: 图片二进制本地存储
图片二进制 SHALL 与 `history.json` 分离存放。

#### Scenario: 写入路径
- **WHEN** 一张新的图片被捕获
- **THEN** 其 PNG 字节 SHALL 被写入 `<app_cache_dir>/blobs/<id>.png`
- **AND** `history.json` 中的对应条目只包含 metadata，不含 base64

#### Scenario: 缩略图渲染
- **WHEN** UI 渲染一个 `kind="image"` 的列表项
- **THEN** 前端 SHALL 调用 `read_blob(id)` 命令拿到 PNG data URL 并显示缩略图
- **AND** 元信息行显示 `📷 1920×1080 (245KB)` 格式

### Requirement: 图片项的"再次复制"
图片项 SHALL 支持回写剪贴板。

#### Scenario: 选中图片项 Enter
- **WHEN** 列表中一个 `kind="image"` 项被选中并 Enter（或点击）
- **THEN** 应用 SHALL 把 PNG 写回系统剪贴板
- **AND** 在任意支持图像粘贴的应用（如 Pages、QQ）中，`Cmd/Ctrl+V` 能粘出该图

### Requirement: 孤儿 blob 回收
应用 SHALL 自动清理不再被任何历史条目引用的 blob 文件。

#### Scenario: 启动时 GC
- **WHEN** 应用启动并加载完 history
- **THEN** SHALL 扫描 `blobs/` 目录，删除所有 id 不在当前 history 中的 PNG

#### Scenario: 容量裁剪连带删除
- **WHEN** 因 `maxItems` 限制裁剪掉某个图片项
- **THEN** 该项对应的 blob 文件 SHALL 被同步删除

### Requirement: 大图守护
为避免占用过多本地磁盘和阻塞剪贴板事件，应用 SHALL 对超大图片做拒收处理。

#### Scenario: 超过单图阈值
- **WHEN** 一张图片编码为 PNG 后字节数超过 20MB
- **THEN** 应用 SHALL NOT 写入 blob，也 NOT 添加到 history
- **AND** 在状态栏（如已可见）短暂提示"已忽略大图"

### Requirement: 来源黑名单
应用 SHALL 提供"忽略来源"配置，避免来自密码管理器等敏感 app 的剪贴板内容被收录。

#### Scenario: 默认黑名单
- **GIVEN** 应用首次安装
- **THEN** `ignoreSources` 默认包含主流密码管理器的 bundle id 模式：
  `com.agilebits.onepassword*`, `com.lastpass.LastPass`,
  `org.keepassxc.keepassxc`, `com.bitwarden.desktop`

#### Scenario: 命中黑名单的内容被丢弃
- **GIVEN** macOS 上来源 app 在剪贴板写入时声明了 `org.nspasteboard.source = "com.agilebits.onepassword7"`
- **WHEN** ClipSync watcher 拿到本次变更
- **THEN** 应用 SHALL NOT 写入历史，也 NOT emit `clipboard:new`

#### Scenario: 用户编辑黑名单
- **WHEN** 用户在设置中添加 `com.example.SecretApp` 到 `ignoreSources`
- **AND** 保存设置
- **THEN** 之后该 app 复制的内容均被忽略

### Requirement: 图片大图悬停预览
鼠标悬停在图片缩略图 SHALL 在 500ms 后显示原图浮层。

#### Scenario: 悬停显示
- **GIVEN** 列表中存在一个 `kind="image"` 项，且本机有 blob
- **WHEN** 用户鼠标悬停在该项的缩略图上 ≥ 500ms
- **THEN** 应用 SHALL 在弹窗右侧显示该图的浮层（最大 480×480，等比缩放）

#### Scenario: 鼠标移开收起
- **WHEN** 用户鼠标移出缩略图区域
- **THEN** 浮层 SHALL 立即关闭

#### Scenario: 越界翻面
- **WHEN** 浮层右侧超出屏幕
- **THEN** 浮层 SHALL 改为弹在缩略图左侧

### Requirement: changeCount 快速路径
在 macOS 上，剪贴板 watcher SHALL 每轮先读取 `NSPasteboard.generalPasteboard.changeCount`，若与上轮相同则跳过整次内容读取。

#### Scenario: 闲置时不做无效 read
- **GIVEN** macOS 系统剪贴板 5 分钟内未变化
- **WHEN** ClipSync watcher 进入新一轮 poll
- **THEN** 应用 SHALL 仅读取一个整数 (changeCount)，与上次相同时立即 sleep
- **AND** 应用 SHALL NOT 读取 text 或 image 内容

#### Scenario: 真有变化时正常路径
- **WHEN** changeCount 与上次不同
- **THEN** 应用 SHALL 走原有的 try_capture_image / try_capture_text 流程

### Requirement: 自适应轮询间隔
应用 SHALL 根据最近剪贴板活跃度动态调整 poll 间隔，以便在长时间不动剪贴板的场景下进一步降低耗能。

#### Scenario: 最近活跃
- **WHEN** 最近 30 秒内有过剪贴板新增
- **THEN** poll 间隔 SHALL 为 600ms

#### Scenario: 中等空闲
- **WHEN** 最近活动距今 30 秒至 5 分钟之间
- **THEN** poll 间隔 SHALL 为 1500ms

#### Scenario: 长期空闲
- **WHEN** 最近活动距今 5 分钟以上
- **THEN** poll 间隔 SHALL 为 3000ms
- **AND** 一旦下次捕获到新内容，间隔 SHALL 立即恢复为 600ms

### Requirement: 直达粘贴快捷键
应用 SHALL 注册 9 个全局快捷键 `CommandOrControl+Shift+Alt+1` 到 `CommandOrControl+Shift+Alt+9`，按下后直接把对应位置的历史条目粘到当前前台应用，全程不唤出主弹窗。

#### Scenario: 直达粘贴
- **GIVEN** 主弹窗未显示
- **AND** 历史中至少有 3 条记录
- **WHEN** 用户按下 `CommandOrControl+Shift+Alt+3`
- **THEN** 应用 SHALL 把第 3 条历史 (按时间倒序，pinned 优先) 写回剪贴板
- **AND** 应用 SHALL 模拟 `Cmd+V`（macOS）/ `Ctrl+V`（Windows / Linux）
- **AND** 应用 SHALL NOT 显示主弹窗

#### Scenario: 历史不足
- **WHEN** 用户按下 `CommandOrControl+Shift+Alt+5` 而历史只有 2 条
- **THEN** 应用 SHALL 静默忽略，不报错也不闪窗

#### Scenario: 单个快捷键冲突
- **WHEN** 某一个 1..9 注册失败（已被其他 app 占用）
- **THEN** 应用 SHALL 静默跳过该 N，但其余 8 个仍正常注册

#### Scenario: 用户关闭直达
- **GIVEN** 用户在设置中把 `directPasteHotkeys=false`
- **WHEN** 应用启动或用户保存设置
- **THEN** 应用 SHALL unregister 全部 9 个直达快捷键

### Requirement: 弹窗内 ⌘1-9
主弹窗显示时按 `CommandOrControl+1..9` SHALL 选中并粘贴当前列表的对应条目，即使输入框处于焦点。

#### Scenario: 输入框焦点中按下
- **GIVEN** 主弹窗显示，搜索输入框处于焦点
- **WHEN** 用户按 `Cmd+1`
- **THEN** 应用 SHALL 选中当前 tab 的第 1 条
- **AND** 应用 SHALL 把它写回剪贴板，按 paste-on-pick 设置粘贴
- **AND** 应用 SHALL 隐藏弹窗
- **AND** 输入框 SHALL NOT 接收 "1" 字符

