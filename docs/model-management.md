# 模型组件管理

模型库使用 `apps/desktop/resources/models.json`（schema 3）。`models` 描述独立下载组件，`bundles` 描述 Diffusers 文件夹组合，`single_file_bundles` 描述单文件组合。一个本地组合引用 DiT、文本编码器、VAE 和隐藏的配置组件；Qwen 组件同时包含 tokenizer。

模型页的「推荐模型」列出 MossInfer 引擎认证的全部模型（`certified: true`，以引擎 `docs/integration.md` 的 Supported models 为准）：官方 SFT、Base，以及单文件的 SFT · INT8、SFT · NVFP4、SFT · INT4、SFT Turbo · INT8 8 步、Base · INT8。最适合这台电脑的一个放在最前：RTX 50 用 NVFP4，显存不到 16 GB 用 INT8，否则用官方 SFT；判断的是自动分配会优先用的那块显卡（跑完整引擎的优先，再按架构新、显存大排序），用兼容模式引擎的显卡只推荐官方模型（`shared/bundleFit.ts`）。引擎没验证过的 FP16-fixed 社区版放在「其他模型」。

单文件组合 = 引擎认证的 DiT 文件 + INT8 文本编码器文件 + FLUX.2 small VAE 文件 + `moss-runtime-config`（约 20 MB 的配置与 tokenizer）。生成时 `moss-runtime-config` 物化为引擎的 `model` 文件夹，三个文件作为 `dit_file` / `text_encoder_file` / `vae_file` 传入；扫描登记的本地文件组合（`local-files`）同样如此。组合自带 `tier`（INT8 为 `high`，INT4 / NVFP4 为 `turbo`），覆盖设置里的档位；`requires` 限定显卡（NVFP4 只在算力 12.0 的 RTX 50 上运行，自动分配显卡时会等能跑它的那块）；INT8 和 INT4 在 Turing、Volta 上也能跑（引擎的 SM75 / SM70 构建）；扫描登记的本地文件组合按主模型的精度或文件名推断档位；`defaults` 是少步模型在创作页被选中时套用的步数与 CFG。单文件组合只能在这台电脑上运行，远程主机用它的模型文件夹；兼容模式与 AMD 原生引擎只读 bf16 文件夹，也不能用。

单文件组件钉在引擎测试过的提交上；更新前从 `main` 下载的同一组件仍算已下载，不会重新下载（`installMatchesRevision`）。单文件组合放在独立的 `single_file_bundles` 里，旧版本应用只读 `bundles`，拿到新目录也不会列出它们跑不了的组合；新版本拿到 schema 2 的旧目录时，补上内置的单文件组合和它们需要的组件。

`adapters` 是可挂在 Canvas 上的 LoRA：8-step DMD 两档由专用采样档驱动，其余为普通 LoRA（人像美化 Beauty、去色带 Destripe、Turbo MFD 少步、4-step 蒸馏）。后 4 个的格式都在上游 MossInfer 开发期验证过可加载（kohya / PEFT），少步 LoRA 记得把步数与 CFG 调到各自说明的档位。

## 模型目录（v2，1.0.3 起）

- 模型页顶部的「模型目录」卡片管理根目录和按角色覆盖的目录（DiT / 文本编码器 / VAE / Adapters / 运行配置），不再需要到设置页深处找。
- 「识别已有模型」是只读扫描：按 ComfyUI 布局（`diffusion_models`、`text_encoders`、`vae`、`loras`）和文件名推断角色，列出候选后由用户勾选登记。扫描不写入、不复制、不哈希；登记只写 `models/imports/index.json`，记录 size + mtime，删记录也不会删除原文件。
- 目录是**惰性创建**的：只有真正写入（下载、导入）时才在目标目录建子目录。旧版本在自定义目录里留下的空 `hf/hub` 可以用卡片上的「清理空目录」删除，它只会删空目录。
- 设置 → 存储与画廊 仍保留目录入口，但模型页是主要入口；两边改的是同一份 `settings.modelDirectories`。

## 安装与缓存

