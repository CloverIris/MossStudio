# MossStudio 0.1.0

> 本文件由 `node tools/release-md.mjs` 从 `release/manifest.json` 与
> `release/models.json` 生成；请勿直接手改。发布时把本文件作为 GitHub Release
> 的 `release.md` 资产上传。

- 通道：**stable**
- 发布：2026-11-01T06:18:00Z
- 最低版本：0.0.0
- 模型目录：2026-10-19T09:48:26Z · `sha256:64e4f5552209…`

## 安装包

- `win32/x64` · zip · 204 MB · `2f6c74e18457…`

## 模型目录

| ID | 名称 | 仓库 | 角色 | 精度 | 大小 | 许可 | 标签 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `moss-sft-dit` | MOSS-Image SFT | `OpenMOSS-Team/MOSS-Image-SFT` | dit | bf16 | 10.2 GB | Apache-2.0 | `official` `sft` |
| `moss-base-dit` | MOSS-Image Base | `OpenMOSS-Team/MOSS-Image-Base` | dit | bf16 | 10.2 GB | Apache-2.0 | `official` `base` |
| `moss-base-fp16-fixed` | MOSS-Image Base FP16-fixed (社区) | `KBlueLeaf/MOSS-Image-FP16-fixed` | dit | fp16 | 10.2 GB | Apache-2.0 | `community` `fp16` `fixed` `base` `diffusers` `2080ti` `v100` |
| `moss-sft-fp16-fixed` | MOSS-Image SFT FP16-fixed (社区) | `KBlueLeaf/MOSS-Image-FP16-fixed` | dit | fp16 | 10.2 GB | Apache-2.0 | `community` `fp16` `fixed` `sft` `diffusers` `2080ti` `v100` |
| `moss-base-fp16-fixed-comfy` | MOSS-Image Base FP16-fixed · ComfyUI (社区) | `KBlueLeaf/MOSS-Image-FP16-fixed` | dit | fp16 | 10.2 GB | Apache-2.0 | `community` `fp16` `fixed` `base` `comfyui` `2080ti` `v100` |
| `moss-sft-fp16-fixed-comfy` | MOSS-Image SFT FP16-fixed · ComfyUI (社区) | `KBlueLeaf/MOSS-Image-FP16-fixed` | dit | fp16 | 10.2 GB | Apache-2.0 | `community` `fp16` `fixed` `sft` `comfyui` `2080ti` `v100` |
| `qwen35-encoder` | Qwen3.5 · 文本编码器 | `OpenMOSS-Team/MOSS-Image-SFT` | text_encoder | bf16 | 16.8 GB | Apache-2.0 | `official` `shared` |
| `flux2-vae-small` | FLUX.2 VAE · Small | `OpenMOSS-Team/MOSS-Image-SFT` | vae | fp32 | 238 MB | Apache-2.0 | `official` `shared` |
| `moss-pipeline` | MOSS Pipeline | `OpenMOSS-Team/MOSS-Image-SFT` | support | mixed | 0 MB | Apache-2.0 |  |
| `moss-base-comfy-bf16` | MOSS BASE · BF16 | `Comfy-Org/MOSS-Image` | dit | bf16 | 10.2 GB | Apache-2.0 | `comfyui` |
| `moss-base-comfy-int8_convrot` | MOSS BASE · INT8_CONVROT | `Comfy-Org/MOSS-Image` | dit | int8 | 5.4 GB | Apache-2.0 | `comfyui` |
| `moss-sft-comfy-bf16` | MOSS SFT · BF16 | `Comfy-Org/MOSS-Image` | dit | bf16 | 10.2 GB | Apache-2.0 | `comfyui` |
| `moss-sft-comfy-int8_convrot` | MOSS SFT · INT8_CONVROT | `Comfy-Org/MOSS-Image` | dit | int8 | 5.4 GB | Apache-2.0 | `comfyui` |
| `qwen35-comfy-bf16` | Qwen3.5 · BF16 | `Comfy-Org/MOSS-Image` | text_encoder | bf16 | 19.3 GB | Apache-2.0 | `comfyui` |
| `qwen35-comfy-int8_convrot` | Qwen3.5 · INT8_CONVROT | `Comfy-Org/MOSS-Image` | text_encoder | int8 | 9.7 GB | Apache-2.0 | `comfyui` |
| `qwen35-comfy-w4a8_gptq` | Qwen3.5 · W4A8_GPTQ | `Comfy-Org/MOSS-Image` | text_encoder | w4a8 | 7.3 GB | Apache-2.0 | `comfyui` |
| `flux2-vae-comfy-small` | FLUX.2 VAE · Small | `Comfy-Org/MOSS-Image` | vae | fp32 | 238 MB | Apache-2.0 | `comfyui` |
| `flux2-vae-comfy-full` | FLUX.2 VAE · Full | `Comfy-Org/MOSS-Image` | vae | fp32 | 321 MB | Apache-2.0 | `comfyui` |

