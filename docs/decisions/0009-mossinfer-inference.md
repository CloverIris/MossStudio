---
status: accepted
date: 2026-10-23
amended-by: ADR-0012
---

# ADR-0009：MossInfer 作为唯一推理引擎


## 决策

1. 推理统一走 `moss-server` sidecar；MossStudio 不再 clone 官方 MOSS-Image 仓库，不再为推理创建 Python runtime/Instance。
2. 引擎以 Windows/Linux x86_64 + NVIDIA 为目标；macOS 不提供本地推理。
3. 一个 engine 一个 `moss-server`，任务串行；Job 使用模型 + 引擎/设备，不绑定 Instance。
4. 引擎包分 `system-cuda`（默认，依赖系统 cuBLASLt）和 `bundled`（+700MB，自带 CUDA 库）。
5. 下载前预检系统 cuBLASLt；缺失时由用户选择 bundled，或下载 system 包并用原生 NVIDIA wheel 解压补库，不调用 Python/uv/pip。
6. Linux SSH 远端使用同一 sidecar 协议；模型在远端下载，输出回传本地。
7. 旧推理数据首次启动归档到 `legacy-inference-*`；旧 Project `instanceId` 忽略。
8. Trainer 保留自己的 Python/Git 环境；GBC 保持可选外部工具。

## 后果

- 推理链路显著简化，但引擎/模型/驱动成为新的运行时依赖。
- 真实 Windows/Linux NVIDIA、远端 host 和安装包仍需实机验收。
- 旧 `instances/git/runtimes/runner` 文件尚待彻底删除。
