# MossStudio

**MOSS-Image 的桌面创作工作台。**

MossStudio 用 Electron + React 把提示词、布局画布、图层、模型、设备与生成任务放进一个工作区；推理通过 **MossInfer sidecar** 执行，桌面端不依赖官方 Gradio、不 clone 官方仓库，也不需要推理侧的 Python 环境。

> 当前版本 `0.1.0`，开发阶段。本机（Windows + RTX 2080）已跑通真实出图；安装包、签名和跨机器验收仍未完成，详见 [实现状态](docs/status.md)。

## 核心模型

一个 **Project** 里有多张 **Canvas**，平铺在一块可以自由拖动的**画布板（board）**上：

- **布局 Canvas**：可编辑，承载尺寸、提示词、采样参数和一串**区域（bbox 图层）**。点「开始生成」后它自己出图。
- **结果 Canvas**：只读，承载某次生成的参数快照和图片。重跑不会覆盖它，而是在下方新建一张结果 Canvas。

生成的串行队列由 MossInfer 保证：同一设备同一时间只有一个任务在跑，其余排队。

## 特性

**画布板**

- 自由拖拽：卡片位置存在 `project.json` 的 `x/y`，不再是固定网格。
- 卡片按自身宽高比呈现；`512²` 的面积正好是 `1024²` 的四分之一。
- 空白处左键拖动平移，滚轮以光标为锚点缩放，`⤢` 一键适配全部卡片，右下角有缩略图导航。
- 点选卡片自动居中到 125% 工作缩放。

**生成体验**

- 左栏写提示词、改参数，底部固定动作条：`开始生成` 与「实际发送内容」提示。
- 画布上有区域时**自动编译布局 Prompt**，无需再手动「编译 → 插入」；没有区域时用左栏手写提示词。
- 进度显示在对应 Canvas 上：底部一条进度绑带 + 卡片呼吸光晕，不再弹出终端窗口。
- 结果直接在 Canvas 内显示；双击打开预览，含完整参数与「在文件夹中打开」。

**编辑**

- 区域框内直接写提示词；右栏图层列表支持**拖拽排序**，顺序即布局 Prompt 里的区域编号。
- 图层与画布双向定位，支持隐藏/锁定/不透明度。
- 每张布局 Canvas 有「完成/允许编辑」「重跑」「删除」「复制参数」入口。

**工程管理**

- 顶部 Project tabs：双击重命名、hover 删除、拖动排序、`Ctrl/Cmd + S` 显式保存（同时保留 1.2s 自动保存与未保存圆点）。

**其它页面**

- MossInfer 引擎：本机 system/bundled 包、CUDA 库预检、Release 通道、远端 Linux SSH。
- 模型库：组件化 bundle、共享 HF 缓存、推荐组合、本地导入。
- 设备：启停与别名（可持久化）。
- 训练（Trainer，独立窗口）、画廊、诊断、设置（8 个分区）。
- Agent：多 Provider、对话历史、提示词分段/润色/翻译。
- GBC（可选）：KohakuGBC/Togeari 图像解析桥，把 bbox/描述导入画布；外部 Python 工具，不参与启动。

## 架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron main                                                 │
│  window: Studio / Trainer                                     │
│  services: projects, models, engines, jobs, devices, trainer  │
│  backend utility process: HTTP/WS + token                     │
└───────────────┬───────────────────────────────┬──────────────┘
                │ typed IPC / HTTP              │ stdio JSON-lines
                ▼                               ▼
        React Studio workbench           moss-server (MossInfer)
        board / panels / Agent            ├─ local
        Project / Gallery / Models        └─ Linux SSH host
