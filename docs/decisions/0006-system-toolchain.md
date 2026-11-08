---
status: accepted
date: 2026-10-19
amended-by: ADR-0009
---

# ADR-0006：系统工具链检测、安装引导与首次运行可用性检查

- 关联：[ADR-0003](0003-launcher-first.md)、[ADR-0004](0004-workspaces-remote-devices.md)、[ADR-0005](0005-release-channel-and-updates.md)
- 影响：OOBE、环境报告、诊断、实例创建、运行时、Git/Python 调用、设置

## 1. 背景

启动器当前默认用户机器上已经有 Git 和 Python：

- `git.ts` 直接执行 `git clone/fetch/worktree`；没有 Git 时只能得到底层错误；
- `runtimes.ts` 的 `pickPython` 只查 `settings.pythonPath` 和 PATH 里的
  `python3.x/python`，没有使用 `paths.managedPython()`；
- `env.ts` 会扫描 PATH 和 `runtimes/python` 下的 Python，但只是报告；
- `onboarding.ts` 只检查实例/运行时/模型，不检查 Git/Python；
- OOBE 只显示三行，缺少工具链准备；
- 诊断规则主要匹配运行日志，没有“缺 Git/Python/版本过低”的预检卡片；
- `createInstance`、`installDeps`、启动 Gradio/runner 都可能在最后一步才因
  工具缺失失败。

对小白用户，`PATH`、Xcode Command Line Tools、Windows 安装器选项都是不可解释的
失败源。启动器必须把 Git/Python 当作**可检测、可解释、可重新扫描**的系统依赖，
而不是“用户应该自己准备好”的外部条件。

## 2. 调研结论与取舍

### 2.1 受管工具为什么不做

调研过两条可捆绑/下载的路径：

