---
status: current
last-verified: 2026-11-08 (ce189a1)
code: apps/desktop/src/shared/, apps/desktop/src/renderer/src/pages/studio/, apps/desktop/src/renderer/src/components/shell/
---

# Glossary

Proposed path: `docs/reference/glossary.md`.

The terms MossStudio coins or uses in a fixed sense, with the Chinese the UI shows and the identifier the code uses. Docs use these spellings; on first use in an English doc, write the UI term and the code identifier together: 风格 (`kind: 'style'`). Paths are relative to `apps/desktop/src/`. A blank UI column means the UI has no label for the thing; it shows it as a picture or a shape.

## Studio and board

| UI (Chinese) | Code / English | Meaning | Where |
| --- | --- | --- | --- |
| 创作 | Studio, route `/studio` | The page with the node board. The default page. | `renderer/src/components/shell/routes.ts`, `renderer/src/pages/studio/StudioPage.tsx` |
| 主导航 | Rail | The 64 px navigation column on the left: 创作, 作品, 模型, 训练, then 活动 and 设置 at the bottom. Replaced the bottom tabs of ADR-0008. | `renderer/src/components/shell/Rail.tsx` |
| | board, node board | The canvas area where cards sit and are wired together. One board per project. | `renderer/src/pages/studio/Board.tsx`, `boardLayout.ts` |
| 项目 | Project, `ProjectDocument` | A saved board: its canvases, wires and settings. `schemaVersion: 3` is the file format. | `renderer/src/pages/studio/ProjectSwitcher.tsx`, `shared/types.ts` (`ProjectDocument`) |
| | canvas, card | One node on the board. Every node is a `Canvas` with a `kind`. | `shared/types.ts` (`kind: 'layout' \| 'result' \| 'image' \| 'style'`), `renderer/src/pages/studio/CanvasCard.tsx` |
| 画面 | layout canvas, `kind: 'layout'` | The node that describes one picture (description, regions, inputs, sampling) and generates it. | `renderer/src/pages/studio/canvases.ts`, `nodes.ts` |
| 风格 | style node, `kind: 'style'` | A node holding a description and LoRA that every 画面 wired to it generates with, so a series stays consistent. | `renderer/src/pages/studio/nodes.ts` |
| 放大 | upscale | A 画面 with `upscale` set: it redraws a source picture larger. Recipe 放大一张图. | `renderer/src/pages/studio/nodes.ts`, `recipes.ts` |
| | result canvas, `kind: 'result'` | A generated picture. Points back to its 画面 through `sourceCanvasId`. | `renderer/src/pages/studio/runs.ts` |
| 原图 (in messages) | image canvas, `kind: 'image'` | An imported picture used as a source: 起始图, 控制图 or 参考图. | `renderer/src/pages/studio/imageNodes.ts`, `useInputImport.ts` |
| | wire, link | A connection from a source card's output to an input of a 画面. | `renderer/src/pages/studio/wires.ts`, `links.ts`, `WireLayer.tsx` |
| | port | An input or output socket on a card that a wire attaches to. | `renderer/src/pages/studio/ports.ts` |
| | run | One generation of a 画面; a result canvas. Runs that are not pinned live only in the filmstrip. | `renderer/src/pages/studio/runs.ts` |
| | filmstrip | The strip of a 画面's runs under its card. | `renderer/src/pages/studio/Filmstrip.tsx` |
| 改一张图, 局部重绘, 按构图生成, 参考风格, 放大一张图, 一组同风格的图 | recipe | A preset that creates and wires cards for a common task. | `renderer/src/pages/studio/recipes.ts` |
| 区域 | region | A rectangle on a 画面 with its own description; the layout the engine composes from. | `renderer/src/pages/studio/RegionLayer.tsx`, `shared/types.ts` (`layers`), [layout-schema.md](layout-schema.md) |
| 起始图 | init image, role `init` | The picture a 画面 starts from (image to image, inpaint, upscale). | `renderer/src/pages/studio/jobInputs.ts`, `recipes.ts` |
| 遮罩 | mask | The painted area of a 起始图 that is redrawn. Recipe 局部重绘. | `renderer/src/pages/studio/MaskLayer.tsx`, `mask.ts` |
| 控制图 | control image, role `control` | A picture whose depth or edges guide the composition. Needs a 控制适配器. | `renderer/src/pages/studio/recipes.ts`, `shared/types.ts` (`EngineFeatures.control`) |
| 参考图 | reference image, role `reference` | A picture whose look the result follows. | `renderer/src/pages/studio/recipes.ts`, `shared/types.ts` (`EngineFeatures.references`) |
| 高清修复 | hires | A second pass that renders the picture at a larger size. | `shared/types.ts` (`JobHires`, `hires`) |
| 作品 | Library, route `/library` | All generated pictures, for browsing and reuse. | `renderer/src/pages/library/` |
| 活动 | Activity panel, `ActivityTab: 'jobs' \| 'notifications' \| 'problems'` | The panel opened from the Rail that lists jobs, notifications and problems. | `renderer/src/components/shell/ActivityPanel.tsx`, `renderer/src/lib/shell.ts` |
| | assistant | The AI helper inside the Studio, with its provider settings, tools and cards. See [studio-assistant.md](studio-assistant.md). | `renderer/src/pages/studio/assistant/`, `renderer/src/lib/agent/`, `renderer/src/lib/agentTools.ts`, `shared/agent/`, `shared/ai.ts` |

