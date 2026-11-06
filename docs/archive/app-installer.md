> **Archived (2026-11-06).** The 1.0.3 self-extracting installer design. Replaced by the launcher in `apps/launcher` and `src/main/install`; see [ADR-0010](../decisions/0010-own-installer-and-signed-updates.md).

# 应用安装器与更新（1.0.3）

- 状态：已实现（1.0.3）：`installer/` 源码、`build.ps1`、自测 36 项；应用侧按 `kind: exe` 下载并交给 Setup
- 影响：`tools/build-release.mjs`、`release/`、`apps/desktop/src/main/services/updateDownload.ts`、`apps/desktop/src/main/services/updates.ts`、`UpdateDialog`

## 1. 为什么换掉现在的更新流程

1.0.1 的实测结果：能下载、能解压，但用户关掉窗口后新窗口没有起来，`.stage` 与下载包一直留在磁盘上。现在的链路是：

```
下载 ZIP → 解压到 <zip>.stage → spawn powershell.exe release/updater.ps1
        → 750ms 后 app.quit() → 脚本等 PID 退出 → robocopy 备份/覆盖 → Start-Process 新 exe
```

失败点都在"换个进程去替换正在运行的应用"这一段：

- 更新脚本是应用进程的**子进程**，应用退出时它可能一起被结束（作业对象/进程树），于是覆盖只做了一半，既没有新窗口也没有清理；
- 依赖 `powershell.exe` 与 `-ExecutionPolicy Bypass`，企业环境/被杀软拦截时直接失效；
- `robocopy` 覆盖正在被占用的 `resources/app.asar` 不是原子操作，失败只能弹 MessageBox，回滚逻辑与"应用是否还活着"强耦合；
- `.stage` 只有在下次成功更新时才会被复用/清理，失败路径无人回收；
- 没有任何"卸载"入口，也没有安装记录，用户只能手动删目录。

结论：不要把"替换自身"这件事交给应用自己的子进程，交给一个**独立的安装器 exe**。

## 2. 新形态：单文件自解压安装器

发布物新增：

```
MossStudio-Setup-1.0.3-x64.exe     // 安装 / 更新 / 卸载 三合一
MossStudio-1.0.3-win32-x64.zip     // 便携版保留（绿色版用户与回退用）
```

- 安装器是自包含的 .NET 单文件 exe（`PublishSingleFile` + `self-contained`，WinForms 轻 UI），不依赖 PowerShell、不需要 NSIS/Inno、不需要目标机器装 .NET。
- 应用负载直接追加在 exe 末尾（`payload.zip` + 固定长度 trailer：magic、offset、size、sha256），运行时读自身路径定位 payload，用 `System.IO.Compression` 解压。
- 未签名，首次运行仍可能有 SmartScreen 提示（与现状一致，签名放到后续版本）。

### 目录布局（原地更新）

```
<InstallDir>/
  MossStudio.exe
  resources/…                 # 当前版本的文件，原地覆盖
  data/                       # 用户数据、模型、引擎、日志；安装器永不删除
  data/install.json           # 安装记录：version、installed_at、payload_sha256
  data/backups/<old-version>/ # 更新前的程序文件备份，成功后清理，失败用于回滚
```

原地覆盖而不是 `app/<version>` + junction：快捷方式、单实例锁、`paths.root()`（打包时取 exe 同级 `data/`）都保持不变，升级不改路径。

## 3. 命令

```
MossStudio-Setup-1.0.3-x64.exe                        # GUI 安装向导（检测已有安装 → 更新）
MossStudio-Setup-1.0.3-x64.exe --install [--dir D] [--silent] [--launch]
MossStudio-Setup-1.0.3-x64.exe --update --dir D --pid <P> [--relaunch]
MossStudio-Setup-1.0.3-x64.exe --uninstall [--dir D] [--keep-data|--purge-data] [--silent]
MossStudio-Setup-1.0.3-x64.exe --version
```

- `--update`：等待 `--pid` 退出（上限 5 分钟）→ 校验 payload 哈希 → 备份程序文件（不含 `data/`）→ 解压覆盖 → 写 `install.json` → 启动新 exe → 删除备份与下载缓存；任一步失败则从备份回滚，写 `data/logs/update-<ver>.log` 并弹窗说明。
- 安装器启动后先把自己复制到 `%TEMP%\MossStudio-Setup-<guid>.exe` 并以副本继续，原进程退出：更新进程绝不属于应用的进程树，应用退出不会把它带走。
- 安装：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MossStudio`（DisplayName/Version/InstallLocation/UninstallString）、桌面与开始菜单快捷方式、`install.json`。
- 卸载：结束进程 → 删除程序文件与快捷方式/注册表 → 默认**保留** `data/`，`--purge-data` 才删除，并在 UI 里明确勾选。

## 4. 应用侧改动

- `shared/release.ts`：`installer.kind` 增加 `exe`（兼容旧的 `zip`）。
- `updates.ts`/`UpdateDialog`：`exe` 安装器走"下载 → 校验 → 启动安装器 `--update --dir <dirname(process.execPath)> --pid <pid>` → 退出"；不再解压、不再调 PowerShell。
- 启动时清理 `downloads/updates/` 下超过 7 天的 `.stage`/`.zip` 残留，并在设置页显示"上次更新失败"日志入口。
- 旧的 `updater.ps1` 在 1.0.3 后不再分发；代码里保留一个版本用于读取旧包，随后删除。

## 5. 构建与发布

- `tools/build-release.mjs`：先打现有便携 ZIP（app 目录，不含 `data/`），再调用 `installer/build.ps1` 生成安装器（`dotnet publish` + 追加 payload + 写 trailer），输出 `release/artifacts/MossStudio-Setup-<ver>-x64.exe`，把 sha256/size 写回 `release/manifest.json` 的 `installers`（`kind: exe`），ZIP 同时作为第二资产。
- `release/release.md` 的安装包段落同时列出 Setup exe 与便携 ZIP。

## 6. 迁移

- 1.0.2 用户：旧的 ZIP+PowerShell 更新链路已经证明不可靠，1.0.3 发布说明要求**手动下载一次 Setup exe**；安装器检测到已有 `MossStudio.exe` + `resources/` 时按"更新"处理，保留 `data/`，不需要先卸载。
- 检测逻辑：`data/install.json` 存在 → 用记录里的版本；否则读 `<dir>/MossStudio.exe` 文件版本/`resources/release/release.md` 兜底。

## 7. 验证

- 单元：trailer 解析、payload 哈希校验、路径越界拒绝、版本比较。
- 安装器场景（临时目录）：全新安装、覆盖安装、只读目录失败回滚、`--purge-data` 与保留数据、卸载后注册表/快捷方式清理。
- 端到端：1.0.2 便携目录 → 1.0.3 Setup `--update` → 进程重启、`data/` 保留、`install.json` 版本正确；再跑一次同版本安装应提示"已是此版本"。

## 8. 不做

- 代码签名/公证（后续版本；当前仍是未签名 exe）。
- 自动静默更新（先保留用户确认）。
- macOS/Linux 安装器（本轮只做 Windows x64）。
