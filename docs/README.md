# MossStudio 文档

本目录描述 **MossStudio 当前实现、设计约束和验收状态**。文档以代码与可重复运行结果为准。

## 事实来源

1. 代码与运行结果：`apps/desktop/`、`release/`、`tools/`
2. [status.md](status.md)：当前完成度、证据、已知限制
3. [architecture.md](architecture.md)：进程、页面、服务、MossInfer、远端、存储
4. [product-design.md](product-design.md)：工作台信息架构与交互边界
5. [mossinfer-migration.md](mossinfer-migration.md)：推理迁移和剩余清理
6. ADR / research / future：决策依据或未来方案，不代表已实现

## 状态标记

| 标记 | 含义 |
| --- | --- |
| ✅ | 已实现，并有本机可重复验证 |
| 🟡 | 代码路径存在，但未在目标硬件/真实数据验收 |
| ⬜ | 未实现或只有设计 |
| 🗄️ | 历史文档/旧链路，仅作背景 |

## 当前文档

| 文档 | 作用 |
| --- | --- |
| [../README.md](../README.md) | 项目总览、安装、快速开始 |
| [mossinfer-performance.md](mossinfer-performance.md) | MossInfer 1.0.0 性能报告与 PyTorch 对比 |
| [status.md](status.md) | 完成度与验证证据 |
| [architecture.md](architecture.md) | 当前进程/窗口/服务/引擎架构 |
| [product-design.md](product-design.md) | 工作台信息架构、画布板、交互边界 |
| [design/multi-canvas-studio.md](design/multi-canvas-studio.md) | Project 多 Canvas 画布板、串行生成与结果呈现（已实现，含 as-built 差异） |
| [mossinfer-migration.md](mossinfer-migration.md) | sidecar、远端、HF、CUDA wheel、旧链路清理 |
| [layout-schema.md](layout-schema.md) | 画布坐标、布局编译契约 |
| [backend-and-project.md](backend-and-project.md) | Project schema v3、Engine Job、HTTP/WS |
| [release-and-updates.md](release-and-updates.md) | 发布与更新流程 |
| [agent-and-prompt.md](agent-and-prompt.md) | AI Provider、分段、确认 |
| [gbc-integration.md](gbc-integration.md) | 可选 GBC 图像解析桥 |
| [toolchain-and-onboarding.md](toolchain-and-onboarding.md) | Trainer/引擎前置条件与首次运行 |
| [windows-validation-guide.md](windows-validation-guide.md) | Windows 实机验收手册 |
| [assets/](assets/) | 历史截图；不再代表当前 UI |
| [decisions/](decisions/) | ADR 决策记录（含 ADR-0009 MossInfer） |

## 历史文档

以下文档记录旧启动器/官方 Gradio/Python runner 时代，不能作为当前实现说明：

- [research/upstream-survey.md](research/upstream-survey.md)
- [research/upstream-2026-10-20.md](research/upstream-2026-10-20.md)
- [future-inference-engine.md](future-inference-engine.md)
- [benchmarks/v2-mnn-spike.md](benchmarks/v2-mnn-spike.md)
- [../runner/README.md](../runner/README.md)
- 旧截图：`home/oobe/instances/terminal/training/creator` 等

## 本机验证环境

| 项 | 值 |
| --- | --- |
| 机器 | Windows 11 x86_64 / RTX 2080（Turing, CC 7.5） / 16 GB |
| MossInfer 本机推理 | ✅ 可运行（需按 tier/attention 配置匹配 Turing） |
| 真实出图 | ✅ 1024² / 8 步 / CFG 3 / 69.2s |
| Linux / 远端 GPU | 未验收 |
| 应用数据 | `.dev-data/`（开发） |

历史环境（原作者开发机）为 Apple M3 / macOS，无法本地推理，因此早期结论多为 🟡；现以 Windows + NVIDIA 实机结果为准。

## 维护规则

1. 先更新 `status.md`，再改 README/公告。
2. 代码存在但未在目标硬件验收，只能标 🟡。
3. 不把旧 Gradio/Instance/runner 写成当前能力。
4. 新增窗口、页面、引擎协议时同步 README、architecture、product-design。
5. ADR 不改历史；决策变化新增 ADR 或修订章节。
