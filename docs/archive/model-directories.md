# 模型目录 v2：识别、就地使用、入口前移

- 状态：实现中（扫描 / 登记 / 惰性目录 / 模型页入口已落地；组件文件绑定待做）
- 影响：`apps/desktop/src/main/lib/paths.ts`、`services/models.ts`、`services/modelImports.ts`、`services/modelBundles.ts`、`services/mossInfer.ts`、`pages/Models.tsx`、`pages/Settings.tsx`

## 1. 用户报告

> 用户已经在 ComfyUI 里装好了 27 GB 的全套 MOSS-Image；装 MossStudio 后不想重复下载。在设置里把模型目录指过去之后：软件不识别这些模型，还在 ComfyUI 里留了一堆空文件夹；刷新模型页什么都没有；而且模型路径为什么藏在设置页深处。

## 2. 根因（对应代码）

| 现象 | 根因 |
| --- | --- |
| 选了目录也不识别 | 设置里的 `modelDirectories` 只是**下载写入目标**，不扫描、不登记。识别只认安装记录（`.clover-<id>.json`/`refs`），用户已有的文件不在任何记录里。 |
| ComfyUI 目录出现空文件夹 | `ensureDirs()` 每次启动/保存设置都为每个角色创建 `<目录>/hf/hub`（`paths.ts` 的 `roleHub`，调用点 `index.ts:142`、`ipc.ts:381`）。 |
| 导入后也生成不了 | `导入本地模型` 只登记成 `format: 'comfyui'` 的目录条目；`ModelBinding` 只能引用 HF 组件（`prepareModelBundle` → `componentSnapshot`），导入的 `diffusion_models/*.safetensors` 没有路径能进 `startEngineJob`。 |
| 刷新没反应 | 设置保存没有广播模型变更事件；模型页只有自己的 `refreshCatalog()`。 |
| 入口太深 | 目录配置只在 设置 → 存储与画廊；模型页只有"导入本地模型"按钮。 |

## 3. 目标

1. 模型页拥有"模型目录"：选完目录立即扫描并列出发现的东西，不需要重启。
2. 扫描/登记**绝不写用户目录**；只有真正下载时才在目标目录建子目录。
3. ComfyUI 的 27 GB 文件可以**就地**参与生成，不复制、不移动。
4. 所有模型相关状态（目录、发现数量、导入结果）在模型页可见，刷新即时。

## 4. 设计

### 4.1 懒创建目录

- 启动只保证 `data/` 根存在。
- `roleHub`/`adapters`/`modelImports` 等目录在**第一次写入**（下载、导入索引）时才创建。
- 删除 `ensureDirs` 中对自定义目录的创建；默认目录也改为按需。
- 新增"清理空闲目录"动作：只删除**空**目录，且只在 `data/` 或用户明确选择的目录下执行，删除前列清单确认。

### 4.2 扫描与登记

新增 IPC：`models:scan({ root, roles? })` → 返回候选，不写盘：

```ts
interface ScannedModel {
  path: string
  relativePath: string
  size: number
  mtimeMs: number
  role: 'dit' | 'text_encoder' | 'vae' | 'lora' | 'unknown'
  layout: 'diffusers-folder' | 'comfyui-single-file'
  confidence: 'high' | 'medium' | 'low'
  hint: string          // 命中的目录/文件名规则
}
```

识别规则：

- 目录：`diffusion_models`/`unet`/`checkpoints` → dit；`text_encoders`/`clip` → text_encoder；`vae` → vae；`loras` → lora；`transformer+text_encoder+vae+model_index.json` 同目录 → diffusers 文件夹。
- 文件名：`moss_image_*`、`*moss*sft*`、`*qwen3.5*`、`*flux2*vae*` 等已知模式提高置信度。
- 单文件 `.safetensors` 只有在目录规则或文件名规则命中时才给 `high`；否则 `low`，让用户手动指定角色。

`models:register-scan({ items })`：只写导入索引（`models/imports/index.json`），记录 size/mtime 而不做全量 SHA-256；哈希在首次使用或用户点"校验"时做（27 GB 全量哈希太慢，是现在导入卡住的另一个原因）。

### 4.3 组件文件绑定（关键）

`ModelBinding` 增加文件模式，生成链路直接把这些路径传给引擎：

```ts
type ModelBinding =
  | { bundleId: string; dit: string; textEncoder: string; vae: string }      // 现有 HF 组合
  | { bundleId: 'local'; ditPath: string; textEncoderPath?: string; vaePath?: string } // 本地单文件
```

- `mossInfer.ts` 的 `load` 请求从只发 `model` 改为可发 `model + dit_file/text_encoder_file/vae_file`（引擎 2.0+ 的 `model_files` 能力，`hello` 的 `capabilities` 里可检测）。
- 若只有部分文件（例如用户只有 ComfyUI 的 DiT，缺 text encoder/VAE），UI 明确提示缺哪个，并允许从 Comfy-Org 补一个组件，而不是静默失败。
- Studio 的模型下拉增加"本地文件组合"分组，列出扫描发现的可用组合。

### 4.4 模型页布局

```
┌ 模型目录 ─────────────────────────────────────────────┐
│ 主目录   D:\AI\ComfyUI\models        [更改] [打开]     │
│ 识别到   12 个模型文件 · DiT 4 · 文本编码器 3 · VAE 2 · LoRA 3 │
│ [重新扫描] [从 ComfyUI 导入…] [清理空闲目录]            │
│ 高级：分别指定 DiT / 文本编码器 / VAE / Adapters 目录   │
└──────────────────────────────────────────────────────┘
```

- 设置 → 存储与画廊 里只保留"打开数据目录"和一个"到模型页管理"的链接。
- 扫描结果用列表呈现（路径、大小、角色、置信度、可勾选），确认后才登记；登记后立即出现在模型列表顶部"本地文件"分组。

### 4.5 刷新与错误

- 新增 `Events.modelsChanged`；扫描、登记、目录变更、删除后广播，模型页与 Studio 都订阅。
- `getCatalog` 的 key 已包含 `modelDirectories`，但需要 `force` 才能重建；事件触发时强制刷新。
- 扫描失败（权限、路径不存在、文件被占用）在卡片内显示原因，不再只弹 toast。

## 5. 兼容与迁移

- 已有的导入记录（`schema_version: 1`）继续可读；新增 `hashed: boolean` 字段，旧记录视为已哈希。
- 默认目录布局（`data/models/{moss,text-encoder,vae,support}`）不变；旧的自定义目录继续作为下载目标。
- 旧版本创建的空 `hf/hub` 目录：提供"清理空闲目录"，不自动删。

## 6. 分阶段

- **1.0.3**：懒创建、模型页目录卡片、扫描/登记、`modelsChanged` 刷新、组件文件绑定（单文件 DiT/文本编码器/VAE 可直接生成）、清理空目录。
- **1.0.4**：diffusers 文件夹整体导入、校验哈希与重建索引、缺失组件的一键补齐。

## 7. 验证

- 单元：扫描器对 ComfyUI 目录样例的角色识别、只读目录不写入、注册后 catalog 条目出现。
- 场景：`--scenario=model-management` 扩展为"扫描 ComfyUI 目录 → 绑定 → 假引擎收到 `dit_file` 等字段"。
- UI：模型页目录卡片、扫描结果列表、空目录清理确认、刷新后列表更新（`pnpm test:ui`）。
- 真机：用真实 27 GB ComfyUI 目录验收"零复制生成"。
