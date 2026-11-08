---
status: superseded
date: 2026-10-19
superseded-by: ADR-0007, ADR-0008, ADR-0009
---

# ADR-0004：工作台、远程部署与全局设备管理器

- 关联：[ADR-0002](0002-trainer-backend.md)、[ADR-0003](0003-launcher-first.md)
- 影响：启动条语义、Instance/Case/Job 数据模型、窗口数量、创作前端形态、SSH 边界

## 0. 修订（2026-10-19，同日）

**取消浏览器 WebUI / served WebUI。** 原 2.4 中“后端提供同一份 served WebUI、
Electron 加载同一 URL”的方案撤销。Clover Creator 保持 **Electron-only**，继续在
现有窗口里用现有 React/IPC 架构开发，不做 IPC→HTTP/WS 迁移。

- Project 管理仍是 Creator 窗口内的 `/projects` 路由，不是独立窗口，也不是 WebUI；
- HTTP/WS 后端保留为 Job/API 层，不承担 UI；
- 设备管理器、终端 Sessions、远端 Instance、Gradio 参数面板的决定不变；
- 第 2.4、4、5 节已按此修订。

## 1. 背景

当前实现把几件事混在了一起：

- 启动条的「后端」同时放了**官方 Gradio**与 **Clover**。前者是自带 UI 的完整
  Gradio 进程，后者是 runner + Clover WebUI；它们不是同一种“后端”。
- Gradio 只能配端口和额外参数，且高级弹层与 Case 的边界不清楚。
- 设备只枚举本机 MPS/CUDA/CPU；SSH host 只属于训练器，推理、训练、终端各有一套
  “设备/主机”心智。
- 终端只是 Job 日志查看器，不是 Shell；Cases 不显示 Project，也不标本机/远端。
- 创作窗口是 Electron IPC 专用前端；Project 只是 Studio 顶部的一个下拉，没有项目管理器。
- 官方 Gradio 的生成参数是页面内状态，不是启动参数。启动器不能 Fork 上游，也不
  应该假装能接管这些参数。

本轮产品决策要守住的核心是：**启动器只负责管理上游、准备环境与权重、按参数启动
实例；上游代码是原样的。** 远程能力是同一套编排在 SSH 上的延伸，不是第二套产品。

## 2. 决策

### 2.1 用「工作台」取代「后端」

Case 只做一个选择：

- **官方 Gradio**：启动上游 `gradio_app.py`，使用官方 Gradio UI；
- **Clover**：启动 Clover runner，使用 Clover 创作窗口。

两者共享同一个 Instance、同一个 Device、同一套模型/运行时管理。它们不是可以任意
拼接的“引擎 × 界面”。

- UI 文案统一用「工作台」，不再把两者叫「后端」；
- 保存后的 Case 固定工作台；切换工作台要新建 Case 或显式复制；
- 官方 Gradio 工作台显示「Gradio 参数」按钮；Clover 工作台显示「打开创作窗口」；
- 不存在“官方 Gradio 进程 + Clover UI”这种组合。若未来要做，必须另立协议 ADR，
  不能在本轮偷偷实现。

### 2.2 部署实例支持本机与远端

Instance 增加**部署位置**：

```
placement:
  | { kind: "local" }
  | { kind: "ssh", hostId: string, root: string }
```

- 远端 Instance 仍然是“官方仓库某个 commit + runtime + 模型绑定”，只是仓库、
  venv、模型缓存和输出目录位于远端 host；
- 远端部署复用现有 mirror/worktree/venv 思路，不把 27 GB 权重默认上传；
- **Instance 的 placement 决定可用设备**：本机实例只能选本机设备，远端实例只能选
  同一 host 上的 GPU。启动条不再允许出现“本机实例 + 远端设备”；
- 远端配置、日志、健康状态都带 host 标识；删除远端实例不删除远端用户数据，
  除非用户二次确认。

### 2.3 Case 是启动配方，Gradio 配置属于 Case

Case 字段增加 `workspace` 与可选的 `gradio` 启动配置：

```
Case {
  instanceId
  workspace: "official" | "clover"
  deviceId
  profile: "base" | "dmd8"
  gradio?: GradioLaunchConfig
}
```

`GradioLaunchConfig` **只允许上游 argparse 支持的启动级参数**：

- 模型：`--model`、`--model-root`、`--local-files-only`
- 输出：`--output-dir`
- 提示词默认值：`--prompt-defaults`
- 档位：`--profile auto|16gb|24gb|48gb`
- 服务：监听范围（本机/局域网）、端口（自动/指定）
- 启动器行为：打开方式（系统浏览器 / 应用内窗口 / 仅复制 URL）
- 高级：额外 CLI 参数、命令预览、恢复官方默认值

**不接管** steps、CFG、尺寸、生成数量、显存模式、Compile、SLG 等生成参数；这些
留在官方 Gradio 页面内。若未来要提供“生成默认值”，必须先决定是包装上游还是维护
补丁，另立 ADR。

「启动位置」拆成三层，避免两个“位置”来源：

