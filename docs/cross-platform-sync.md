# Mac / Windows 跨平台同步最佳实践

> 适用范围：ClipSync 同时安装在 macOS + Windows（也可推广到 Linux）
> 版本基线：v0.8.0
> 文档目标：列出当前实现的跨平台风险，对照业界通用做法，给出可落地的改进路径

---

## 一、当前实现的跨平台风险清单

> 这些是**真实可复现**的问题，不是理论隐患。

### 🔴 P0 · 数据正确性

| # | 问题 | 位置 | 触发条件 | 现象 |
|---|---|---|---|---|
| 1 | **设备 ID 硬编码为 `"rust-sync"`** | `src-tauri/src/sync.rs:443` | 后台同步定时器跑任何一轮 | Mac 推上去和 Windows 推上去无法区分，冲突排查不可能；前端 `localStorage.clipsync.device` 的随机 ID 仅在前端用户主动同步时才生效 |
| 2 | **行尾符未归一化** | `src-tauri/src/hash.rs:hash_text` | 同一段文本在 mac 复制是 `\n`，在 Win 复制是 `\r\n` | SHA-256 不同 → 视为两条独立记录 → 跨平台去重失败，列表里同一条出现两次 |
| 3 | **图片 blob 未真正同步** | `src-tauri/src/sync_backends/repo.rs:307` | 任何图片项 | `kind == "image"` 时只把 `id` 和元数据写进 `index.json`，**不上传 PNG blob**，对端只看到 `📷 1920×1080 (200 KB)` 占位符，点击粘贴出空内容 |
| 4 | **Force-push 并发覆盖** | `src-tauri/src/sync_backends/repo.rs:507` | A、B 设备在 60s 同步间隔内都有新复制 | 两端同时拉到 T0 状态 → 各自合并自己的新增 → 都 `force-update-ref` → 后到者赢，先到者本地新增**永久丢失**（远端被覆盖，下轮同步又被远端"权威"拉回） |

### 🟠 P1 · 平台行为差异

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| 5 | **隐私黑名单全是 macOS bundle id** | `src-tauri/src/tray.rs:248-253` | `com.agilebits.onepassword*` 在 Windows 上不会匹配任何东西，1Password Win 版（`AgileBits.1Password.UI.exe`）泄露的密码会被捕获 |
| 6 | **源应用检测仅 macOS 实现** | `src-tauri/src/clipboard.rs:source_hint_macos` | Win 上**没有**等价机制，意味着 Win 上的黑名单完全失效 |
| 7 | **快捷键写死 Cmd** | `src-tauri/src/tray.rs:97` `"Cmd+Shift+V"` | 在 Windows 上托盘菜单会显示一个永远按不出来的 `Cmd+Shift+V`，应该用 Tauri 的 `CmdOrCtrl` |
| 8 | **changeCount 快速路径仅 macOS** | `src-tauri/src/clipboard.rs:current_change_count` | Windows 上每 600ms 必须实际读剪贴板（CPU/IO 开销变大；Win 上等价物是 `AddClipboardFormatListener` 事件订阅） |
| 9 | **图片像素布局 vs PNG 字节序** | `src-tauri/src/hash.rs:hash_image_pixels` | Tauri clipboard-manager 在 mac/Win 都返回 RGBA8，理论上等价。但 Windows 上的 CF_DIB（BGR + 翻转）经过 Tauri 转换会丢失阿尔法通道 → 同一张截图的 hash 可能不同（实测会**生成两条记录**） |

### 🟡 P2 · 安全 & 隐私

| # | 问题 | 影响 |
|---|---|---|
| 10 | **明文存储到 GitHub 仓库** | 即使是 private repo，凡是该仓库的协作者、未来加入的协作者、GitHub 员工（按 ToS）、未来 token 泄露场景都能读到全部剪贴板历史。包括复制过的密码、二维码截图、token、邮箱、SSN 等 |
| 11 | **PAT 同时用于 push 和 pull** | 一旦 PAT 泄露，攻击者不仅能读历史还能投毒（往 `data` 分支推恶意内容，下次同步即在受害设备执行） |

---

## 二、业界通用做法

| 软件 | 同步后端 | 加密 | 冲突策略 | 设备 ID |
|---|---|---|---|---|
| **Clipboard Health / Pastebot** | iCloud / Apple Sync | E2EE | LWW + 设备隔离 | iCloud 自动分配 |
| **Maccy** | 不同步 | — | — | — |
| **CopyClip 2 / 1Clipboard** | iCloud / Google Drive | iCloud 默认加密 | LWW | 设备名 |
| **Ditto (Windows)** | TCP P2P 局域网 / Bonjour | TLS + 共享密钥 | LWW | 主机名 + 端口 |
| **clipman / wl-clipboard-sync** | SSH / WebDAV | 由后端保证 | LWW | hostname |
| **🆕 Pieces / Raycast Clipboard History** | 厂商服务端 | E2EE（claimed） | CRDT | 用户 ID |

