# MossStudio Setup（Windows 自解压安装器）

单文件、自包含（self-contained）的 Windows x64 安装器，负责 **安装 / 更新 / 卸载**。
实现对应 `docs/design/app-installer.md`，不依赖 PowerShell、NSIS 或目标机器上的 .NET。

源码：

```
installer/
  MossStudioSetup/            # C# WinForms 项目（net10.0-windows，无 NuGet 依赖）
  build.ps1                   # publish + 追加 payload + 写 trailer
  selftest.ps1                # 临时目录端到端自测
```

## Payload / trailer 格式

安装器 exe 末尾依次是：

```
[ apphost 本体 ][ payload ZIP ][ 96 字节 trailer ]
                                ^ 文件最后 96 字节
```

trailer 固定 96 字节，全部小端：

| 偏移 | 长度 | 内容 |
| ---: | ---: | --- |
| 0  | 8  | magic，ASCII `MSSTUDIO` |
| 8  | 8  | `offset`，Int64 LE，ZIP 在 exe 中的绝对偏移 |
| 16 | 8  | `size`，Int64 LE，ZIP 字节数 |
| 24 | 64 | ZIP 的 SHA-256，64 个 ASCII 小写十六进制字符 |
| 88 | 8  | reserved，必须全为 0 |

运行时读取自身 exe，校验 magic、偏移/长度（`offset + size + 96 == 文件长度`）、reserved，并在解压任何文件之前完整计算并比对 payload 的 SHA-256。任何一项失败都会直接退出，不写目标目录。

`build.ps1` 会把发布好的单文件 exe 复制为
`MossStudio-Setup-<version>-x64.exe`，追加 payload 与 trailer，然后读回 trailer 再校验一遍，最后输出：

```
setup=<绝对路径>
sha256=<成品 exe 的 SHA-256>
size=<成品 exe 字节数>
```

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1 `
  -Version 1.0.3 `
  -Payload release\artifacts\MossStudio-1.0.3-win32-x64.zip `
  -OutDir release\artifacts
```

- `-Payload` 就是现有便携包 ZIP（根目录包含 `MossStudio.exe`、`resources\app.asar`）。
- `-OutDir` 下会生成 `publish\MossStudioSetup.exe` 与最终安装器；发布默认输出到 `installer\out`。
- `-SkipPublish` 复用 `-OutDir\publish\MossStudioSetup.exe`，迭代时避免重复 `dotnet publish`。
- 项目通过 `-p:Version=<ver>` 把版本写入 exe 的 InformationalVersion，`--version` 与 `data\install.json` 都用它。
- `dotnet publish` 在 `%TEMP%` 的项目副本里执行，不会在仓库里留下 `obj/`、`bin/`。

底层 publish 设置（见 csproj）：`net10.0-windows`、WinForms、`win-x64`、self-contained、single-file、压缩、无 NuGet 包。

## 命令行

```
MossStudio-Setup-<ver>-x64.exe                                  # GUI 向导
MossStudio-Setup-<ver>-x64.exe --install [--dir D] [--silent] [--launch]
MossStudio-Setup-<ver>-x64.exe --update --dir D --pid <P> [--relaunch=false]
MossStudio-Setup-<ver>-x64.exe --uninstall [--dir D] [--keep-data|--purge-data] [--silent]
MossStudio-Setup-<ver>-x64.exe --version
```

默认安装目录：`%LOCALAPPDATA%\Programs\MossStudio`。

- `--install`：校验 payload → 解压 → 写 `<dir>\data\install.json` → 把自身复制为
  `<dir>\MossStudio-Setup.exe` → 写
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MossStudio`
  （DisplayName / DisplayVersion / InstallLocation / DisplayIcon / UninstallString）→
  创建桌面与开始菜单快捷方式 → 非 `--silent` 时启动 `MossStudio.exe`。
- `--update`：等待 `--pid`（最长 5 分钟）→ 校验 payload → 备份程序文件（不含 `data\`）到
  `data\backups\<old-version>-<timestamp>` → 解压覆盖 → 刷新 `install.json` 与已安装的卸载器副本 →
  默认重启 `MossStudio.exe`（`--relaunch=false` 可关闭）→ 成功后删备份。
  任一步失败则从备份回滚（含旧的 `install.json`），并写 `data\logs\update-<version>.log`。
- `--uninstall`：结束 `<dir>` 下的 `MossStudio.exe` → 删除快捷方式、注册表项与程序文件；
  默认保留 `data\`，只有 `--purge-data` 才删除；非 `--silent` 时弹出完成提示。
- 未知参数返回 2；运行失败返回 1。

测试辅助参数：`--skip-shortcuts`、`--skip-registry` 不触碰当前用户的快捷方式与注册表；
`--allow-system-dir` 才允许安装到 `C:\Windows` / Program Files 等受保护目录。

## GUI

无参数启动 WinForms 向导：标题、版本、安装目录选择（FolderBrowserDialog）、进度条、状态文本、
安装 / 更新 / 卸载按钮。启动时通过 `data\install.json`（以及文件版本、`resources\release\release.md` 兜底）
检测已有安装；同版本会提示“已是此版本”。GUI 卸载会询问是否删除 `data\`。

命令行模式不创建窗口；由于是 `WinExe`，输出会附加到父控制台，重定向时也能正常捕获。

## 安全约束

- 所有路径先 `Path.GetFullPath` / `Path.TrimEndingDirectorySeparator`，所有写入、删除都检查在安装目录内。
- 默认拒绝把 `C:\Windows`、Program Files、用户目录根、`%LOCALAPPDATA%` 根等作为安装目录。
- 解压时拒绝绝对路径、`..`、冒号与 ZIP slip，并跳过 payload 里任何 `data\` 条目。
- 卸载只枚举安装目录内容；`data\` 仅在 `--purge-data` 时删除。
- 当安装器从 `<dir>\MossStudio-Setup.exe` 运行卸载时，会把自己复制到 `%TEMP%`、由副本等待原进程退出后再删除，
  避免“正在运行的文件无法删除”。

## 自测

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\selftest.ps1
```

自测在 `%TEMP%\mossstudio-installer-selftest-<guid>` 中：构造假 payload ZIP → 构建两个版本的安装器 →
`--install --silent` → 校验安装布局与 `install.json` → `--update --relaunch=false --pid <已退出 PID>` →
校验版本升级、备份清理与更新日志 → 校验被篡改 payload 被拒绝 → `--uninstall --keep-data` →
校验程序文件删除但 `data\` 保留 → `--purge-data` 校验目录删除。最后打印 PASS/FAIL 摘要并以 0/1 退出。