## Engines and devices

| UI (Chinese) | Code / English | Meaning | Where |
| --- | --- | --- | --- |
| 引擎 | engine, MossInfer | The native image engine. The server form is `moss-server`; the CLI forms are below. One engine per device, jobs run in series. | `main/services/mossInfer.ts`, `shared/engineProtocol.ts`, ADR-0009 |
| 引擎包 | `EnginePackage` | One downloadable engine build: `{ kind: 'cuda', flavour, arch, runtime }`, `{ kind: 'vulkan' }` or `{ kind: 'hip' }`. | `shared/enginePackages.ts` |
| 自带运行库 / 系统运行库 | runtime `bundled` / `system-cuda` | Whether a CUDA engine package ships its CUDA libraries or uses the ones on the machine (cuBLASLt). | `shared/enginePackages.ts` (`enginePackageSummary`, `enginePackageOptionLabel`) |
| 兼容模式 | Vulkan CLI engine, `moss-infer-vulkan`, `kind: 'vulkan'` | Text-to-image only, any Vulkan GPU, Windows and Linux. Euler sampler, bf16 bundles only. | `shared/cliEngine.ts` (`CLI_ENGINE_LABEL`) |
| AMD 原生 | HIP CLI engine, `moss-infer-hip`, `kind: 'hip'` | Text-to-image only, AMD through ROCm 7 on Linux. | `shared/cliEngine.ts`, `shared/engineChoice.ts` |
| | CLI engine, `CliEngineKind` | Either one-shot engine above: one job per process; no LoRA, 起始图, 遮罩, 控制, 参考图, 高清修复 or sampler choice. | `shared/cliEngine.ts` (`cliEngineFeatures`) |
| Reference / High / Turbo | tier, `mossInferTier: 'reference' \| 'high' \| 'turbo'` | The quality and speed preset of a MossInfer engine run; the model files decide which tier applies. The UI keeps the English names. | `shared/types.ts` (`Settings.mossInferTier`), `renderer/src/pages/settings/EngineAdvanced.tsx` (`TIER_OPTIONS`) |
| | `EngineFeatures` | What the chosen engine can do (preview, imageInput, control, references, hires, samplers, lora). The Studio hides inputs the engine lacks. | `shared/types.ts`, `renderer/src/pages/studio/useEngineFeatures.ts` |
| 设备与引擎 | devices settings, `/settings/devices` | The settings section that lists GPUs, engines and remote hosts, and installs engine packages. | `renderer/src/pages/settings/sections.ts` |
| 远程主机 | remote host | A Linux machine over SSH that runs the same engine protocol; models download there, pictures come back. | `main/services/remoteEngine.ts`, `shared/types.ts` (`remoteHostsEnabled`) |
| | engine plan, `EnginePlan` | Which packages to install for the GPUs in a machine, with the reason for each step. | `shared/engineChoice.ts` (`chooseEnginePackages`) |
| 安装 | setup, route `/setup` | The full-page first-run flow: location, engine, models. Also the launcher's install mode. | `renderer/src/pages/setup/`, `main/install/`, `apps/launcher/` |

## Models

| UI (Chinese) | Code / English | Meaning | Where |
| --- | --- | --- | --- |
| 模型 | Models page, route `/models` | Download and manage models and the models folder. | `renderer/src/pages/models/ModelsPage.tsx` |
| 模型库 (in messages) | model catalog | The list of models that can be downloaded or are installed. | `shared/types.ts` (`ModelEntry`), `main/services/` model services |
| 模型包 | `ModelBundle` | A complete MOSS-Image set: a DiT, a text encoder and a VAE, bound by a `ModelBinding`. | `shared/types.ts` (`ModelBundle`, `ModelBinding`) |
| 单独的部件 | component file, `ModelEntry.role: 'dit' \| 'text_encoder' \| 'vae' \| 'support'` | One file of a bundle, which can be downloaded or bound on its own. `'full'` is a whole bundle, `'lora'` a LoRA. | `shared/types.ts` (`ModelEntry`), `renderer/src/pages/models/ModelsPage.tsx` |
| | DiT | The diffusion transformer, the main weights of MOSS-Image. Sent to the engine as `dit_file`. | `shared/types.ts` (`role: 'dit'`), `main/services/mossInfer.ts` |
| | precision `bf16`, INT8 and others | The weight precision of a component file, read by the engine's `inspect`; CLI engines accept only bf16. | `main/services/weightPrecision.ts`, `shared/cliEngine.ts` |
| 控制适配器 | control adapter | The model that makes a 控制图 usable; a control port asks for one before it accepts a wire. | `renderer/src/pages/models/ModelsPage.tsx`, `renderer/src/pages/studio/ports.ts` |
| LoRA | LoRA, `role: 'lora'` | A small add-on model applied through a 风格 node. 训练 produces them. | `shared/types.ts`, `renderer/src/pages/studio/nodes.ts` |
| 模型文件夹 | models root, `modelsRoot` | The folder models are stored in; ComfyUI layouts are recognised in place. | `renderer/src/pages/models/ModelsPage.tsx`, `shared/types.ts` (`Settings.modelsRoot`) |
| 训练 | Training, route `/training`, Trainer window | LoRA training through the external Trainer, behind the `trainingEnabled` feature. | `renderer/src/pages/training/`, `renderer/src/pages/TrainerWindow.tsx`, ADR-0002 |