- GitHub Desktop 同源的 [dugite](https://github.com/desktop/dugite) 内嵌 Git 2.53，
  支持 macOS/Windows/Linux，约 60 MB，GPLv2；
- [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  的 CPython 3.12.15 `install_only_stripped` 可重定位，macOS arm64 约 25 MB、
  Windows x64 约 22 MB。

两者技术上可行，但会引入安装包体积、GPL/第三方 notices、工具版本随应用发版、
下载/校验失败面，以及“应用内又一套 Python/Git”的支持成本。产品选择是：
**不捆绑、不下载受管工具，优先接管用户已安装的系统工具；缺失时引导安装。**

### 2.2 系统工具的真实痛点

- macOS GUI 应用从 Finder 启动时 PATH 往往只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
  Homebrew 的 `/opt/homebrew/bin`、`/usr/local/bin` 可能不在 PATH；
- Windows 安装 Git/Python 时可能没有勾选 “Add to PATH”；
- 用户可能装了多个 Python，`python` 指向 Microsoft Store 占位符；
- Python 3.10 以下或 32 位 Python 可能能运行但装不了/跑不了 torch；
- 只报 `command not found` 无法告诉用户“缺什么、去哪装、装完怎么让启动器发现”。

所以核心不是“再装一份”，而是**扫描 PATH + 常见安装目录 + 手动路径**，并在
子进程里用绝对路径接管。

## 3. 决策

### 3.1 工具链策略：系统优先，只引导安装

- 不随包分发 Git/Python，不从启动器下载 Git/Python；
- 默认扫描系统 Git/Python；用户可在设置里手动指定可执行文件；
- 缺失或版本不满足时，OOBE/诊断给“打开官方安装器/下载页 + 重新检查”；
- 安装动作只打开官方安装器/页面，不静默执行、不提权、不修改系统 PATH；
- 工具路径写入设置（新增 `gitPath`；`pythonPath` 复用），只在启动器内部生效。

### 3.2 扫描范围

按平台扫描，顺序为“显式路径 → PATH → 常见安装目录”：

**macOS**

- Git：`/usr/bin/git`、`/opt/homebrew/bin/git`、`/usr/local/bin/git`；
  若只有 CLT shim，检查 `xcode-select -p`，引导 `xcode-select --install`；
- Python：`/opt/homebrew/bin/python3.12`、`/opt/homebrew/bin/python3`、
  `/usr/local/bin/python3.12`、`/usr/local/bin/python3`、
  `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3`、
  `~/.pyenv/shims/python3`、`~/.local/bin/python3`。

**Windows**

- Git：`where git`、`%ProgramFiles%\Git\cmd\git.exe`、
  `%LOCALAPPDATA%\Programs\Git\cmd\git.exe`；
- Python：`py -3 -c "import sys;print(sys.executable)"`、`where python`、
  `%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`、
  `C:\Python3xx\python.exe`；排除 Microsoft Store 的 App Execution Alias。

**Linux**

- PATH 的 `git`、`python3`；常见 `/usr/bin`、`/usr/local/bin`。

所有候选都执行 `--version` 自检；记录来源（PATH / common / custom）、真实路径、
版本、架构。Git 最低建议 2.30；Python 最低 3.10，推荐 3.12。

### 3.3 安装引导

只打开官方安装器/页面，不自动安装：

| 平台 | Git | Python |
| --- | --- | --- |
| macOS | 执行 `xcode-select --install` | 打开 python.org macOS 下载页 |
| Windows | 打开 git-scm.com Windows 下载页 | 打开 python.org Windows 下载页 |
| Linux | 展示发行版包管理器命令/文档 | 展示发行版包管理器命令/文档 |

- 安装引导面板固定显示“安装完成后点这里重新检查”；
- 重新检查会重新跑扫描，不需要重启应用；
- Windows 可提供可复制的 `winget install Git.Git` /
  `winget install Python.Python.3.12`，但不自动执行；
- 不自动下载 exe/dmg，不绕过系统安装器/权限。

### 3.4 OOBE

OOBE 从三行变为四段可用性检查（顺序）：

1. **运行环境**：Git、Python 是否就绪（可展示 uv 可选状态）；
2. **实例**：固定 commit 的 worktree；
3. **运行时**：venv 与依赖；
4. **模型**：SFT 权重。

- “运行环境”行给“准备工具”按钮，打开安装引导面板；
- 面板显示版本、路径、来源、缺失原因、官方安装入口、重新检查；
- 允许“本次跳过”，但创建实例/安装运行时/启动前仍会被预检拦截；
- 工具就绪后 OOBE 自动刷新；
- OOBE 不自动下载 27 GB 模型。

### 3.5 诊断与预检

新增预检（不是日志匹配）：

- `E_GIT_MISSING`：未找到 Git；动作 `install_git` / `open_toolchain` / `rescan`；
- `E_GIT_OLD`：Git 版本低于 2.30；动作 `open_toolchain` / `open_git_download`；
- `E_PYTHON_MISSING`：没有 3.10+；动作 `install_python` / `pick_python` / `rescan`；
- `E_PYTHON_STORE`：Windows Store 占位符/不可执行；动作 `pick_python` / `install_python`；
- `E_TOOL_PATH`：自定义路径不可执行；动作 `open_toolchain` / `rescan`；
- `E_TOOL_PERMISSION`：无执行权限/被安全软件拦截；动作 `open_logs` / `rescan`。

接入点：

- `createInstance` 前检查 Git；
- `pickPython` / `installDeps` 前检查 Python；
- 启动 Gradio/runner 前检查工具链；
- `env.ts` 的 Git/Python 检查项带“准备工具链”动作；
- OOBE 与诊断页共用同一 `ToolchainStatus`，不各自造状态。

### 3.6 设置

新增“工具链”分组：

- Git：来源（PATH/常见目录/自定义）、版本、路径、重新扫描、选择可执行文件；
- Python：来源、版本、路径、重新扫描、选择解释器；
- uv：可选；存在则用于 venv/安装，缺失时走 `python -m venv` + pip；
- “打开官方安装页”“重新检查”；
- 不提供“安装受管工具”开关，因为本轮不做受管分发；
- 覆盖只在启动器内部生效，不修改系统 PATH。

### 3.7 PATH 接管边界

- 启动器不写系统 PATH；
- 对子进程注入：Git 目录前置到 PATH，必要时设置 `GIT_EXEC_PATH`；
- Python 使用绝对路径；venv 创建/依赖安装/任务启动都使用同一个解析结果；
- 如果用户把系统 PATH 改坏，启动器仍能通过设置里的显式路径启动；
- 诊断中展示“启动器实际使用的路径”，避免“我明明装了”的争议。

## 4. 数据模型草案

```ts
type ToolSource = 'path' | 'common' | 'custom' | 'missing'

interface ToolInfo {
  id: 'git' | 'python' | 'uv'
  source: ToolSource
  version: string | null
  path: string | null
  ready: boolean
  minVersion?: string
  detail?: string
}

interface ToolchainStatus {
  checkedAt: string
  git: ToolInfo
  python: ToolInfo
  uv: ToolInfo
  installGuide?: {
    gitUrl?: string
    pythonUrl?: string
    xcodeCommand?: boolean
  }
}
```

`Settings` 增加 `gitPath: string | null`；`pythonPath` 继续复用。扫描结果不持久化
为“已安装”，每次 OOBE/设置/预检重新解析，避免路径失效后仍显示 ready。

## 5. 非目标

- 不捆绑、不下载受管 Git/Python（本轮明确不做）；
- 不修改系统 PATH、不写全局环境变量；
- 不自动执行安装器、不静默提权；
- 不要求管理员权限；
- 不自动下载 27 GB 模型；
- 不在本轮实现 Linux 实机验收。

## 6. 已确认

1. Git/Python：只引导系统安装，不做受管下载；
2. 缺失回退：打开官方安装器/页面 + 重新检查，不安装受管工具；
3. OOBE：软引导 + 创建/安装/启动前预检拦截；
4. 工具链版本：固定在应用内（最低 Git 2.30、Python 3.10+；
   推荐 Python 3.12）；
5. 平台：macOS/Windows 代码路径都接，macOS 先实测，Windows 标未验收；
6. 系统工具优先；设置里允许自定义路径覆盖。

## 7. 实施顺序

1. `toolchain.ts`：扫描、版本校验、状态、安装入口 URL/命令；
2. `env.ts`：Git/Python 检查项、来源、动作；
3. `git.ts` / `runtimes.ts`：用解析结果和绝对路径接管；
4. 设置“工具链”分组 + 自定义路径；
5. OOBE 运行环境行 + 安装引导面板；
6. 预检诊断 + Diagnostics 动作；
7. 状态/README/架构文档同步；
8. macOS 场景验证；Windows 仅代码路径/未验收。

## 8. 参考

- [desktop/dugite](https://github.com/desktop/dugite)（已调研，本轮不采用）；
- [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  （已调研，本轮不采用）；
- [Git for Windows](https://git-scm.com/download/win)；
- [Python downloads](https://www.python.org/downloads/)；
- Apple `xcode-select --install` 的 CLT 安装流程。

> 版本/大小是 2026-10-19 的调研快照；本轮只锁定最低版本和官方入口，不引入
> 系统二进制/受管分发。
