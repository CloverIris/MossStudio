# 架构

## 1. 范围

MossStudio 是 MOSS-Image 的 Electron 创作工作台。它不实现采样算法；算法由 **MossInfer `moss-server`** 执行。官方 Gradio、官方 MOSS-Image 仓库 worktree、推理 Python runtime 都不属于当前产品架构。

当前硬边界：

- 推理平台：Windows/Linux x86_64 + NVIDIA。
- macOS：UI/管理/项目可用，无本地 MossInfer。
- Trainer 是独立第二窗口，保留自己的 Python/Git 环境。
- GBC 是可选外部工具，不参与核心启动检测。

## 2. 进程与窗口

```
Electron main
├── Studio BrowserWindow
│   └── bottom pages: 创作 / 引擎 / 模型 / 设备 / 训练 / 画廊 / 诊断 / 设置
├── Trainer BrowserWindow
└── backend utility process (HTTP/WS, token)
```

- `WindowKind = 'studio' | 'trainer'`。
- Studio 默认 1600×1000，不做 OS 全屏。
- 管理页不再有独立 launcher 窗口；旧 IPC intent 映射为页面导航/终端抽屉。
- 终端是 Studio 底部抽屉，按 engine/host 聚合为「引擎控制台」。
- `App.tsx` 是双窗口 shell；`StudioPage` 是三列工作台。

## 3. 代码结构

```text
apps/desktop/src/
  main/
    windows.ts              双窗口
    ipc.ts                  typed IPC
    index.ts                生命周期、migration、scenarios
    services/
      supervisor.ts         Job 生命周期、本机/远端引擎任务
      mossInfer.ts          本机 moss-server 单例 + FIFO
      mossInferDownload.ts  引擎包查询/下载/安装
      remoteEngine.ts       SSH sidecar 协议/输出回传
      remoteEngineInstall.ts 远端 bundled 引擎安装
      remoteModels.ts       远端 HF 模型准备
      systemCuda.ts         系统 cuBLASLt 预检
      cudaWheels.ts         NVIDIA wheel 原生解压
      engines.ts            本机版本切换、远端 engine 状态
      engineReadiness.ts    唯一就绪状态与缓存
      adapterResolution.ts  Canvas LoRA id → 权重路径（本地导入/训练产物）
      updates.ts            发布文档解析、更新检查、公告
      updateWatcher.ts      启动/定时/窗口聚焦触发的主动检查
      models.ts / modelFiles.ts / modelBundles.ts
      projects.ts
      trainingHosts.ts / trainers.ts / remoteTrainer.ts / trainerEnv.ts
      ai.ts                 Provider/Agent
      gbc.ts                GBC 桥
    lib/
      probeEngine.ts        一次性 moss-server hello 探测
      engineStore.ts        staging/backup/trash 原子目录事务
  backend/                  HTTP/WS utility process
  preload/                  contextBridge
  renderer/
    App.tsx                 Studio/Trainer shell
    pages/Studio.tsx        三列工作台
    pages/Engine.tsx        引擎管理
    pages/Terminal.tsx      引擎控制台
    pages/Models.tsx        模型库
    components/             panels, Agent, dialogs
  shared/                   types/channels/schemas/backend
    engineProtocol.ts       所有不可信 hello 的唯一解码与兼容判定
    engineReadiness.ts      引擎页与准备清单共用状态文案
    adapters.ts             LoRA id/强度校验、状态与选择解析
    release.ts              release.md 机器块解析、版本比较
```

## 4. 页面与路由

| 路由 | 页面 |
| --- | --- |
| `/studio` | 创作工作台（默认） |
| `/engines` | 本机/远端引擎 |
| `/models` | 模型与下载 |
| `/devices` | SSH/设备 |
| `/training` | Trainer 管理 |
| `/gallery` | 画廊 |
| `/diagnostics` | 诊断 |
| `/settings` | 设置 |

Studio 内部：

- 项目条：Project tabs、后端状态、保存、新建
- 画布条：画布工具与区域类型、当前 Canvas 上下文、缩放/适配
- 画布板：多张布局/结果 Canvas 自由平铺，可拖动、缩放、缩略图导航
- 左栏：提示词、布局描述、生成参数、图库 + 底部「开始生成」动作条
- 右栏：图层、Agent、图像解析
- 左右栏可拖动调宽、可收起为边轨
- 终端抽屉覆盖在画布区域上方

## 5. 引擎与任务

### 本机

```
startEngineJob({ modelBinding, deviceId, prompt, ... })
  → resolveServerPath
  → runMossInferJob
  → mossInfer.ts (singleton + FIFO)
  → outputs/<job>.png
```