**共性 4 条**：

1. **每台设备一个稳定且唯一的 ID**（hostname + machine UUID 兜底）
2. **内容加密后再上传**（最差也是对称密钥派生自用户密码 + salt）
3. **冲突用 LWW（Last-Write-Wins）但 by item，不是 by file**（force-push 整文件会丢数据）
4. **同步间隔 + 节流 + 抖动**，避免两端同时推

---

## 三、ClipSync 的最佳实践落地

### 🏗 立刻可做（不破坏现有架构）

#### 3.1 修复设备 ID

```rust
// src-tauri/src/sync.rs:443
// ❌ 现状
let device = "rust-sync".to_string();

// ✅ 改为：进程启动时一次性生成稳定 ID，存到 app_data_dir/device-id
let device = state.device.lock().clone();
```

在 `lib.rs` 的 setup 里增加：

```rust
fn ensure_device_id(app: &AppHandle) -> String {
    let path = app.path().app_data_dir().unwrap().join("device-id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let hostname = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .unwrap_or_else(|| "unknown".into());
    let suffix: String = (0..6)
        .map(|_| {
            let n = (rand::random::<u8>() % 36) as usize;
            "abcdefghijklmnopqrstuvwxyz0123456789".as_bytes()[n] as char
        })
        .collect();
    let id = format!("{}-{}-{suffix}", std::env::consts::OS, hostname);
    let _ = std::fs::write(&path, &id);
    id
}
```

最终格式：`macos-junhey-mbp-a3kq91` / `windows-DESKTOP-7XY2-b9p4nm`

#### 3.2 归一化行尾符 + Unicode

```rust
// src-tauri/src/hash.rs
pub fn hash_text(s: &str) -> String {
    // 1. 行尾符归一化：\r\n / \r → \n
    // 2. NFC 归一化（mac 上某些输入法是 NFD）
    let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = unicode_normalization::UnicodeNormalization::nfc(normalized.chars())
        .collect::<String>();
    let mut h = Sha256::new();
    h.update(normalized.as_bytes());
    hex::encode(h.finalize())
}
```

`Cargo.toml` 加 `unicode-normalization = "0.1"`。这一步让同一段文本在两个平台**生成同一个 ID**，去重才能跨平台生效。

> ⚠️ 注意：归一化只用于 `id`/hash 计算，**原文 `text` 字段保留用户复制时的精确内容**（让 Win 用户粘贴回去仍是 `\r\n`）。

#### 3.3 完成图片同步

`src-tauri/src/sync_backends/repo.rs:307` 现在的实现：

```rust
if it.kind == "image" {
    entries.push(IndexEntry { ... });
    continue;   // ← 这里跳过了 blob 上传
}
```

应该改为：把本地 `blobs/<id>.png` 作为二进制 base64 上传到 `blobs/<sha[0:2]>/<sha>` 路径，并在 `IndexEntry` 里记录 `r#ref = sha`。拉取端按需下载（懒加载，只在用户点击该项时才拉）。

#### 3.4 用 `CmdOrCtrl` 而不是 `Cmd`

```rust
// src-tauri/src/tray.rs:97
MenuItem::with_id(app, "show", "显示 ClipSync", true, Some("CmdOrCtrl+Shift+V"))
```

Tauri 的菜单 accelerator 接受 `"CmdOrCtrl"`，自动渲染为 mac 的 `⌘` 和 Win 的 `Ctrl`。

#### 3.5 平台化隐私黑名单

```rust
// src-tauri/src/tray.rs:populate_state_from_disk
#[cfg(target_os = "macos")]
let default_blocklist = vec![
    "com.agilebits.onepassword*".into(),
    "com.lastpass.LastPass".into(),
    "org.keepassxc.keepassxc".into(),
    "com.bitwarden.desktop".into(),
];

#[cfg(target_os = "windows")]
let default_blocklist = vec![
    "1Password*".into(),
    "LastPass*".into(),
    "KeePass*".into(),
    "Bitwarden*".into(),
];
```

同时在 Win 上把 `try_capture_text` 的源检测替换为「读 `GetForegroundWindow → GetWindowText` 取窗口标题」，或用 `windows-rs` 拿前台进程名。

### 🚀 中期（架构调整）

#### 3.6 解决 force-push 并发冲突

