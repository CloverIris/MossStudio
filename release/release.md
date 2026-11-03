# MossStudio 1.0.3

> 本文件由 `node tools/release-md.mjs` 从 `release/manifest.json` 与
> `release/models.json` 生成；请勿直接手改。发布时把本文件作为 GitHub Release
> 的 `release.md` 资产上传。

- 通道：**stable**
- 发布：2026-11-03T03:30:00Z
- 最低版本：0.0.0
- 模型目录：2026-11-02T02:52:00Z · `sha256:d23effcfe7d7…`

## 安装包

- `win32/x64` · zip · 204 MB · `4b0e64a282ef…`
- `win32/x64` · exe · 251 MB · `7dd7338be908…`

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
| `moss-runtime-config` | MossInfer 运行配置与分词器 | `OpenMOSS-Team/MOSS-Image-SFT` | support | mixed | 19 MB | Apache-2.0 | `shared` |
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
| `lora-beauty` | Beauty LoRA（人像美化，社区） | `axiomofmind/Moss-image-beauty-lora` | lora | moss-sft | 71 MB | Apache-2.0 | `pytorch_lora_weights.safetensors` |
| `lora-destripe` | Destripe 去色带（社区） | `nynxz/MOSS-Image` | lora | moss-sft | 2 MB | Apache-2.0 | `loras/moss_sft_destripe_top64_bf16.safetensors` |
| `lora-turbo-mfd` | Turbo MFD 少步（社区） | `congruency/MOSS-Image-Turbo-MFD` | lora | moss-sft | 72 MB | Apache-2.0 | `MOSS-Image-SFT-Turbo-MFD-v0.1.comfy.safetensors` |
| `lora-4step` | 4-step 蒸馏 LoRA（社区） | `akhaliq/MOSS-Image-SFT-4-steps` | lora | moss-sft | 1.2 GB | Apache-2.0 | `lora.safetensors` |

## 公告

### MossStudio 1.0.3：安装器与模型目录重构

> info · 2026-11-03T03:30:00Z

1.0.3 改用单文件自解压安装器：安装、按版本原地更新和卸载都由安装器完成，更新失败会回滚并保留日志。模型目录移到模型页，可以直接扫描已有的 ComfyUI 目录并登记使用，不复制权重，也不会在你的目录里新建空文件夹。

## 发布说明

MossStudio 是面向 MOSS-Image 的桌面创作工作台。它将画布创作、模型管理和本机推理整合在一个应用中；推理由 MossInfer 引擎执行。

## 本次更新

- **单文件自解压安装器**：`MossStudio-Setup-1.0.3-x64.exe` 集安装、原地更新与卸载于一体。更新由安装器接管：等待旧进程退出、备份程序文件、覆盖解压、失败自动回滚并写日志，成功后重新启动应用；不再依赖 PowerShell，也不会把解压产物留在磁盘上。
- **安装记录与卸载**：安装时写入 HKCU 卸载项、桌面与开始菜单快捷方式；卸载默认保留 `data/`（模型、引擎与项目），需要彻底删除时可显式选择。
- **模型目录移到模型页**：模型页顶部直接管理根目录与按角色覆盖的目录（DiT / 文本编码器 / VAE / Adapters / 运行配置），不用再去设置页深处找。
- **识别已有模型（ComfyUI）**：只读扫描已有目录（按 `diffusion_models`、`text_encoders`、`vae`、`loras` 和文件名识别角色），勾选后登记为本地模型；不复制、不移动、不哈希原文件，删记录也不会删文件。
- **不再在用户目录里建空文件夹**：模型目录改为惰性创建，只有真正下载或导入写入时才建子目录；旧版本留下的空 `hf/hub` 可在模型页「清理空目录」删除。
- 保留 1.0.2 的能力：Canvas LoRA（每张画布独立权重与强度）、社区 LoRA 目录、统一引擎就绪状态与主动更新提示。

## 主要功能

