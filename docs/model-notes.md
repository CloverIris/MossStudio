# 模型事实与数值约定

> 所有数字来自公开 checkpoint 的 config/index 与上游代码，标注了来源。
> 预算表由 `python3 tools/dev/budget.py --markdown` 生成。

## 1. 组件

| 组件 | 实现 | 参数 | bf16 | 关键结构 |
| --- | --- | ---: | ---: | --- |
| DiT | `MOSSImageTransformer` | 5.082 B | 10.16 GB | 42 层 single-stream，dim 3072，FFN 8192，24 头 |
| 文本编码器 | `Qwen3_5Model` | 8.393 B | 16.79 GB | 32 层：24 linear attention + 8 full，hidden 4096 |
| VAE | `AutoencoderKLFlux2` | ~0.125 B | 0.25 GB | 32 latent ch，8× 空间，2×2 patch → 16× |
| 调度器 | `MOSSImageScheduler` | — | — | Euler，shift 5，1000 步训练网格 |

来源：
[transformer/config.json](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/transformer/config.json)、
[text_encoder/config.json](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/text_encoder/config.json)、
[vae/config.json](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/vae/config.json)、
两个 `*.index.json` 的 `metadata.total_size`。

注意 VAE 配置里 `latent_channels: 32`，而 DiT 的 `latent_channels: 128`：
二者不矛盾，**128 = 32 × 2 × 2 patchify**。DiT 的 H/W 是像素 /16。

## 2. DiT 结构（逐项核实）

- `video_embedder`：Linear 128 → 3072，每个 /16 网格点一个 token；
- `text_embedder`：Linear 4096 → 3072 + 2 个 `_TextBlock`（fused qkv、qk-norm、
  RoPE、SiTU FFN、**无** modulation）；
- `time_embedding`：sinusoid(256) → Linear → SiLU → Linear（fp32 权重）；
- `shared_block_modulation`：**一个** Linear 3072 → 6×3072，42 层共用；
- `layers.0..41`：joint block，序列 = `[image tokens ; text tokens]`；
  RMSNorm + modulation → q/k/v → per-head qk RMSNorm + 4 轴 RoPE → attention →
  gated residual → RMSNorm + modulation → `ffn_up_gate`（前半 up，后半 gate）→
  SiTU → `ffn_down` → gated residual；
- `final_norm_video` + `video_head_modulation` + `final_linear_video`（3072 → 128）；
- 输出是 **flow velocity**：`v = noise - x0`，sigma ∈ [0,1]，1 为纯噪声。

**SiTU**：`(4·tanh(g/4)·sigmoid(g)) · (25·tanh(u/25))`，无参数，可分解为
sigmoid/tanh/mul，MNN 直接支持。

**RoPE（4 轴）**：坐标 `(r, f, h, w)`，图像 token 的 `r=0`、`f=text_len`、
`h,w` 居中（减 `(size-1)/2`）；文本 token 的 `f=position`、其它为 0。
频带数 = `head_dim/8` = **16**；每个坐标 16 个频率 → `sin/cos` 拼成 32，
四轴共 128 = head_dim。**在 host 侧预计算**，作为图输入，避免图内动态三角与网格生成。

## 3. 序列长度与算力

| 分辨率 | image tokens | seq（text 256） | 单次前向 |
| --- | ---: | ---: | ---: |
| 512² | 1024 | 1280 | 13.9 TF |
| 768² | 2304 | 2560 | 29.4 TF |
| 1024² | 4096 | 4352 | 54.0 TF |
| 1280×768 | 3840 | 4096 | 50.3 TF |
| 1024×1376 | 5504 | 5760 | 75.7 TF |

注意 attention 占比随分辨率平方增长：1024² 时占总算力 18%，1376² 时 23%。
Flash/分块 attention 是 1024² 以上的必选项。

端到端（含 TE 与 VAE）：

| 设备 | 512² 50步 | 512² 8步 | 1024² 50步 | 1024² 8步 |
| --- | ---: | ---: | ---: | ---: |
| M4 Max 40c（实测校准） | 90 s | 8 s | 5.8 min | 29 s |
| M1 Max 24c（实测校准） | 4.3 min | 22 s | 16.8 min | 83 s |
| M3 10c（估算） | 8.8 min | 45 s | 34.3 min | 2.8 min |
| RTX 4090（估算） | 25 s | 2 s | 1.6 min | 8 s |

校准点：M4 Max + MLX，1024²/50 步/CFG3/bf16 = **358 s**（mlx-serve PR #908）。
该结果反推有效算力 ≈ 15.3 TFLOP/s，与预算模型一致。

## 4. 内存

