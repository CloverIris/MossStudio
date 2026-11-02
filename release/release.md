# MossStudio 1.0.2

> 本文件由 `node tools/release-md.mjs` 从 `release/manifest.json` 与
> `release/models.json` 生成；请勿直接手改。发布时把本文件作为 GitHub Release
> 的 `release.md` 资产上传。

- 通道：**stable**
- 发布：2026-11-02T02:00:00Z
- 最低版本：0.0.0
- 模型目录：2026-11-02T02:52:00Z · `sha256:d23effcfe7d7…`

## 安装包

- `win32/x64` · zip · 204 MB · `9fa562f2e92c…`

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

### MossStudio 1.0.2：LoRA 与统一引擎就绪

> info · 2026-11-02T02:00:00Z

本版为 Canvas 加入 LoRA：每张画布独立选择权重、调整强度，并可直接导入本地 safetensors。MossInfer 引擎改用统一就绪状态与原子安装，安装失败不再污染版本列表。客户端会自己发现新版本：标题栏出现版本胶囊，公告与更新进入通知中心。

## 发布说明

MossStudio 是面向 MOSS-Image 的桌面创作工作台。它将画布创作、模型管理和本机推理整合在一个应用中；推理由 MossInfer 引擎执行。

## 本次更新

- **Canvas LoRA**：每张画布可单独选择 LoRA 权重、调节强度，并可直接导入本地 `.safetensors`。权重缺失或远端引擎不支持时会明确提示，不会静默丢弃。
- **统一的引擎就绪状态**：下载、CUDA 库处理、引擎探测和兼容性判断都在暂存目录完成，检查通过的构建才进入版本列表；替换当前版本失败会回滚，设置只在成功后更新。
- **兼容性以引擎为准**：引擎返回的 `supported` 是唯一权威，算力只用于选包、展示和警告，不再按显卡名称推断而误拒绝新显卡。
- **客户端主动发现更新**：启动后按固定间隔检查，窗口重新获得焦点时也会补查；发现新版本时标题栏出现版本胶囊，并弹出更新对话框。
- **公告与通知**：置顶公告进入通知中心，未读数显示在铃铛角标上；打开通知面板后自动标记已读。
- **模型库新增社区 LoRA**：人像美化（Beauty）、去色带（Destripe）、Turbo MFD 少步、4-step 蒸馏，共 4 个适配器，可在 Canvas 的 LoRA 行直接下载选用。
- 保留 1.0.1 的修复：Windows 应用内更新在解压 `resources/app.asar` 时不再失败。

## 主要功能

- **Canvas 创作**：多画布项目、图层与区域提示词、生成任务状态和结果管理。
- **LoRA 适配**：按 Canvas 绑定权重与强度，训练产物与本地导入的权重统一管理。
- **模型管理**：浏览和准备模型组件、检查本地模型，并在项目中选择模型组合。
- **MossInfer 引擎管理**：检查、安装和管理本机推理引擎版本；安装失败不会留下半成品版本。
- **本机图像生成**：在支持的 NVIDIA 环境中运行 MOSS-Image 生成任务。
- **Agent 与工具**：集成提示词辅助、画廊、诊断、设置及 Trainer 工作流。
- **更新与公告**：自动检查发布公告与更新；更新包经大小和 SHA-256 校验后再解压和替换应用文件。

## 下载与安装

本版本提供 **Windows x64 便携 ZIP**，暂不提供安装向导。下载并解压后运行 `MossStudio.exe`。请将应用放在当前用户可写的目录中；应用数据保存在用户数据目录，不应与程序文件混放。

在「引擎」页安装 MossInfer，在「模型」页准备所需模型，然后即可在 Canvas 中创建并生成图像。本机推理需要兼容的 Windows x64 环境、NVIDIA GPU 和驱动；模型与推理引擎需另行下载。

## 从旧版本升级

已安装 `0.1.0`、`1.0.0` 或 `1.0.1` 的用户可使用应用内更新检查升级至 `1.0.2`。应用会校验下载包大小和 SHA-256，再安全解压并替换程序文件。更新过程需要关闭应用，安装目录必须对当前用户可写；项目数据目录会保留。

## 已知事项

- 当前正式发布资产仅适用于 Windows x64；尚未提供 macOS、Linux 或签名安装程序。
- 本机推理依赖兼容的 NVIDIA GPU、驱动、引擎和模型；首次使用需先完成准备。
- 远端引擎暂不支持 LoRA：选择远端引擎时提交会给出明确提示。
- Linux SSH 远端功能仍需在真实 GPU 主机环境中进一步验收。
- Windows 程序尚未签名，首次启动时系统可能显示安全提示。

```json clover-release
{
  "schema_version": 2,
  "app": {
    "name": "MossStudio",
    "channel": "stable",
    "version": "1.0.2",
    "min_supported": "0.0.0",
    "published_at": "2026-11-02T02:00:00Z",
    "notes_url": "https://github.com/CloverIris/MossStudio/releases/tag/1.0.2"
  },
  "installers": [
    {
      "platform": "win32",
      "arch": "x64",
      "kind": "zip",
      "url": "https://github.com/CloverIris/MossStudio/releases/download/1.0.2/MossStudio-1.0.2-win32-x64.zip",
      "sha256": "9fa562f2e92cd0311f9077c68c024532ad64d3f9156c6fe9821e718eb68762d5",
      "size_bytes": 213810033
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
      "id": "2026-11-mossstudio-1.0.2",
      "level": "info",
      "title": "MossStudio 1.0.2：LoRA 与统一引擎就绪",
      "body_markdown": "本版为 Canvas 加入 LoRA：每张画布独立选择权重、调整强度，并可直接导入本地 safetensors。MossInfer 引擎改用统一就绪状态与原子安装，安装失败不再污染版本列表。客户端会自己发现新版本：标题栏出现版本胶囊，公告与更新进入通知中心。",
      "starts_at": "2026-11-02T02:00:00Z",
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
