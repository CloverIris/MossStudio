# MossStudio 0.1.0 — 首个正式版本

MossStudio 是面向 MOSS-Image 的桌面创作工作台。它将画布创作、模型管理和本机推理整合在一个应用中；推理由 MossInfer 引擎执行。

## 主要功能

- **Canvas 创作**：多画布项目、图层与区域提示词、生成任务状态和结果管理。
- **模型管理**：浏览和准备模型组件、检查本地模型，并在项目中选择模型组合。
- **MossInfer 引擎管理**：检查、安装和管理本机推理引擎版本。
- **本机图像生成**：在支持的 NVIDIA 环境中运行 MOSS-Image 生成任务。
- **Agent 与工具**：集成提示词辅助、画廊、诊断、设置及 Trainer 工作流。
- **更新与公告**：获取发布公告；更新包经完整性校验后再解压和替换应用文件。

## 下载与安装

本版本提供 **Windows x64 便携 ZIP**，暂不提供安装向导。下载并解压后运行 `MossStudio.exe`。请将应用放在当前用户可写的目录中；应用数据保存在用户数据目录，不应与程序文件混放。

在「引擎」页安装 MossInfer，在「模型」页准备所需模型，然后即可在 Canvas 中创建并生成图像。本机推理需要兼容的 Windows x64 环境、NVIDIA GPU 和驱动；模型与推理引擎需另行下载。

## 从 0.0.0 升级

已安装 `0.0.0` 基线版本的用户可使用应用内更新检查升级至 `0.1.0`。应用会校验下载包大小和 SHA-256，再安全解压并替换程序文件。更新过程需要关闭应用，安装目录必须对当前用户可写；项目数据目录会保留。

## 已知事项

- 当前正式发布资产仅适用于 Windows x64；尚未提供 macOS、Linux 或签名安装程序。
- 本机推理依赖兼容的 NVIDIA GPU、驱动、引擎和模型；首次使用需先完成准备。
- Linux SSH 远端功能仍需在真实 GPU 主机环境中进一步验收。
- Windows 程序尚未签名，首次启动时系统可能显示安全提示。

## 发布与更新（维护者）

- 这是 MossStudio 0.1.0 的拟发布正文草稿；在构建产物并上传到 GitHub Release 前，版本尚未正式发布。
- 发布前在 Windows x64 运行 `pnpm release:build`，确认 `release/artifacts/` 中的 ZIP、`release.md` 与本正文一致。
- 创建非预发布的 `v0.1.0` Release 并设为 latest；上传 ZIP 与 `release.md` 作为附件资产。打开 `release/artifacts/README.md`，复制全文粘贴到 GitHub Release 正文框；不要只上传 README 附件。
- ZIP 下载地址由 `release.md` 记录，资产文件名必须保持 `MossStudio-0.1.0-win32-x64.zip`；元数据附件必须精确命名为 `release.md`。
- 不要使用此前构建的哈希或大小；构建命令会根据新 ZIP 更新 `release/manifest.json` 和 `release/release.md`。
