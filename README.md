<p align="center">
  <img src="docs/assets/logo.jpg" alt="MossStudio" width="180">
</p>

<h1 align="center">MossStudio</h1>

<p align="center">
  开源、原生 CUDA、不需要 Python 的 <b>MOSS-Image 桌面工作台</b><br>
  一句话出图 · 可视化布局画布 · 自带推理引擎
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-发布前内测-orange">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D6">
  <br>
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=06181f">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white">
  <img alt="Tailwind" src="https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white">
  <img alt="CUDA" src="https://img.shields.io/badge/CUDA-12.x-76B900?logo=nvidia&logoColor=white">
  <img alt="C++" src="https://img.shields.io/badge/C%2B%2B-20-00599C?logo=cplusplus&logoColor=white">
</p>

---

## 这是什么

MossStudio 是 [MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) 的桌面工作台。它把**模型下载、参数调节、布局画布、AI Agent 和推理引擎**收进同一个窗口，让你不用再和 `git clone`、conda、Gradio 表单打交道。

> 当前处于**发布前最后一轮内部测试**：核心链路已经在真实 NVIDIA 显卡上跑通，安装包和跨机器验收还在收尾。

- 🔒 **完全本地**：图片不出本机，API Key 只存在你自己的用户目录
- 🧩 **开箱即用**：内置模型下载器，自动挑最快的加速源
- 🚀 **自研推理引擎**：[MossInfer](docs/mossinfer-performance.md)，C++/CUDA 原生实现，比 PyTorch 流水线快 1.33–1.45×
- 🪶 **不吃显存**：6–8 GB 显存就能高性能出 1024² 大图，最低 2.34 GiB 也能跑
- 🐍 **不需要 Python**：没有 conda、没有 PyTorch、没有虚拟环境
- 🤖 **一句话出图**：内置 AI Agent（自备 API Key），直接改画布、加图层、发起生成
- 🩺 **报错看得懂**：错误会被翻译成可操作的诊断卡片，而不是一段堆栈

## 亮点

| | |
|---|---|
| **MossInfer 引擎** | 自研 C++/CUDA 推理管线，不依赖 PyTorch。1024² / 50 步只要 27.8 秒（官方 diffusers 流水线 40.2 秒），峰值显存 11.7 GiB |
| **小显存友好** | 按显存预算自动规划驻留层数，装不下的部分流式加载。INT8 档 7.2 GiB、INT4 档 5.0 GiB 即可跑 1024²；2048² 大图峰值仅 16.3 GiB |
| **模型管理** | 27 GB 权重拆成 Dit / Text Encoder / VAE 分开下载、共享 HF 缓存、自由组合，先下哪个由你决定 |
| **自动加速源** | 自动探测并切换 GitHub 代理 / HF 镜像 / 包源，失败了自动回退直连 |
| **布局画布** | Figma 式的自由画布，多张画布平铺；每块画布可按 1024/768/512 比例出图，区域框直接写提示词 |
| **AI Agent** | 支持 OpenAI / DeepSeek / Anthropic / Gemini / Ollama；Agent 通过标准 MCP 风格的工具调用直接操作画布并生成 |
| **诊断** | 环境检查、错误翻译、一键复制诊断信息；同一个错误不会反复弹窗 |

## 引擎性能

数据来自 [MossInfer 1.0.0 性能报告](docs/mossinfer-performance.md)（RTX 5090 32 GB 实测）。

**生成一张 1024² 图（50 步）**

| 运行方式 | 耗时 | 峰值显存 |
| --- | ---: | ---: |
| 官方 diffusers（全量驻留） | 40.2 s | 30.8 GiB |
| 官方 diffusers（顺序 CPU 卸载） | 188.4 s | 3.5 GiB |
| **MossInfer（bf16）** | **27.8 s** | **11.7 GiB** |
| MossInfer（INT8 + 8-bit 注意力） | 13.3 s | 7.2 GiB |
| MossInfer（INT4 Turbo） | 12.7 s | **5.0 GiB** |

**单步推理对比 PyTorch eager**

| 分辨率 | PyTorch | MossInfer | 加速 |
| --- | ---: | ---: | ---: |
| 1024² | 0.620 s | 0.466 s | 1.33× |
| 1456²（长提示词） | 2.016 s | 1.454 s | 1.39× |
| 2048² | 3.746 s | 2.776 s | 1.35× |

其它结论：2048² 大图 143 秒跑完（官方会在 VAE 解码阶段爆显存）；只剩 10.4 GiB 空闲也能跑 2048²，每步只慢 0.3%；重复运行输出**逐位一致**。

## 快速开始

> 需要 NVIDIA 显卡（Windows x64 / Linux x64）与较新的驱动。

```bash
git clone https://github.com/CloverIris/MossStudio.git
cd MossStudio
pnpm install
pnpm dev
```

启动后三步：

1. **引擎** —— 下载并激活 MossInfer（默认挑最匹配你显卡的构建）
2. **模型** —— 选择要下载的权重组件（Dit / Text Encoder / VAE 可分开下）
3. **创作** —— 新建 Project → 写提示词或让 Agent 帮你写 → 开始生成

想用 Agent？在右侧 Agent 面板添加一个 Provider（OpenAI 兼容 / Anthropic / Gemini / Ollama 都行），填上你自己的 API Key。

## 它是怎么搭起来的

```
┌──────────────────────────────────────────────────────────┐
│ Electron 主进程                                           │
│  Studio / Trainer 窗口 · 项目与任务 · 模型与引擎管理        │
│  本地 HTTP/WS 服务（局域网 WebUI）                         │
└───────────────┬──────────────────────────┬───────────────┘
                │ 类型化 IPC                │ stdio JSON-lines
                ▼                          ▼
       React 工作台                  moss-server (MossInfer)
       画布 / 面板 / Agent             C++/CUDA 推理
```

- 渲染层拿不到 Node 能力，只通过白名单 IPC 与主进程通信
- 提示词、布局、参数、任务状态都挂在 Canvas 上，项目存成 JSON + 资源文件，不依赖数据库
- 推理引擎独立进程，协议是 JSON-lines；本机和远程 Linux 主机走同一套协议

## 文档

| 文档 | 内容 |
| --- | --- |
| [MossInfer 性能报告](docs/mossinfer-performance.md) | 引擎实测数据与对比 |
| [实现状态](docs/status.md) | 完成度、验证证据、已知限制 |
| [产品设计](docs/product-design.md) | 工作台信息架构与交互 |
| [架构](docs/architecture.md) | 进程、服务、引擎协议 |
| [后端与 Project](docs/backend-and-project.md) | 项目结构、Engine Job |
| [Layout JSON](docs/layout-schema.md) | 布局编译契约 |
| [文档索引](docs/README.md) | 全部文档与阅读顺序 |

## 开发

```bash
pnpm install
pnpm dev            # electron-vite 开发模式

pnpm typecheck      # tsc（主进程 + 渲染层，两个 tsconfig）
pnpm build          # 生产构建

pnpm test:models         # 模型文件 / 硬链接
pnpm test:model-imports  # 模型导入
pnpm test:ssh-manager    # SSH 主机管理
pnpm test:download-queue # 下载队列
pnpm test:settings-draft # 设置草稿
pnpm test:ui             # Electron UI 检查（需要显示器）
```

## 许可

代码以 [MIT](LICENSE) 发布。MOSS-Image 权重、KohakuGBC/Togeari、KohakuMossTrainer 遵循各自上游许可，本仓库不分发这些模型。