| 档位 | TE | DiT | VAE | 常驻权重 |
| --- | --- | --- | --- | ---: |
| 8 GB | int4 | int4 + block 流式 | int8 | ~7.0 GB |
| 16 GB | int4 | int8 | int8 | ~9.8 GB |
| 24 GB | int8 | int8 | int8 | ~13.6 GB |
| 48 GB+ | bf16 | bf16 | bf16 | ~27.5 GB |

**分阶段是硬要求**：TE 编码完即可卸载，再加载 DiT；解码前再卸 DiT。
16 GB 机器上三件套同时常驻（bf16 = 27.2 GB）必然 swap。

## 5. 采样器

### base（官方）

```
sigma grid: lower = shift/(1000+shift-1)
values = linspace(1, lower, N)
sigmas = shift*values / (1 + (shift-1)*values)
再吸附到 1000 步训练网格的最近点，去重
```

- 默认 50 步、CFG 3、`shift=5`；
- 负分支 **跳过 block 22**（不是少算 CFG，而是用 skip 预测替代负分支预测，
  仍保持 2 次前向）；
- CFG 合并必须在 **fp32** 做（上游注释明确）；
- 初始噪声 fp32 采样，不能"先 bf16 再提升"。

### dmd8（社区蒸馏，可选档）

[lodestones/MOSS-Image-SFT-8-steps-dmd](https://huggingface.co/lodestones/MOSS-Image-SFT-8-steps-dmd)
（Apache-2.0）：data-space DMD，8 次前向、无 CFG、fp32。

```python
Q, codes = load("dataspace.safetensors")      # Q: [128,128], codes: [8]
z = randn(1,128,H//16,W//16, fp32); x0 = zeros_like(z)
for r in range(8):
    x = z + einsum("oc,bchw->bohw", Q, x0)
    v = dit(x, codes[r], embeds, mask)        # fp32
    x0 = z - v
decode(x0)
```

配套 `time_embedding.safetensors` 是**替换**（含 `shared_block_modulation.bias`、
`video_head_modulation.bias`），必须 fp32；`lora.safetensors` 是 rank 128 的
delta。三者缺一不可。

## 6. 数值约定（必须照抄，否则画质漂移）

| 位置 | 精度 | 原因 |
| --- | --- | --- |
| timestep sinusoid | fp64 计算 → fp32 | 上游训练如此 |
| time_embedding / modulation | fp32 权重与输出 | 小模块，误差会被 42 层放大 |
| CFG 合并 | fp32 | 上游注释：只转最终速度会保留舍入误差 |
| 初始 latent | fp32 | bf16 噪声无法恢复精度 |
| VAE | fp32（上游 `force_upcast`） | 解码对精度敏感；我们先用 fp16 + 分块，做 LPIPS 对照 |
| DMD | 全 fp32 | 蒸馏 delta 小于 bf16 舍入 |

## 7. 权重布局

| 来源 | 键 | 处理 |
| --- | --- | --- |
| HF diffusers `transformer/` | `layers.N.proj.q.weight` … | 直接映射 |
| ComfyUI 单文件 | 无前缀或 `model.diffusion_model.` | 去前缀；`proj.qkv` 拆 q/k/v |
| Comfy-Org repack | fused qkv | 拆分后加载 |
| KohakuMoss 单文件 | 裸键 | 可直接读（格式公开） |

`rope.bands` 是派生 buffer，可忽略重算。

## 8. 已知坑

1. **VAE 内存**：1024² 不分块会 OOM（实测 25.5 GiB 中间激活）；
2. **文本编码器**：`encode_prompt` 对每条 prompt 单独前向，padding 会污染
   Qwen GDN 的线性注意力状态——引擎必须按真实长度分桶，不能整批 padding；
3. **batch**：上游按样本循环做 DiT（每个样本用自己的 text mask），
   批量生成时不要简单 stack；
4. **CFG + skip**：skip 只在 `slg_start..slg_stop` 区间生效，默认全区间；
5. **分辨率**：必须是 16 的倍数，否则直接报错（上游如此）。

## 9. 社区 FP16-fixed（KBlueLeaf）

来源：[KBlueLeaf/MOSS-Image-FP16-fixed](https://huggingface.co/KBlueLeaf/MOSS-Image-FP16-fixed)，
Apache-2.0，commit `a880990b7fc9d2052f32fa9a1527f524b6847e83`（2026-10-19）。

### 9.1 它是什么

- **只替换 transformer**：Base 和 SFT 的 DiT 权重各自提供；文本编码器、tokenizer、
  VAE、scheduler 和 pipeline 代码仍使用官方组件；
- 官方权重的 residual stream 最大约 61–62k，接近 fp16 上限 65.5k（约 1.05× 余量）；
  修复版把 stream 在权重里按 `c = 1/16` 缩放，同一位置的余量约 16.9×；
- 缩放是 2 的幂，fp32/bf16 下精确；RMSNorm 的 `eps` 仍保持官方值，diffusers/
  ComfyUI 可直接加载；
- 模型卡称它是“same outputs as the official model up to rounding”，并在自己的
  测试里比官方 bf16 更接近 fp32；这不是“所有场景绝对精度更高”的证明。

### 9.2 文件与大小

| 内容 | 路径 | 大小 |
| --- | --- | ---: |
| Base transformer（diffusers，3 shards + config/index） | `base/transformer/` | 10.16 GB |
| SFT transformer（diffusers） | `sft/transformer/` | 10.16 GB |
| Base ComfyUI 单文件 | `comfyui/moss_image_base_fp16_fixed.safetensors` | 10.16 GB |
| SFT ComfyUI 单文件 | `comfyui/moss_image_sft_fp16_fixed.safetensors` | 10.16 GB |

完整仓库约 40.7 GB（两套 diffusers + 两套 ComfyUI + 报告/图）。启动器目录把它拆成
四个 `role: dit` 条目：Base/SFT 的 diffusers transformer，以及 Base/SFT 的 ComfyUI
单文件；每个条目只下载自己需要的文件，约 10.16 GB。diffusers 条目下载后仍需官方
完整 pipeline 的 TE/VAE/tokenizer。

### 9.3 使用

diffusers：先加载官方 pipeline，把 transformer 替换为修复版权重：

```python
import importlib
import torch
from diffusers import DiffusionPipeline

pipe = DiffusionPipeline.from_pretrained(
    "OpenMOSS-Team/MOSS-Image-Base",  # or MOSS-Image-SFT
    custom_pipeline="pipeline_moss_image",
    trust_remote_code=True,
    transformer=None,
    torch_dtype=torch.float16,
)
pipe.scheduler = type(pipe.scheduler).from_config(pipe.scheduler.config)
MOSSImageTransformer = importlib.import_module(type(pipe).__module__).MOSSImageTransformer
pipe.transformer = MOSSImageTransformer.from_pretrained(
    "KBlueLeaf/MOSS-Image-FP16-fixed",
    subfolder="base/transformer",  # or sft/transformer
    torch_dtype=torch.float16,
)
pipe.to("cuda")
```

ComfyUI：把对应 `comfyui/*.safetensors` 放进 `models/diffusion_models/`，搭配
Comfy-Org 的 Qwen3.5 文本编码器与 Flux2 VAE；启动参数必须带 `--fp16-unet`，
否则 ComfyUI 会按 bf16/fp32 处理。

KohakuMoss：`PRECISION=fp16`，`WEIGHTS`/`TRANSFORMER` 指向对应文件；也支持
`FP16_FIX=online` 在加载官方权重时折叠。

### 9.4 质量与硬件注意

- 模型卡报告（RTX 5090，1024²/50 步/CFG3，对各自 fp32 参考）：
  - ComfyUI Base：fp16-fixed LPIPS **0.0062** / PSNR **44.8 dB**；官方 bf16
    0.0501 / 29.3 dB；SFT 0.0042 / 43.2 dB；
  - diffusers Base：0.0111 / 42.8 dB；官方 bf16 0.0900 / 26.8 dB；
  - 这些是作者测试数据，不是本项目复现结果。
- 社区反馈 2080 Ti / V100 可直接用 fp16，不需要特殊处理；本机没有这些卡，
  **未验收**。
- 只替换 transformer；如果 LoRA/LoKr 作用在 `video_embedder`、`text_embedder` 或
  `shared_block_modulation`，delta 需要按同一 `c` 缩放；常规 q/k/v/o/FFN 适配器
  可以直接迁移。
- 需要官方完整模型的 TE/VAE/tokenizer；不要把它当完整 pipeline 单独启动。

### 9.5 目录条目

| id | precision | role | 下载路径 |
| --- | --- | --- | --- |
| `moss-base-fp16-fixed` | fp16 | dit | `base/transformer/*` |
| `moss-sft-fp16-fixed` | fp16 | dit | `sft/transformer/*` |
| `moss-base-fp16-fixed-comfy` | fp16 | dit | `comfyui/moss_image_base_fp16_fixed.safetensors` |
| `moss-sft-fp16-fixed-comfy` | fp16 | dit | `comfyui/moss_image_sft_fp16_fixed.safetensors` |

四个条目共享同一个 HF repo 缓存；下载其中一个不会拉取其他变体。删除其中一个只
移除该变体的完成标记，不删除其他变体的文件。
