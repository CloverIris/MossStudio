---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: tools/release/integration/, apps/desktop/e2e/specs/, apps/desktop/src/renderer/src/pages/install/, apps/desktop/src/renderer/src/pages/setup/, apps/desktop/src/renderer/src/components/update/updateModel.ts, apps/desktop/src/shared/engineChoice.ts
---

# Release QA checklist

The manual checks a person runs on a real Windows machine and a real Linux machine before tagging a release. CI already installs, updates, rolls back and uninstalls test builds, and drives every screen against a mock backend; this list holds only what needs real hardware, a real GPU driver, a real user account or a human eye. The release steps themselves are in [`docs/how-to/release.md`](/docs/how-to/release.md).

## What CI covers, so you do not

| Automated | Where | Leaves for a human |
| --- | --- | --- |
| Silent install into a path with spaces and Chinese characters, update through a local signed feed, rollback of a version that fails to start, silent uninstall keeping `data/`, reinstall into the kept folder | `tools/release/integration/run.mjs` (`pnpm test:install`), on Windows, Linux and macOS arm64 for PRs that touch install or update code (see [`CONTRIBUTING.md`](/CONTRIBUTING.md)) | The visible installer, a fresh user account, the real `stable` feed, the previous public release |
| Every setup, update, uninstall and settings screen, light and dark, at the supported window sizes, against a mock backend | `apps/desktop/e2e/specs/install.e2e.ts`, `update.e2e.ts`, `settings.e2e.ts`, `visual.e2e.ts` | Real GPU rendering, system theme changes, display scaling |
| Engine choice per GPU (CUDA 13, CUDA 12 with a driver tip, 兼容模式, AMD 原生) from recorded machine probes | `apps/desktop/e2e/specs/engineDetect.e2e.ts`, `setup.e2e.ts` | Detection on a real driver, the real download and a real generation |

## Before you start

- Build the release candidate the way the release workflow does (`pnpm build`, then `tools/release/make-artifacts.mjs` per platform), or take the artifacts from the candidate's CI run. The setup files are `MossStudio-Setup-<version>-x64.exe` and `MossStudio-Setup-<version>-linux-x64.run`.
- On each machine, write down: OS version, GPU model, driver version (`nvidia-smi`, or `rocminfo` on AMD), display scaling, and which public release is installed. Put the list in the release PR.
- Use a user account that has never run MossStudio for the install checks. On Windows, a second local account is enough; on Linux, a new user.

## 1. Installer UI on a fresh user account

| Step | Pass when |
| --- | --- |
| Download the setup file through a browser and run it | Windows: the unsigned-binary warning appears once (the binaries are not code-signed yet, see the release how-to) and the splash 正在准备安装… leads to the 安装 MossStudio window. Linux: the `.run` is executable after download, or works after `chmod +x`. |
| Read the 安装位置 card | The default is `%LOCALAPPDATA%\Programs\MossStudio` (Windows) or `~/.local/share/MossStudio` (Linux); the line shows 需要 … · 可用 … with believable numbers. |
| Pick a non-empty folder, then a system folder | A non-empty folder offers `<chosen>\MossStudio` instead; a system folder or drive root is refused with the reason. |
| Click 安装 and wait | Progress steps run through 正在复制文件… and 正在创建快捷方式… to 安装完成, and the app opens on its own. |
| Look around the OS | Windows: a desktop shortcut, a Start menu entry and a 设置 › 应用 entry with the right version. Linux: MossStudio appears in the application menu with its icon. |

## 2. Real GPU: engine install and first generation

Run on every GPU class you can reach. The expected engine comes from `chooseEnginePackages` in `apps/desktop/src/shared/engineChoice.ts`; the driver minimums from `apps/desktop/src/shared/enginePackages.ts`.

| Machine | Expected line under 详情 on 准备开始创作 |
| --- | --- |
| NVIDIA, driver at or above 580.88 (Windows) or 580.65.06 (Linux) | CUDA 13 引擎 |
| NVIDIA, older driver | CUDA 12 引擎, plus the tip 把 NVIDIA 显卡驱动更新到 R580 或更新版本 |
| AMD on Linux with ROCm 7, GPU in `HIP_GFX_TARGETS` | AMD 原生 |
| AMD on Linux without ROCm 7 | 兼容模式, plus 安装 ROCm 7 可获得更快的原生支持。 |
| Any other GPU (Windows AMD, Intel) | 兼容模式 |
| Integrated GPU next to a discrete one | 不使用（已有独立显卡） |

Then, on each machine:

| Step | Pass when |
| --- | --- |
| First run lands on 准备开始创作; the GPU line names the real card and memory; 下载约 N GB and 保存到 match the machine | Click 开始下载: the page becomes 正在准备 with one percentage, bytes, 还要约 … and the two parts 运行组件 and the model. |
| Click 先去看看 | The board opens; the title bar shows 准备中 N% with a time left; 生成 reads 下载完成后就能生成 · N%. Clicking the chip returns to the page. Quit and reopen mid-download: it carries on by itself. |
| Wait for the download to end | The toast 模型准备好了，可以生成了 appears, the chip disappears, and the setup page does not come back on the next start. |
| Click one of the three ideas on 画面 1, or type a description, then 生成 | A picture appears on the card and in 作品. Note the time per picture at default settings in the PR. |
| On a 兼容模式 or AMD 原生 machine, open the 画面 inputs | Picture inputs, LoRA, sampler and 高清修复 are hidden, and the card says 这台设备用兼容模式引擎，只能文生图 (or AMD 原生). |
| Open 设置 › 设备与引擎 | Each GPU has its 引擎： line; with two GPUs 设为默认 and 改为自动 work; 重新检测显卡 finishes without an error. |
| Update the driver on the CUDA 12 machine, click 重新检测显卡 in 设置 › 设备与引擎 | The line changes to CUDA 13 引擎 and 安装缺少的引擎 installs it. |
| On a machine with no usable GPU | The page says 这台电脑跑不了模型 and offers 用另一台电脑 and 重新检测; 用另一台电脑 opens 添加 SSH 主机 and turns 远程主机 on. |

## 3. Update from the previous public release

The integration test updates between fixture builds it made itself. This check uses the real previous release and the real feed.

| Step | Pass when |
| --- | --- |
| Install the previous public release from its GitHub release page, generate one picture, create one project | Baseline exists. |
| Publish the candidate as a prerelease (`<version>-beta.1`), which goes to the `beta` channel only (release how-to). In the old version, set 设置 › 通知与更新 › 更新渠道 to 测试版 and click 检查更新 | With 自动更新 on, the update downloads (a delta where one exists) with no toast, no 活动 entry and no title-bar chip; the settings row reads <version> 已下载，下次打开时更新 and offers 现在重启. |
| Quit and start the app again | The new version runs with the project and the picture intact, and says once 已更新到 <version>; 看看新内容 opens that version's release notes in the browser. |
| Repeat with 自动更新 off | The title bar shows 新版本 <version>; 下载更新 is needed before anything changes. |
| In the new version, 设置 › 通知与更新 › 回到上一个版本 | Asks first, then the previous version runs again and shows 已跳过 <version>; its 安装 <version> button installs the new version a second time. |
| Previous release that cannot read the signed feed (no production key at the time it shipped) | Run the new setup file over it instead: the window skips the location question (`update`), or shows 发现旧版 MossStudio for a 1.0.x folder with 继续使用这些数据（不复制） selected; afterwards the old projects and models are in place. |

## 4. Uninstall leaving the data folder

| Step | Pass when |
| --- | --- |
| Windows: 设置 › 应用 › 已安装的应用 › MossStudio › 卸载. Linux: 设置 › 关于 › 卸载 MossStudio | The 卸载 MossStudio window (Windows) or dialog (Linux) appears with 同时删除我的数据（作品、模型、设置） unticked. |
| Confirm with the box unticked | The app closes; program files, shortcuts and the 设置 › 应用 or application-menu entry are gone; `data/` (projects, models, settings) is still there. |
| Run the setup file again, same folder | The location card says the folder holds kept data and will use it (or the 保留的数据 card appears when installing elsewhere); after install the old projects open. |
| Uninstall once more with the box ticked | A warning says it cannot be undone; afterwards the data folder is gone. |

## 5. Both themes

The E2E suite screenshots every screen in both themes with software rendering. Check what it cannot: the real GPU compositor, the OS theme switch, and scaling.

| Step | Pass when |
| --- | --- |
| 设置 › 通用 › 主题: 浅色, then 深色 | The whole window switches at once, including the title bar (own buttons on Linux, system frame on Windows), the board, cards and the settings page; no light panel is left in dark mode or the reverse. |
| 跟随系统, then change the OS theme while the app is open | The app follows without a restart. |
| Run the setup file and the uninstall window under a dark OS theme | Both windows and the launcher splash are dark. |
| Display scaling at 125 % and 150 % (Windows), or a HiDPI monitor (Linux) | Text is sharp, nothing is clipped on the right, the board and wires stay aligned when dragging. |

## Recording a failure

For each failure put in the release PR: the step, a screenshot, the machine line from "Before you start", the output of 设置 › 关于 › 复制诊断信息, and the log files: `<data root>/logs/` for the app, the setup log offered by 查看日志 on the 安装没有完成 screen, and `<data root>/logs/launcher.log` for the launcher. A failed check blocks the tag until it is fixed or recorded as a known issue in `release/notes/<version>.md`.