| 层 | 由谁决定 | 面板中的表现 |
| --- | --- | --- |
| 计算位置 | Instance 的 placement + 启动条「设备」 | 只读显示“本机 / host”，不能在这里改 |
| 界面打开位置 | Gradio 启动配置 | 系统浏览器 / 应用内窗口 / 仅复制 URL |
| 服务监听范围 | Gradio 启动配置 | 仅本机 / 局域网；远端场景有安全警告 |

Gradio 参数面板是启动条上的侧滑面板，不是新窗口。它绑定当前 Case 草稿：

- 只在工作台为官方 Gradio 时出现；
- 修改先是草稿，点「应用到当前启动条」或「保存为 Case」才持久化；
- 关闭后按钮旁显示一行摘要，例如 `SFT · auto · 自动端口 · 浏览器`；
- 面板底部始终显示实际命令行预览；远端路径用 host 标识，不做本地文件选择器；
- 端口字段从「高级」移入面板，高级只保留与工作台无关的 Case 字段。

### 2.4 唯一的 Clover 前端：Electron-only

Clover Creator 是唯一替代官方 Gradio 的创作前端（这里的“第三方”是相对官方
Gradio 而言，不是外部厂商插件）。**不提供浏览器 WebUI，也不做 served UI。**

- 继续在现有 Electron 创作窗口里开发，沿用现有 React/IPC 架构；
- 不做 IPC→HTTP/WS 迁移，不提供静态 WebUI、浏览器 token、Web 端文件选择；
- 只有一套前端，因此不存在 Electron/浏览器双实现或行为差异；
- HTTP/WS 后端保留为 Job/API 层，不承担 UI；现有 `/api/jobs` 提交路径可以保留，
  后续是否统一到 IPC 属于代码整理，不影响产品语义；
- 浏览器访问、局域网创作、远程浏览器协作不在本轮范围；如果未来要做，另立 ADR。

Project 管理是 Creator 窗口内的一级入口：

- `/projects` 是 Creator 窗口内的项目管理器：缩略图、画布尺寸、图层数、更新时间、
  关联实例/设备、最近一次生成；支持新建、打开、复制、删除、导入/导出；
- **一个 Project = 一个画布**；本轮不做“一个 Project 下多页/多画布”；
- Project 是本地文档；远端只负责计算。任务产生的结果自动归档到 Project 资产，
  同时进入全局画廊；
- Job 记录 `projectId` / `projectName`；Case 不绑定 Project。一个 Case 可以被多个
  Project 使用，Project 也可以切换 Case。

创作窗口要与官方 Gradio 能力对齐，并保留现有 layout 工具：

- 模型选择与本地/远端模型路径；
- Prompt、负向 Prompt、提示词默认值；
- 百万像素、宽高比、宽高、预设；
- 生成数量、Seed / Random、Steps；
- 高级：CFG、Shift、显存模式、Compile、SLG 模式/层/scale/interval、最大文本长度；
- 生成队列/状态、结果画廊、元数据、示例；
- 现有「框选区域 → 编译 layout JSON → 插入 Prompt」的拖拽工具继续作为核心差异能力；
- 生成提交到共享 Supervisor，Job 进入终端并带 Project 标签。

### 2.5 全局设备管理器是独立窗口

新增第五个 Electron 窗口：**设备管理器**（`devices`），不再让训练器、推理、终端
各自维护 host。

职责：

- 管理 host：本机固定一条；SSH host 增删改、测试、host key 指纹确认；
- 管理 device：host 下的 GPU/加速器、显存、可用性、当前占用、最近任务；
- 显示总量与占用：`N 个 host / M 个设备 / X 个运行中 / Y 个排队`；
- 同一套设备被启动条 Case、训练页、终端新建远程 Shell 共用；
- 提供入口：「部署实例」「打开终端」「在训练中使用」，但不在这里复制启动器或
  训练器的完整表单；
- 训练页的 SSH host CRUD 迁移到这里；`training-hosts.json` 做一次性迁移，保留 ID；
- 使用系统 OpenSSH，支持 Identity file/agent、系统安全存储加密的密码和无验证，按设备保存登录方式；保持严格 host key 校验，首次连接通过指纹确认建立信任。

Instance 仍由启动器管理，设备管理器只提供“算力与连接”。这样不会出现第二个启动器。

### 2.6 终端是 Sessions，不只是 Job 日志

终端窗口的左侧统一为 **Sessions**，包含两类：

- **Job sessions**：推理/训练任务的 stdout/stderr/stdin，保留已完成记录；
- **Shell sessions**：本机 PTY 与远程 SSH PTY，可新建、可交互、可关闭。

行标题与副标题规则：

```
主标题：Project 名称（有 projectId 时）否则 Case 名称
副标题：推理 / 训练 / Shell · 本机 / 远端 host · 状态
```

- 右侧头部同时显示 Project、Case、host、PID/会话 ID；
- Project 是本地文档，不等于终端也在本地；必须分别显示“项目位置”和“执行位置”；
- 新建入口：本机 Shell、远程 Shell（选 host）；从实例/项目进入时预置 cwd 与 venv；
- 远程 Shell 与设备管理器共用 host/identityFile，不重复配置；
- 关闭 Shell 只结束会话，不删除 Project/Job；Job 停止仍走 Supervisor 的取消语义。