## 适配器

| ID | 名称 | 仓库 | 类型 | 基座 | 大小 | 许可 | 文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dmd8-sft` | 8-step DMD (SFT) | `lodestones/MOSS-Image-SFT-8-steps-dmd` | dmd | moss-sft | 1.3 GB | Apache-2.0 | `lora.safetensors` `time_embedding.safetensors` `dataspace.safetensors` |
| `dmd8-base` | 8-step DMD (Base) | `lodestones/MOSS-Image-Base-8-steps-dmd` | dmd | moss-base | 1.3 GB | Apache-2.0 | `lora.safetensors` `time_embedding.safetensors` `dataspace.safetensors` |

## 公告

### MossStudio 0.1.0 正式发布

> info · 2026-11-01T06:18:00Z

MossStudio 首个正式版本现已发布。Windows x64 用户可下载便携 ZIP；安装并启动 0.0.0 基线版本的用户也可通过应用内更新升级至 0.1.0。更新前请保留项目数据目录；应用会先校验下载文件，再安全解压并替换程序文件。

## 发布说明

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

```json clover-release
{
  "schema_version": 2,
  "app": {
    "name": "MossStudio",
    "channel": "stable",
    "version": "0.1.0",
    "min_supported": "0.0.0",
    "published_at": "2026-11-01T06:18:00Z",
    "notes_url": "https://github.com/CloverIris/MossStudio/releases/tag/v0.1.0"
  },
  "installers": [
    {
      "platform": "win32",
      "arch": "x64",
      "kind": "zip",
      "url": "https://github.com/CloverIris/MossStudio/releases/download/v0.1.0/MossStudio-0.1.0-win32-x64.zip",
      "sha256": "2f6c74e18457bc9cf1c00c0d19643c90528203d241fc3fa4961add4833f56608",
      "size_bytes": 213773605
    }
  ],
  "home": {
    "chapter": "万象初绘",
    "title": "一念落纸上，万象入画来。",
    "subtitle": "在 MossStudio 创作，引擎与模型在管理页准备。"
  },
  "catalog": {
    "updated_at": "2026-10-19T09:48:26Z",
    "models_url": "https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/models.json",
    "models_sha256": "64e4f555220903f6e967053087cd62735d8b87b9b86e6e1ab1ee3e326cbd9706"
  },
  "announcements": [
    {
      "id": "2026-11-mossstudio-0.1.0",
      "level": "info",
      "title": "MossStudio 0.1.0 正式发布",
      "body_markdown": "MossStudio 首个正式版本现已发布。Windows x64 用户可下载便携 ZIP；安装并启动 0.0.0 基线版本的用户也可通过应用内更新升级至 0.1.0。更新前请保留项目数据目录；应用会先校验下载文件，再安全解压并替换程序文件。",
      "starts_at": "2026-11-01T06:18:00Z",
      "ends_at": null,
      "dismissible": true,
      "pinned": true,
      "action": {
        "label": "查看更新",
        "kind": "check_update"
      }
    }
  ]
}
```