```

- **Studio** 是主窗口，创作页 + 顶部页面导航。
- **Trainer** 是唯一独立保留的第二窗口。
- 推理算法全在 `moss-server` 内；MossStudio 只负责 `hello / load / generate / cancel` 与事件。
- 任务不绑定 Instance：模型、设备、引擎是三个独立选择。
- Project 持久化为 JSON + 资源文件，不使用数据库。

## 平台与依赖

| 目标 | 状态 |
| --- | --- |
| Windows x86_64 + NVIDIA | ✅ 本机真实出图（RTX 2080 / system-cuda） |
| Linux x86_64 + NVIDIA | 🟡 代码路径已接，实机待验收 |
| Linux SSH 远端 GPU | 🟡 fake 链路通过，真实主机待验收 |
| macOS | UI/管理/项目可用；无 MossInfer 本地推理 |

运行要求：

- Node.js / pnpm（开发）。
- 推理主机需要 NVIDIA GPU、驱动和 `moss-server` 引擎。
- 远端需要 Linux x86_64、`curl`、`tar` 和 SSH。
- Trainer 需要自己的 Python 3.10+ / Git；GBC 需要外部 `gbc`。

## 快速开始

```bash
pnpm install
pnpm dev
```

开发数据写入仓库根目录的 `.dev-data/`（`projects/`、`models/`、`outputs/`）。

启动后：

1. 打开「引擎」页安装或探测本机 MossInfer；无 Release 时用 CI 构件，需要 GitHub Token。
2. 在「模型」页准备 MOSS-Image 权重组合。
3. 回到「创作」，新建 Project →「新建内容」创建布局 Canvas → 写提示词/拖区域 → 开始生成。
4. 远端：先在「设备」添加 Linux SSH 主机，再在「引擎」安装并准备远端模型。

## 开发验证

```bash
pnpm typecheck          # tsc node + web
pnpm build              # electron-vite build
node --test tools/test-onboarding.mjs
node --test tools/test-download-queue.mjs
```

MossInfer 冒烟（fake sidecar，无需真实 GPU）：

```bash
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-queue
pnpm --filter @clover/desktop exec electron . --scenario=studio-canvas-ui
```

本机无 GPU 的环境下请注意：`project.json` 只接受 `schemaVersion: 3`，旧工程不会被读取（文件仍在磁盘上）。

## 目录

```text
apps/desktop/src/
  main/       Electron 生命周期、双窗口 shell、IPC、领域服务
  preload/    contextBridge 白名单
  renderer/   Studio/管理页面、组件、状态
  backend/    HTTP/WS utility process
  shared/     类型、IPC channel、Zod schema
release/      发布清单、模型表、公告
docs/         架构、状态、设计、迁移、ADR
tools/        测试与维护脚本
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 当前文档、历史文档与阅读顺序 |
| [实现状态](docs/status.md) | 已实现 / 未验收 / 已知限制 |
| [架构](docs/architecture.md) | 双窗口、页面、服务、MossInfer、远端、存储 |
| [产品设计](docs/product-design.md) | 工作台信息架构、画布板交互与边界 |
| [多 Canvas 画布板](docs/design/multi-canvas-studio.md) | 画布板模型、串行生成与结果呈现 |
| [后端与 Project](docs/backend-and-project.md) | Project schema v3、Engine Job、输出 |
| [Layout JSON](docs/layout-schema.md) | 画布坐标与布局编译契约 |
| [MossInfer 迁移](docs/mossinfer-migration.md) | sidecar、远端、HF、CUDA wheel |
| [发布与更新](docs/release-and-updates.md) | Release 流程 |
| [Agent 与提示词](docs/agent-and-prompt.md) | Provider、分段、确认 |
| [GBC 集成](docs/gbc-integration.md) | 可选图像解析桥 |
| [决策记录](docs/decisions/) | ADR 历史依据 |

## 数据与安全

- API Key 与 GitHub Token 只保存在主进程用户数据目录，渲染层只见状态。
- SSH 密码通过系统安全存储保存，不写入 host JSON。
- 模型、引擎路径与用户项目都在本机用户数据目录；LAN Web 访问需要 token。
- 不依赖数据库；持久化为 JSON + 项目/模型/输出文件。

### 兼容性说明

本项目**不为旧数据保留向前兼容**：`project.json` schemaVersion 从 2 升到 3 时删除了 v1→v2 迁移、顶层兼容快照和 `row/column` 网格字段。旧工程目录仍留在磁盘上，但应用不会读取它们。

## 许可

代码采用 MIT License，见 [LICENSE](LICENSE)。MOSS-Image 权重、KohakuGBC/Togeari、KohakuMossTrainer 遵循各自上游许可；本仓库不分发这些模型或外部项目。