### 2.7 远程数据边界

默认采用**远端自治 + 结果回传**：

- 官方仓库、运行时、模型在远端独立下载与缓存；不自动上传 27 GB 权重；
- 官方 Gradio：远端启动 `gradio_app.py`，本地通过 SSH 本地端口转发打开；
  启动器管理隧道与远端进程的生命周期；
- Clover runner：远端执行我们的薄 runner，NDJSON 经 SSH stdout 回传；日志进入共享
  Job/诊断；完成后把结果文件拉回本地；
- 官方 Gradio 没有 Job 完成事件，输出同步由一个不做上游修改的远端目录观察器完成：
  轮询新的 `parameters.json`/图片，拉回本地画廊；这是实现细节，不改变“远端是源、
  本地是缓存”的语义；
- 远端结果拉回后进入本地画廊/Project 资产；远端文件不自动删除；
- 局域网开放必须显式确认。Gradio 本身没有认证，默认只绑 `127.0.0.1` 隧道。

## 3. 数据模型草案

```ts
type WorkspaceKind = 'official' | 'clover'

type Placement =
  | { kind: 'local' }
  | { kind: 'ssh'; hostId: string; root: string }

interface InstanceInfo {
  // 现有字段...
  placement: Placement
  hostId?: string
}

interface GradioLaunchConfig {
  model?: string
  modelRoot?: string
  localFilesOnly: boolean
  outputDir?: string
  promptDefaults?: string
  profile: 'auto' | '16gb' | '24gb' | '48gb'
  listen: 'local' | 'lan'
  port: number | null
  openMode: 'browser' | 'app-window' | 'copy'
  extraArgs?: string
}

interface LaunchCase {
  // 现有字段...
  workspace: WorkspaceKind
  gradio?: GradioLaunchConfig
}

interface JobRecord {
  // 现有字段...
  workspace?: WorkspaceKind
  hostId?: string
  projectId?: string
  projectName?: string
}

interface TerminalSession {
  id: string
  kind: 'job' | 'shell'
  hostId?: string
  projectId?: string
  // job: jobId; shell: pty id, state, title...
}
```

`Host`/`Device` 服务是唯一设备来源；`training-hosts.json` 迁入该服务。旧 Case 的
`backend` 映射为 `workspace`，旧的 `port`/`extraArgs` 映射为 `gradio` 配置。旧 Job
没有 `projectId` 时继续按 Case/实例显示。

## 4. 明确不做

- 不 Fork、不修改、不 vendor 官方 Gradio。
- 不做“官方 Gradio 引擎 + Clover UI”的自由组合。
- 不把 Project 存到远端；本轮 Project 是本地文档。
- 不把 27 GB 权重默认上传/同步到远端。
- 不在训练器、推理、终端各维护一套 host/device。
- 不做“一个 Project 多画布”；本轮一项目一画布。
- 不做浏览器 WebUI / served UI；Clover Creator 只以 Electron 窗口交付。
- 不为 WebUI 做 Creator 的 IPC→HTTP 迁移；现有 HTTP/WS 后端只作为 Job/API 层。

## 5. 实施顺序

1. **语义与数据迁移**：Case 的 workspace 字段、Instance placement、Job 的
   project/host 字段、旧 `backend` 迁移；启动条文案改「工作台」。
2. **Gradio 启动参数面板**：侧滑面板、Case 持久化、命令预览、端口迁移。
3. **全局设备管理器**：host/device 库存、训练 host 迁移、统一选择器、计数与占用。
4. **远端 Instance + 官方 Gradio**：远端部署、SSH 隧道、开放方式、生命周期。
5. **Creator 内项目管理器**：`/projects` 路由、一项目一画布、结果归档；不做
   served WebUI，不迁移 Creator 的 IPC 架构。
6. **终端 Sessions**：本机/远程 PTY、Shell 与 Job 统一列表、Project/host 标签。
7. **创作窗口对齐 Gradio + 远端 runner 结果回传**：高级采样参数、示例、队列/结果、
   远端薄 runner、输出拉回。

第 1–3 步不依赖真实远端验收，可先完成并用 fake ssh 验证；第 4 步之后需要真实
host 才能把 🟡 改成 ✅。

## 6. 尚未定死的实现细节

以下不改变上述语义，但实现前要定：

- Gradio 面板用侧滑面板还是整页（本轮倾向侧滑，保持启动条上下文）；
- 远端 Gradio 输出观察器的轮询间隔与失败退避；
- 本机/远程 PTY 使用 node-pty 的打包与签名成本；
- 局域网开放的 token/认证方式（在 Gradio 无认证的前提下，默认不开放）；
- 远端路径选择用文本输入 + SSH 校验，还是做 SFTP 目录浏览器；
- Creator 现有 `/api/jobs` 提交路径是否统一回 IPC（纯代码整理，不做 WebUI 迁移）。
