> **Archived (2026-11-06).** An early layout guide for `apps/` that no longer matches the code. The current map is in [CONTRIBUTING.md](../../CONTRIBUTING.md).

# apps/

当前只有 `apps/desktop` 一个应用包：Electron 主进程 + preload + React renderer
一起用 `electron-vite` 构建。**五窗口共用同一套 renderer bundle**，按
`windowKind` 分流。

Clover Creator 保持 Electron-only，不提供浏览器 WebUI / served UI；HTTP/WS utility process 仅作为 Job/API 层，详见 ADR-0004。

## 结构

```
apps/desktop/
  electron.vite.config.ts
  src/backend/index.ts      独立 Node HTTP/WS（utilityProcess）
  src/main/
    index.ts                生命周期、smoke / screenshot / scenario
    windows.ts              启动器 / 创作 / 终端 / Kohaku Trainer / 设备管理器
    ipc.ts                  ipcMain.handle + zod + 事件
    lib/                    paths / run / events
    services/               env / network / git / runtimes / instances / models /
                            updates / settings / gallery / supervisor / parsers /
                            diagnostics / devices / cases / onboarding /
                            trainerGit / trainers / trainingHosts / remoteTrainer / ssh /
                            launchQueue / trainerArtifacts / projects / backend
  src/preload/index.ts      contextBridge：invoke / on / windowKind / acrylic / channel
  src/renderer/
    src/App.tsx             按 windowKind 分流 Launcher / Creator / Terminal / Trainer / Devices
    src/pages/              Home / Studio / Gallery / Terminal / Training / TrainerWindow / Devices /
                            Diagnostics / Instances / InstanceDetail / Models / Settings
    src/components/         AppTitlebar / layout / NotificationPanel / Oobe / ui
    src/store.ts            Zustand：env / instances / jobs / downloads / notifications / UI
    src/lib/                layout.ts / clover.ts / windows.ts / api / format / i18n
    src/styles.css          深灰亚克力 token + Fluent 2 控件
  src/shared/               types / channels / schemas
```

> `pages/Run.tsx` 是早期运行页遗留文件，当前路由不使用；以 `App.tsx` 与
> `windows.ts` 为准。

## 五窗口

| 窗口 | 路由 | 尺寸 | 内容 |
| --- | --- | --- | --- |
| 启动器 | `/` | 1180×760（最小 960×640） | 首页启动条/运行栈、实例、模型、训练、画廊、诊断、设置、OOBE |
| 创作 | `/studio` | 1320×860 | Studio、layout JSON、画廊 |
| 终端 | `/terminal` | 1120×720 | Cases + xterm（推理/训练） |
| Kohaku Trainer | `/trainer` | 1280×840 | 外部 trainer 配置、命令预览、doctor、训练状态 |
| 设备管理器 | `/devices` | 1180×780 | 本机/SSH host、GPU 库存、连接测试、部署入口 |

`windows.ts` 负责创建/单例/聚焦；preload 通过
`--clover-window=<kind>` 提供 `windowKind`。`window:open` 支持 route。

## 运行

```bash
pnpm install
pnpm dev
pnpm build
pnpm typecheck
```

部分 harness 设置 `ELECTRON_RUN_AS_NODE=1`，需临时去掉：

```bash
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --smoke
```

开发数据默认在 `.dev-data/`（已忽略）；不要把测试数据写进真实用户目录。

Windows PowerShell 下运行时，用以下方式清除可能影响 Electron 的 harness 环境变量：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm --filter @clover/desktop exec electron . --smoke
```

## 开发自检

| 命令 | 作用 |
| --- | --- |
| `--smoke` | 无窗口环境/公告/模型目录检查 |
| `--screenshot` | 启动器各路由 + 创作 + 终端 + 训练 + 设备管理器窗口截图 |
| `--scenario=create` / `second` / `install` | 实例、共享 runtime、依赖安装 |
| `--scenario=job` / `job-cancel` | 模拟推理、取消 |
| `--scenario=parser` | tqdm / OOM / 缺包解析 |
| `--scenario=job-real` | 缺权重预检 |
| `--scenario=windows` | 通过 IPC 打开创作/终端窗口 |
| `--scenario=trainer-deploy` | trainer clone + worktree |
| `--scenario=trainer-job` | 模拟训练 Job + step/loss |
| `--scenario=trainer-host` | SSH host 保存/读取/删除 |
| `--scenario=trainer-host-probe` | fake ssh 下 host 探测 |
| `--scenario=trainer-remote-local` | fake ssh 下远端 mirror/worktree |
| `--scenario=trainer-remote-env` | fake uv 下远端 venv/doctor |
| `--scenario=trainer-remote-job` | fake ssh 下远端训练 |
| `--scenario=trainer-remote-artifact` | fake ssh 下导出/产物登记 |
| `--scenario=queue-persist` | 队列落盘 |
| `--scenario=backend-http` | HTTP health/auth/WS |
| `--scenario=backend-job` | 经 backend 提交 simulate Job |
| `--scenario=backend-renderer` | 渲染进程访问 backend（CSP/CORS/POST） |
| `--scenario=project-save` | Project JSON 保存/读取 |

验证结论以 [../docs/status.md](../status.md) 为准，不要把 scenario 模拟
当成真实权重/CUDA 验收。

## 设计系统

- `@openai/apps-sdk-ui` + Tailwind 4；
- 深灰亚克力：标题栏/侧栏 `.glass-thin`，内容 `.content-surface`，卡片 `.glass`；
- 无绿色、无深蓝底、无浅色主题；强调色 `#8ab6ff`；
- 控件 4–6 px 圆角、约 30–32 px 高、宽度随文字；
- 标题栏 44 px，应用名居中 + `dev/release` + 版本；启动器无侧栏 Logo；
- 训练窗口标题栏为 `Kohaku Trainer` + `external`。

## 相关文档

- [文档索引](../README.md)
- [事实来源：status](../status.md)
- [架构](../architecture.md)
- [产品设计](../product-design.md)
- [路线图](../roadmap.md)
- [Windows 开发与验收手册](../windows-validation-guide.md)