- 保留 HF `blobs` / `snapshots` / `refs` 布局，指定 revision 先解析到实际提交，文件树支持分页。
- 默认数据目录位于打包应用可执行文件旁的 `data/`；模型默认根目录为 `data/models/`。DiT、文本编码器、VAE、辅助组件和 Adapters 可在设置中分别指定目录，留空时使用模型根目录下的分类目录。
- 既有统一 HF 缓存继续参与安装状态识别和 blob 复用；新组件按角色写入分类缓存，不要求用户手动迁移旧权重。
- 模型、Adapter 与引擎下载开始前均按实际目标磁盘检查可用空间；模型空间需求包含未完成下载余量，检测不到磁盘信息时不伪报空间不足。
- 最多同时传输三个文件；相同 blob 串行校验及写入。续传必须收到匹配的 Content-Range；服务器返回 200 时重新写入。
- 下载先写 `.part`，长度及 LFS SHA256 校验成功后才提交。`.clover-<id>.json` 记录完整清单，`.pending` 保留未完成安装的所有权记录。
- 安装新组合前，在已有 HF 仓库缓存中查找相同 hash 的 blob，校验后复用。旧完整缓存无需移动；点击“补齐组件”即可登记与补齐，避免重新传输已有权重。
- Windows 使用文件硬链接，不依赖符号链接权限；不能硬链接时复制，并检查额外磁盘空间。
- “已就绪”取决于安装记录、文件大小、配置及索引分片，不以仓库目录存在作为依据。
- 删除阻止实例绑定和运行任务中的组件。先移除受影响的受管组合目录，再清理无共享引用的受管文件。外部缓存、未知旧记录以及其他 revision 的快照会保守保留。
- “导入本地模型”可选择 ComfyUI 等框架的模型目录，按 SHA256 登记支持的权重文件；只保存原文件引用，不复制、移动或删除源文件。重复内容只登记一次，按常见目录名识别 DiT、文本编码器和 VAE。移走源文件后会显示不可用，可重新导入新路径。
- 下载 HF 组件时会校验已导入文件的 SHA256；若匹配 LFS 文件哈希，则复制到受管缓存并跳过网络下载。导入文件本身仅作为 ComfyUI 单文件资源，不能绑定到本地官方 Gradio。

## 绑定与加载

`models:install-bundle` 接收 `{id}`，返回本次所需的组件下载任务；`instances:model-binding` 接收 `{id, binding}`，其中 binding 为 `{bundleId, dit, textEncoder, vae}` 或 null。旧下载与暂停接口保持可用。

新本地实例默认绑定 SFT；旧实例没有绑定时继续沿用原配置。实例详情可以保存未下载的兼容组件，但启动前必须补齐。显式选择“自定义 HF ID 或本地目录”优先于实例绑定。SSH 仍走原启动流程，不接受本地组件绑定。

组合在 `models/bundles/<content-key>/` 原子生成标准本地目录；`clover_model.json` 固定实际组件提交及精度。Gradio 通过启动器自有脚本运行原始 `gradio_app.py`，与 runner 共用 `model_runtime.py`。不修改上游实例源码。

官方 DiT/Qwen 使用 BF16，FP16-fixed DiT 使用 FP16，VAE 使用 FP32。受管组合强制本地加载，缺失文件在启动前报错；不会后台补下整仓。

## 验证

```powershell
node --test tests/model-files.test.mjs
python -m unittest discover -s docs/archive/runner/tests
```

构建后，从 `apps/desktop` 运行 `electron . --scenario=model-management`，使用轻量本地 HTTP 夹具检查组合安装、共享、损坏修复、旧 blob 复用及删除保护，不下载真实权重。

`electron . --scenario=model-management-ui --screenshot` 使用隔离的临时数据目录，检查三种窗口尺寸、125%/150% 缩放、组件分类、删除保护、实例绑定和下载状态。可通过 `CLOVER_MODEL_TEST_OUTPUT` 指定截图目录。

真实模型及 CUDA 出图需要另行验收；模拟加载测试不能替代生成质量与显存验证。
