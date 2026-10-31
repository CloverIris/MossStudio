# MossStudio

**MOSS-Image 的桌面创作工作台。**

MossStudio 用 Electron + React 把提示词、布局画布、图层、模型、Agent 和生成任务放在一个工作区里；推理通过 **MossInfer sidecar** 执行，桌面端不再依赖官方 Gradio、官方 MOSS-Image 仓库或推理 Python 环境。

> 当前版本 `0.1.0`，开发阶段。真实 NVIDIA 出图、Windows 安装包和远端 GPU 仍以实机验收结果为准，详见 [实现状态](docs/status.md)。

## 特性

- **三列创作工作区**：左侧提示词/生成参数/图库，中间画布与生成工具条，右侧图层/布局/Agent。
- **可调整布局**：左右栏宽度、卡片高度、浮动面板尺寸均可拖动；左右栏可收起为边轨。
- **直接编辑画布区域**：每个区域框内置提示词编辑，支持文字、人物、物体区域。
- **画布交互**：滚轮以鼠标焦点缩放、手型/中键平移、比例/重置工具。
- **画布 tabs**：可拖动排序、显示名称与保存状态；未保存草稿切页不丢失。
- **MossInfer 引擎**：本机 Windows/Linux NVIDIA；系统 cuBLASLt 预检，缺库可下载 bundled 包或用原生 wheel 解压补库。
- **Linux SSH 远端引擎**：远端安装引擎、下载 HF 权重、SSH sidecar 出图并回传。
- **模型库**：组件化模型、共享 HF 缓存、推荐组合、本地导入。
- **Agent**：多 Provider、对话历史、提示词分段/确认、润色/翻译/拆段。
- **GBC（可选）**：KohakuGBC/Togeari 图像图解析桥，把 bbox/描述导入画布；外部 Python 工具，不参与核心启动。
- **Trainer**：独立窗口；训练侧的 Python/Git 检测与运行时保留在 Trainer 范围。
- **底部页面导航**：创作、引擎、模型、设备、训练、画廊、诊断、设置。

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
        bottom page tabs                  │
        canvas / panels / Agent           ├─ local
        Project / Gallery / Models        └─ Linux SSH host
```

- **Studio** 是主窗口，包含创作页和底部页面导航。
- **Trainer** 是唯一独立保留的第二窗口。
- 推理算法在 `moss-server` 内；MossStudio 只负责 `hello / load / generate / cancel`、事件和输出。
- 任务不再绑定 Instance；模型和引擎是分开的选择。
- 旧推理数据首次启动归档到 `legacy-inference-*`。

## 平台与依赖

| 目标 | 状态 |
| --- | --- |
| Windows x86_64 + NVIDIA | 代码路径已接；安装包/实机待验收 |
| Linux x86_64 + NVIDIA | 本机与 SSH 远端代码路径已接；实机待验收 |
| macOS | UI/管理/项目可用；**无 MossInfer 本地推理** |

运行要求：

- Node.js / pnpm（开发）。
- 推理主机需要 NVIDIA GPU、驱动，以及 `moss-server` 引擎。
- 远端需要 Linux x86_64、`curl`、`tar` 和 SSH。
- Trainer 需要自己的 Python 3.10+ / Git；GBC 需要外部 `gbc` 和相应 Python 环境。

## 快速开始

```bash
pnpm install
pnpm dev
```

开发数据写入仓库根目录的 `.dev-data/`。

首次启动可开启配置引导。点击清单中的「前往配置」后，清单会停靠到右下角并跟随实际准备状态更新；也可以跳过，之后从标题栏的清单按钮重新开启。

启动后：

1. 打开底部「引擎」页。
2. 本机安装引擎：上游暂无 Release 时使用最新 CI artifact，需要 GitHub Token；默认检查系统 `cuBLASLt`，缺库可选 bundled 或原生 CUDA wheel。
3. 在「模型」页准备 MOSS-Image 权重。
4. 回到「创作」，选择模型/引擎/设备，写提示词并开始生成。
5. 远端：先在「设备」添加 Linux SSH 主机，配置 `engineRoot`、`outputRoot`，在「引擎」安装/检测并准备远端模型。

## 开发验证

```bash
pnpm typecheck
pnpm build
pnpm test:ui
node --test tools/test-onboarding.mjs
node --test tools/test-managed-python.mjs
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --smoke
```

MossInfer 冒烟（fake sidecar，无需真实 GPU）：

```bash
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-engine-job
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-remote-job
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=mossinfer-queue
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=project-canvases
env -u ELECTRON_RUN_AS_NODE pnpm --filter @clover/desktop exec electron . --scenario=studio-canvas-ui
```

## 目录

```text
apps/desktop/src/
  main/       Electron 生命周期、two-window shell、IPC、领域服务
  preload/    contextBridge 白名单
  renderer/   Studio/管理页面、组件、状态
  backend/    HTTP/WS utility process
  shared/     类型、IPC channel、Zod schema
runner/       历史 Python runner（旧推理路径，迁移中）
release/      发布清单、模型表、公告
docs/         架构、状态、设计、迁移、ADR
tools/        测试与维护脚本
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 当前文档、历史文档与阅读顺序 |
| [实现状态](docs/status.md) | 已实现/未验收/已知限制 |
| [架构](docs/architecture.md) | 双窗口、页面、服务、MossInfer、远端、存储 |
| [产品设计](docs/product-design.md) | 工作台布局、交互与边界 |
| [MossInfer 迁移](docs/mossinfer-migration.md) | sidecar、远端、HF、CUDA wheel 与旧链路清理 |
| [Layout JSON](docs/layout-schema.md) | 画布坐标与编译规范 |
| [后端与 Project](docs/backend-and-project.md) | HTTP/WS、Project、输出 |
| [发布与更新](docs/release-and-updates.md) | Release 流程 |
| [Agent 与提示词](docs/agent-and-prompt.md) | Provider、分段、确认 |
| [GBC 集成](docs/gbc-integration.md) | 可选图像图解析桥 |
| [决策记录](docs/decisions/) | ADR 历史依据 |

## 数据与安全

- API Key 只保存在主进程用户数据目录，渲染层只见 `hasKey`。
- SSH 密码通过系统安全存储保存，不写入 host JSON。
- 模型/引擎路径和用户项目都在本机用户数据目录；LAN Web 访问需要 token。
- 不依赖数据库；持久化为 JSON + 项目/模型/输出文件。

## 许可

代码采用 MIT License，见 [LICENSE](LICENSE)。MOSS-Image 权重、KohakuGBC/Togeari、KohakuMossTrainer 遵循各自上游许可；本仓库不分发这些模型或外部项目。