- `moss-server` JSON-lines：`hello / load / generate / cancel / shutdown`。
- 所有本机和远端 `hello` 必须先经 `shared/engineProtocol.ts` 解码；禁止调用方直接读取未验证的 raw 字段。`supported: true` 是目标设备兼容性的唯一权威，算力只用于选包、展示和 warning。
- 事件映射为 `hello / ready / log / stage / progress / result / error / canceled`。
- 同一时间一个 active generation；后续任务在内存队列等待。
- `startEngineJob` 不读取 Instance/Python runtime；只要求模型路径与引擎。
- Canvas `adapters` 在两条入口（IPC 与 HTTP backend RPC）都先经 `adapterResolution.ts` 解析成绝对路径，缺失/未安装直接抛错，不静默丢弃；`generate.loras` 只在非空时下发。远端引擎暂不支持 LoRA，提交时给出明确提示。

### 远端

```
SSH host → spawn ssh → remote moss-server
  → stdio JSON-lines
  → generate → remote PNG → SSH base64 → local outputs
```

- 当前每个远端 job 一个 SSH sidecar 进程。
- 引擎控制台按 host 聚合；持久单引擎队列尚未完成。
- 远端要求 Linux x86_64、NVIDIA、curl/tar、SSH。

### 引擎包

- 两种包：`system-cuda`（小，依赖系统 cuBLASLt）和 `bundled`（+700MB，自带 CUDA 库）。
- 本机可选择 GitHub 正式 Release；上游没有 Release 时稳定渠道回退至最新成功 CI artifact。已安装版本可在引擎页切换或删除。
- 本机安装是目录事务：下载、CUDA 库、probe 和兼容判定都在 `.staging` 完成，安装检查通过后才晋升；current 先 shutdown 再进入 `.backup`，失败回滚，启动时按 `.pending.json` 恢复。settings 只在晋升成功后指向新 binary。
- 已存在的版本目录都可直接切换，不增加独立的版本验证步骤或验证记录。外部引擎只登记路径，不写用户引擎目录。
- `EngineReadiness = missing | ready` 是 store、Engine、Oobe、Settings 的唯一本机状态来源。活跃安装进度与持久化的最近尝试分开，`ready` 可以同时显示「上次更新失败」。
- Windows `.zip` 由 Node `yauzl` 解压并校验归档路径，不依赖系统 Python；Linux `.tar.gz` 使用系统 `tar`。
- 默认 `system-cuda`，下载前 `systemCuda.ts` 预检；缺库弹窗。
- 缺库时的选项：
  - bundled 包
  - system 包 + `cudaWheels.ts` 原生下载/解压 NVIDIA wheels
- 不用 uv/pip 安装 CUDA 库。

## 6. 模型

- 模型是组件化 bundle（dit/text encoder/vae/support）。
- 本地 HF 缓存、导入模型、推荐组合。
- Project 保存 `modelBundleId`/`deviceId`，不再保存 `instanceId`。
- 远端模型：本地解析 HF revision/files，远端 `curl` 下载；默认 SFT，组件 bundle 待补。

## 7. 存储

```text
<userData>/
  settings.json
  hosts.json
  projects/<id>/project.json + assets/
  models/hf/hub/
  models/adapters/
  outputs/
  jobs/
  mossinfer/<stamp>/     已安装版本目录
  mossinfer/external.json 外部引擎路径登记
  mossinfer/last-attempt.json 最近一次安装成功/失败
  mossinfer/.staging/    未晋升安装，不进入版本列表
  cache/
  trainer/
  legacy-inference-*/    旧推理归档
```

- 不依赖数据库。
- `legacy-inference.ts` 首次启动归档 instances/runtimes/git。
- 旧 Project 的 `instanceId` 忽略；新字段为 `modelBundleId`/`deviceId`。

## 8. 安全

- Renderer 不直接访问 Node；preload 白名单 + Zod schema。
- API key 只在主进程；renderer 只看到 `hasKey`。
- SSH 密码使用系统安全存储；不写 host JSON。
- LAN WebUI 使用 token；HTTP/WS utility process 绑定本机或设置允许的 LAN 地址。
- 外部命令通过参数数组/`posixQuote`，远端路径 quote。

## 9. 验证

```bash
pnpm typecheck
pnpm build
pnpm test:ui
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --smoke
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-remote-job
```

## 10. 已知技术债

- 旧 Instance/Git/runtime/runner 文件仍在，产品入口已删除。
- 远端 job 仍是每 job 一个 SSH 进程。
- LAN WebUI 仍有 bootstrap `instances: []` 兼容字段。
- 真实 Windows/Linux NVIDIA 与安装包未验收。