- **Canvas 创作**：多画布项目、图层与区域提示词、生成任务状态和结果管理。
- **LoRA 适配**：按 Canvas 绑定权重与强度，训练产物与本地导入的权重统一管理。
- **模型管理**：浏览和准备模型组件、扫描并登记已有模型、在项目中选择模型组合。
- **MossInfer 引擎管理**：检查、安装和管理本机推理引擎版本；安装失败不会留下半成品版本。
- **本机图像生成**：在支持的 NVIDIA 环境中运行 MOSS-Image 生成任务。
- **Agent 与工具**：集成提示词辅助、画廊、诊断、设置及 Trainer 工作流。
- **更新与公告**：自动检查发布公告与更新；安装器负责校验、替换与重启，失败可回滚。

## 下载与安装

本版本提供 **Windows x64 单文件安装器** `MossStudio-Setup-1.0.3-x64.exe`，同时保留 **便携 ZIP**。安装器可以选择安装目录并创建快捷方式；便携 ZIP 解压后直接运行 `MossStudio.exe`，应用数据保存在程序旁的 `data/`。

首次启动后在「引擎」页安装 MossInfer，在「模型」页准备或识别所需模型，然后即可在 Canvas 中创建并生成图像。本机推理需要兼容的 Windows x64 环境、NVIDIA GPU 和驱动；模型与推理引擎需另行下载。

## 从旧版本升级

1.0.1 及更早版本的内置更新链路在“替换文件并重启”这一步不可靠，因此 **1.0.2 及更早的安装请手动下载一次 `MossStudio-Setup-1.0.3-x64.exe`**：安装器检测到已有程序目录时按“更新”处理，保留 `data/`，不需要先卸载。从 1.0.3 起，应用内更新会下载安装器并把替换工作交给它，失败会回滚。

## 已知事项

- 当前正式发布资产仅适用于 Windows x64；尚未提供 macOS、Linux 或签名安装程序。
- 本机推理依赖兼容的 NVIDIA GPU、驱动、引擎和模型；首次使用需先完成准备。
- 远端引擎暂不支持 LoRA：选择远端引擎时提交会给出明确提示。
- Linux SSH 远端功能仍需在真实 GPU 主机环境中进一步验收。
- Windows 程序与安装器尚未签名，首次启动时系统可能显示安全提示。

```json clover-release
{
  "schema_version": 2,
  "app": {
    "name": "MossStudio",
    "channel": "stable",
    "version": "1.0.3",
    "min_supported": "0.0.0",
    "published_at": "2026-11-03T03:30:00Z",
    "notes_url": "https://github.com/CloverIris/MossStudio/releases/tag/1.0.3"
  },
  "installers": [
    {
      "platform": "win32",
      "arch": "x64",
      "kind": "zip",
      "url": "https://github.com/CloverIris/MossStudio/releases/download/1.0.3/MossStudio-1.0.3-win32-x64.zip",
      "sha256": "4b0e64a282ef24d7b6f0867a4c11cb54694c29567de0823231cae993e89d23c1",
      "size_bytes": 213819589
    },
    {
      "platform": "win32",
      "arch": "x64",
      "kind": "exe",
      "url": "https://github.com/CloverIris/MossStudio/releases/download/1.0.3/MossStudio-Setup-1.0.3-x64.exe",
      "sha256": "7dd7338be908aab10ae71f09625c19fbbbb578ab233af1dc7e63c1b35f5fbc86",
      "size_bytes": 262940496
    }
  ],
  "home": {
    "chapter": "万象初绘",
    "title": "一念落纸上，万象入画来。",
    "subtitle": "在 MossStudio 创作，引擎与模型在管理页准备。"
  },
  "catalog": {
    "updated_at": "2026-11-02T02:52:00Z",
    "models_url": "https://raw.githubusercontent.com/CloverIris/MossStudio/main/release/models.json",
    "models_sha256": "d23effcfe7d7103e6424a0261a9ffd715ad9e57f275cbc55e779cf5a3e204719"
  },
  "announcements": [
    {
      "id": "2026-11-mossstudio-1.0.3",
      "level": "info",
      "title": "MossStudio 1.0.3：安装器与模型目录重构",
      "body_markdown": "1.0.3 改用单文件自解压安装器：安装、按版本原地更新和卸载都由安装器完成，更新失败会回滚并保留日志。模型目录移到模型页，可以直接扫描已有的 ComfyUI 目录并登记使用，不复制权重，也不会在你的目录里新建空文件夹。",
      "starts_at": "2026-11-03T03:30:00Z",
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
