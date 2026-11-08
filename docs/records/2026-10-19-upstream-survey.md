# 上游生态扫描（2026-10-19）

> 目的：确认技术可行性、避免重复造轮子、明确哪些能复用（许可）、哪些只能对照。
>
> 本文是 2026-10-19 的立项调研，不是实现清单；当前完成度以 [../status.md](../archive/status.md) 为准。

## 1. 官方

| 项目 | 许可 | 可用性 |
| --- | --- | --- |
| [OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) | Apache-2.0 | 参考实现（diffusers pipeline），**模型结构与数值的权威来源** |
| [MOSS-Image-Base / SFT](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base) | Apache-2.0 | 权重，27.2 GB bf16 |
| ComfyUI 插件（仓库内 `comfyui/`） | Apache-2.0 | 原生 PyTorch 实现，**键位映射的最佳参考** |

官方仓库本身只有薄薄一层 `inference_runtime.py`（84 行），真正模型代码在 HF 的
`pipeline_moss_image.py` 里（440 行，含 DiT/scheduler/pipeline）。

## 2. Apple 平台实现（可对照，不直接拷贝）

| 项目 | 许可 | 价值 | 实测 |
| --- | --- | --- | --- |
| [ddalcu/mlx-serve PR #908](https://github.com/ddalcu/mlx-serve/pull/908) | MIT | Zig + MLX 的完整 MOSS 实现、8-bit 打包、权重转换脚本、fixture 对拍 | M4 Max 128 GB，1024²/50/CFG3：bf16 **358 s**（32.9 GB），8-bit **403 s**（21.0 GB） |
| [xocialize/moss-image-swift](https://github.com/xocialize/moss-image-swift) | MIT | Swift/MLX 包，原生 App 集成 | M1 Max 64 GB：50 步 1024² ≈ **1028 s**；8 步 DMD ≈ 128 s |
| [mlx-community/MOSS-Image-SFT-bf16](https://huggingface.co/mlx-community) | — | 转换后的 bf16 权重 | 27 GB |

关键结论：**MLX 在 Apple Silicon 上已经验证可行**，且性能数据可作为我们的预算校准点；
但 MLX 不覆盖移动端/Windows，故只作快路径备选（见 ADR-0001）。

## 3. 蒸馏与量化生态

| 产物 | 许可 | 说明 |
| --- | --- | --- |
| [lodestones/MOSS-Image-SFT-8-steps-dmd](https://huggingface.co/lodestones/MOSS-Image-SFT-8-steps-dmd) | Apache-2.0 | data-space DMD，8 步、CFG 1、fp32；需自定义采样器 + time embedding 替换 |
| [lodestones/MOSS-Image-Base-8-steps-dmd](https://huggingface.co/lodestones/MOSS-Image-Base-8-steps-dmd) | Apache-2.0 | Base 版 |
| [akhaliq/MOSS-Image-SFT-4-steps](https://huggingface.co/akhaliq/MOSS-Image-SFT-4-steps) | — | 4 步 |
| [darask0/MOSS-Image_4-step_adapter_lora](https://huggingface.co/darask0/MOSS-Image_4-step_adapter_lora) | — | LoRA 形态；mlx-serve 指出仍需独立采样器 |
| [Abiray/MOSS-Image-SFT-INT8-convrot](https://huggingface.co/Abiray/MOSS-Image-SFT-INT8-convrot)、[toxicdog INT4](https://huggingface.co/toxicdog/MOSS-Image-SFT-INT4-ConvRot-ComfyUI)、[tsolful GPTQ](https://huggingface.co/tsolful/MOSS_Image_INT6_INT4GPTQ) | — | 社区量化包，可用于对照量化质量 |
| [realrebelai/MOSS-Image_GGUFs](https://huggingface.co/realrebelai/MOSS-Image_GGUFs)、[gguf-org](https://huggingface.co/gguf-org/moss-image-gguf) | — | GGUF 生态，说明端侧需求真实存在 |

**产品含义**：few-step 是 macOS 可用的前提（50 步在 M3 上 30+ 分钟）；
启动器必须把 DMD 当成一等 profile，而不是"普通 LoRA + 改步数"。

## 4. 运行时

| 项目 | 许可 | 与我们的关系 |
| --- | --- | --- |
| [alibaba/MNN](https://github.com/alibaba/MNN) | Apache-2.0 | 主引擎；Qwen3.5 + MetalLinearAttention + diffusion 运行时 |
| [MNN diffusion 文档](https://mnn-docs.readthedocs.io/en/latest/transformers/diffusion.html) | — | 转换/编译/`transformerFuse` 流程 |
| [zimage-mnn](https://pypi.org/project/zimage-mnn/)（PyPI） | — | 社区把 Z-Image（DiT）搬到 MNN 的先例 |
| [mlx](https://github.com/ml-explore/mlx) | MIT | Apple 快路径备选 |
| [KohakuMossTrainer](https://github.com/KohakuBlueleaf/KohakuMossTrainer) | KohakuMoss License 1.0 | 训练后端，外部进程接入（ADR-0002） |

## 5. 我们相对上游的增量

**V1（启动器）**

1. **统一入口**：环境体检、实例、运行时、权重、LoRA、运行、诊断在一个小窗里；WebUI 是后续项；
2. **版本可复现**：实例 pin 到 commit，回滚秒级，导出不含权重；
3. **日志翻译**：tqdm/报错变成阶段进度与可点击的解决方案，而不是终端滚屏；
4. **双 WebUI（后续）**：启动器自身浏览器模式 + 官方 Gradio；当前只有官方 Gradio 代码路径；
5. **可运营**：`release/` 清单可改推荐 commit、镜像、公告，不用发版。

**V2（引擎，见 ADR-0003）**

6. **不依赖 torch 的 C++ 运行时**；
7. **逐 block 调度**，让 8–16 GB 设备可用；
8. **可验证的数值基线**：逐层 parity + 端到端 LPIPS；
9. **训练/推理解耦**：训练器可选、外部、不污染主仓库。

## 6. 需要持续跟踪

- 官方是否发布 img2img/edit / 更小的模型 / 官方蒸馏；
- MNN 对 Qwen3.5 hidden states 的支持（决定 TE 路线 A/B）；
- MNN Metal 对 dynamic shape + flash attention 的进展；
- 社区 DMD/4-step 适配器的采样器差异（每出现一种新 profile 都要单独实现采样循环）。