把 `force-update-ref` 改为「**条件式更新**」：在 `PATCH /repos/.../git/refs/heads/data` 时带上 `sha: <expected_old_sha>`。如果不匹配（说明对端已推过），就：

1. 重新拉一次最新 `index.json`
2. 重做合并
3. 重试 push（最多 3 次，加指数退避）

GitHub 的 `PATCH ref` 接受 `force: false` 模式，正是用于这种 CAS（Compare-And-Swap）操作。

#### 3.7 节流 + 抖动

```rust
// 同步间隔加 ±10% 随机抖动，防止两端时钟一致导致同时触发
let jitter = (rand::random::<u64>() % (interval / 5 + 1)) as i64 - (interval as i64 / 10);
let next = (interval as i64 + jitter).max(5) as u64;
tokio::time::sleep(Duration::from_secs(next)).await;
```

#### 3.8 同步前后加锁（本地）

`spawn_sync_timer` 当前没保护 push 期间的并发：用户在同步进行中复制新内容会进入临时不一致。引入：

```rust
let sync_in_progress = Arc<AtomicBool>::new(false);
if !sync_in_progress.swap(true, Ordering::SeqCst) {
    // run sync...
    sync_in_progress.store(false, Ordering::SeqCst);
}
```

### 🔐 长期（隐私 & 可靠性）

#### 3.9 端到端加密

最简方案：用户输入一个 **passphrase**，PBKDF2 派生 256-bit 密钥，所有上传到 GitHub 的 `index.json` / `blobs/*` 用 AES-256-GCM 加密。本地只在内存解密。

```rust
// 伪代码
let key = pbkdf2_hmac_sha256(passphrase, b"clipsync-v1", 100_000);
let nonce = random_12_bytes();
let ciphertext = aes_256_gcm_encrypt(&key, &nonce, plaintext);
upload(format!("{nonce}.{ciphertext}").as_bytes());
```

迁移期可以保留"明文/加密"双模式，加一个 v2 标记。

#### 3.10 设备清单（device registry）

在 `data` 分支根目录加 `devices.json`：

```json
{
  "macos-mbp-a3kq91": {
    "name": "junhey 的 Mac",
    "first_seen": 1716640000000,
    "last_seen": 1716700000000,
    "platform": "darwin"
  },
  "windows-DESKTOP-7XY2-b9p4nm": {...}
}
```

UI 里可以"撤销某设备"（从清单移除 + 下次该设备上线时强制清空本地 + 重新派生加密密钥）。

#### 3.11 健康监控

加 3 个轻量指标，写入本地 SQLite（或 JSON）：

| 指标 | 用途 |
|---|---|
| `last_successful_sync_at` | 设置页显示「上次同步: 30s 前 ✅」 |
| `conflict_count` (近 7 天) | 高 → 提示用户减小同步间隔 |
| `unsynced_local_items` | 高 → 提示用户检查网络/PAT |

---

## 四、检查清单 · 上线前必过

### 同步正确性
- [ ] 设备 ID 跨进程重启稳定（不是每次启动新生成）
- [ ] mac 复制 `hello\n`、Win 复制 `hello\r\n`：远端只有 **1** 条
- [ ] mac 复制截图 → Win 立刻能看到并粘贴出**原图**（不是占位符）
- [ ] mac 和 Win 在同 1 秒内各复制不同内容：两端同步完都能看到对方的内容（无丢失）
- [ ] 关机 24h 重启后：本地全部 200 条 + 远端独有的 N 条都正确合并

### 平台行为
- [ ] Win 上 `Ctrl+Shift+V` 弹出主窗
- [ ] Win 上从 1Password 复制密码：不进历史
- [ ] mac 上托盘菜单显示 `⌘⇧V`，Win 上显示 `Ctrl+Shift+V`
- [ ] Win 上 CPU 占用 < 1% 在空闲态（验证 changeCount 等价物已落地）

### 安全
- [ ] PAT 在 mac Keychain / Win Credential Manager / Linux Secret Service 都能存
- [ ] private repo 协作者**看不到明文**（如果已落地 E2EE）
- [ ] 删除 GitHub 上的 `data` 分支后，再次同步能自动重建

---

## 五、参考资料

- GitHub `git/refs` 条件式更新：https://docs.github.com/en/rest/git/refs#update-a-reference
- macOS NSPasteboard changeCount：[Apple Docs](https://developer.apple.com/documentation/appkit/nspasteboard/1529420-changecount)
- Win32 `AddClipboardFormatListener`：[MS Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener)
- Unicode 归一化 NFC：https://unicode.org/reports/tr15/
- Signal 的同步设计（参考 CRDT）：https://signal.org/blog/sync-state/
