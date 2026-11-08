---
status: current
last-verified: 2026-11-08 (d0883df)
code: apps/desktop/resources/models.json, apps/desktop/src/shared/types.ts, apps/desktop/src/shared/bundleFit.ts, apps/desktop/src/shared/localBundle.ts, apps/desktop/src/shared/adapters.ts, apps/desktop/src/main/lib/paths.ts, apps/desktop/src/main/services/models.ts, apps/desktop/src/main/services/modelBundles.ts, apps/desktop/src/main/services/modelScan.ts, apps/desktop/src/main/services/modelImports.ts, apps/desktop/src/main/services/modelFiles.ts, apps/desktop/src/main/services/controlAdapters.ts, apps/desktop/src/main/services/weightPrecision.ts, apps/desktop/src/renderer/src/pages/models/, apps/desktop/src/renderer/src/components/ModelDirectoriesCard.tsx
---

# Models

How MossStudio describes, downloads, finds and hands model files to the engine: the catalog of components and bundles, the models root, files used in place from a folder the person already has, LoRA and control adapters, and the 模型 page. A job loads one file set, either a prepared diffusers folder or three component files, never a mix.

Paths in this doc are relative to `apps/desktop/src/` unless they start with `apps/`, `docs/` or `tools/`. Engine-side facts (what `load` and `inspect` accept) live in the [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp); the engine packages and tiers are in [`engines.md`](/docs/reference/engines.md).

## 1. Catalog, components and bundles

The catalog is the list of everything the app can download or has found. Its schema is the set of types in [`shared/types.ts`](/apps/desktop/src/shared/types.ts): `ModelEntry` (one component), `AdapterEntry` (one LoRA), `ModelBundle` (a complete set), `ModelBinding` (the set a job runs with) and `Catalog`. The doc does not restate them.

| Term | Code | Meaning |
| --- | --- | --- |
| component, 部件 | `ModelEntry.role` | One downloadable or registered unit: `dit` 主模型, `text_encoder` 文本编码器, `vae` VAE, `support` (config files, never chosen by hand), `full` (a whole registered folder). `ModelEntry.choice` is the label 自己组合 shows (`MOSS-Image SFT · INT8`); a folder and a single file of the same weights share one. |
| combination, 我的组合 | `ModelCombination`, `ModelBundle.custom` | A 主模型, 文本编码器 and VAE the person saved in 自己组合 (section 7). It is a bundle in the catalog like the others. |
| bundle, 模型包 | `ModelBundle` | A DiT, a text encoder and a VAE (`components`) plus a `support` entry with the pipeline and scheduler configs. The 模型 page calls a bundle a "model". |
| binding | `ModelBinding` | A bundle id with its three component ids, built by `bundleBinding()` in `main/services/modelBundles.ts`. This is what a job carries. |
| format | `ModelEntry.format` | `diffusers` (a folder with `config.json` per part) or `comfyui` (one `.safetensors` file). |
| precision | `ModelEntry.precision` | `bf16`, `fp16`, `fp32`, `int8`, `w4a8`, `mixed`; `local` for a scanned file until the engine reports it. |

Where the catalog comes from (`getCatalog` in `main/services/models.ts`):

1. `apps/desktop/resources/models.json` is packaged with the app (`source: 'builtin'`).
2. On each full refresh the app fetches the same file from the manifest mirror the network probe picked (GitHub raw or jsDelivr, `main/services/network.ts`) and uses it if it parses (`source: 'remote'`). A remote catalog with `schema_version` below 2 is merged under the built-in one so it cannot reintroduce whole-repository downloads.
3. In development a `models.json` in the content directory wins (`source: 'local'`).

The shipped catalog (`schema_version: 3`) has two kinds of bundles:

- **Folder bundles** (`bundles`): `moss-sft` (recommended), `moss-base`, `moss-sft-fp16` and `moss-base-fp16`. All four share `qwen35-encoder`, `flux2-vae-small` and `moss-pipeline`, so switching between them downloads only the DiT.
- **Single-file bundles** (`single_file_bundles`): SFT · INT8, Base · INT8 (both `Comfy-Org/MOSS-Image`), SFT · INT4, SFT · NVFP4 and SFT Turbo · INT8. Each is a `format: 'comfyui'` DiT file, the INT8 text encoder file, the FLUX.2 small VAE file and `moss-runtime-config` (`RUNTIME_CONFIG_ID` in `shared/bundleFit.ts`: about 20 MB of configs and tokenizer). Files added for these bundles are pinned to the revisions the engine tested; a file downloaded earlier from `main` still counts as installed (`installMatchesRevision`).

The other `Comfy-Org/MOSS-Image` single files (W4A8, the Full VAE) are used through combinations (自己组合, below). `getCatalog` appends `single_file_bundles` and then the saved combinations to `bundles`, so the app sees one list. Older app versions read only `bundles` and never offer a single-file bundle they cannot load. A schema-2 catalog fetched remotely gets the built-in single-file bundles and their components added.

Bundle fields beyond the components (`ModelBundle` in `shared/types.ts`):

| Field | Meaning |
| --- | --- |
| `certified` | Listed in the engine's supported models (MossInfer `docs/integration.md`). The 模型 page shows certified bundles under 推荐模型 and the rest under 其他模型. |
| `tier` | The engine tier the bundle runs with: `high` for INT8, `turbo` for INT4 and NVFP4. It applies when the engine cannot name the weights' precision (section 4.4). |
| `requires` | Hardware it needs: NVFP4 runs only on compute capability 12.0 (RTX 50). Automatic GPU assignment waits for a GPU that matches. |
| `recommendedFor: 'limited-vram'` | Picked instead of the official SFT on a GPU with less than 16 GB of VRAM (`bestBundleFor` in `shared/bundleFit.ts`, also used by first-run setup). |
| `defaults` | Steps and CFG a few-step model brings when Studio picks it (`samplingForBundle` in `renderer/src/pages/studio/defaults.ts`): Turbo uses 8 steps and CFG 1. |

Which GPU can run which bundle is decided in one place, `bundleGpuProblem` in `shared/bundleFit.ts`, shared by job start, the 模型 page and Studio.

Catalog entries get their installed state from an install record (section 3), from a registered diffusers folder (section 4.3) or, for `provider: 'local'` entries, from the file still being where it was registered. The catalog is cached per models root and directory settings and invalidated by every download, import or delete (`invalidateCatalog`).

Which bundle a job uses: a 画面 (`kind: 'layout'`) stores only `modelBundleId` (`ProjectCanvas` in `shared/types.ts`). `resolveBundle` in `renderer/src/pages/studio/readiness.ts` takes the canvas's bundle, else the last one picked (`localStorage` key `mossstudio.modelBundleId`), else the recommended installed bundle, else the first installed one. `useGenerate.ts` sends `modelBinding: { bundleId, ...components }` with the job.

## 2. The models root and directories

| Path | Code (`main/lib/paths.ts`) | Default |
| --- | --- | --- |
| models root, 模型文件夹 | `paths.models(settings.modelsRoot)` | `<data root>/models`; `Settings.modelsRoot` overrides it |
| role folder | `paths.roleRoot(role, …)` | `moss/` (dit), `text-encoder/`, `vae/`, `support/`; `full` is the root itself; `Settings.modelDirectories[dit \| textEncoder \| vae \| support]` overrides one role |
| download cache per role | `paths.roleHub(role, …)` | `<role folder>/hf/hub/models--<owner>--<repo>/` in the Hugging Face layout: `blobs/`, `snapshots/<sha>/`, `refs/<revision>` |
| LoRA, LoRA文件夹 | `paths.adapters(…)` | `<models root>/adapters/<adapter id>/`; `modelDirectories.adapters` overrides it |
| registrations | `paths.modelImports(…)` | `<models root>/imports/index.json` |
| prepared bundles | `join(paths.models(…), 'bundles')` | `<models root>/bundles/<content key>/` (section 4.4) |

Folders are created only when something is written to them, and only inside the data root (`ensureDirs`). A folder the person pointed at, such as a ComfyUI `models` tree, never gets an empty `hf/hub` created in it; 清理空文件夹 (`cleanupEmptyModelDirs`) removes the empty `hf/hub` and `hf` folders older versions left behind, and nothing else.

Where this is set in the UI: the models root in 设置 › 存储 › 模型文件夹 (`renderer/src/pages/settings/StorageSection.tsx`; a change applies to new downloads, nothing is moved); the per-role folders in 模型 › 高级 › 文件夹 (`ModelDirectoriesCard.tsx`: 主模型文件夹, 文本编码器文件夹, VAE文件夹, LoRA文件夹, 运行配置文件夹, each with 更改 and 恢复默认).

## 3. Downloads

A download is one `DownloadTask` per component or adapter (`DownloadState`: `queued`, `running`, `verifying`, `paused`, `done`, `error`, `canceled`). `installBundle(id)` queues a task for each component of a bundle that is not installed; the 模型 page's 下载 button on a bundle calls it. Pause aborts the request and keeps the partial file; 继续 and 重试 start the task again and resume from the partial file.

| Step | Code | Behaviour |
| --- | --- | --- |
| Endpoint | `endpoint()` in `models.ts` | `Settings.hfEndpoint`, else the host the network probe picked (`hf-mirror.com` is preferred in 自动 and 镜像 mode, `huggingface.co` in 直连), else `https://huggingface.co`. |
| File list | `resolveFiles` in `modelFiles.ts`, `fetchHf` in `hfNetwork.ts` | Resolves the revision to a commit and lists files with sizes and LFS hashes. If the local request fails, the same URL is fetched through an SSH host (`Settings.hfQueryHostId`, 查询失败时改用远程主机). |
| Credentials | `hfCredentials.ts` | A token saved in 设置 › 网络 › 访问令牌（Token） is encrypted with Electron `safeStorage` into `<data root>/hf-credentials.json` and sent as `Authorization: Bearer`. Saving is refused when the OS offers no encrypted store (Linux `basic_text`). |
| Transfer | `downloadFile` in `modelFiles.ts` | Writes `<blob>.part`, resumes with a `Range` header, rejects a mismatched `Content-Range`, restarts on HTTP 416, verifies the size and the SHA-256 against the LFS hash, then renames into `blobs/`. `Settings.modelDownloadConcurrency` (同时下载的文件数, 1 to 16, default 4) limits parallel files. |
| Reuse | `runModelDownload` | Before requesting bytes, a blob with the same hash is hard-linked from any other repository cache under the models root, or copied from a hashed registered file (`verifyImportedModelFile`). |
| Space | `assertFreeSpace` in `main/lib/disk.ts` | Checked on the target role folder for the missing bytes plus 1 GiB. |
| Record | `InstallRecord` in `models.ts` | `.clover-<id>.json` next to `blobs/` lists the files and which blobs this entry owns; `.clover-<id>.json.pending` holds the same while a download runs; `refs/<revision>` gets the commit. `installState` is `partial` while either a pending record or a snapshot file exists. |
| Validation | `validateSnapshot` in `modelFiles.ts` | A component counts as installed only when every file has its size, `config.json` exists for the part, every shard named in a `*.index.json` exists, and a text encoder has its tokenizer. |

Deleting a component (`deleteModel`) removes the prepared bundles that contain it, then only the blobs this record owns and no other record shares; it refuses while a download or a job runs. The UI plans a bundle delete with `bundleDeletePlan` (`logic.ts`): parts another complete bundle still uses are kept and named in the confirm.

Remote hosts (`Settings.remoteHostsEnabled`): the 模型 page's 模型所在的电脑 picker switches to an SSH host. Downloads then run on the host through `main/services/remoteModelWorker.sh` (`remoteDownloads.ts`), continue after MossStudio closes, and the host's inventory (`remoteModels.ts`) decides what is installed. Files are deleted per entry on the host (`remoteModelDelete.ts`). 远程主机 in general is described in [`engines.md`](/docs/reference/engines.md).

## 4. Local models

Two ways exist to use files the person already has without downloading or copying them. Both write only the registration index (`imports/index.json`); the person's folder is never written to.

### 4.1 Scanning a folder

`scanModelDirectory` in `main/services/modelScan.ts` is read only. It walks up to 6 levels and 4000 files, skips `.git`, `hf`, `blobs`, `snapshots`, `custom_nodes`, `controlnet`, `embeddings`, `upscale_models` and the other ComfyUI side folders listed in `skippedDirectories`, and reports every `.safetensors`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf` and `.onnx` file as a `ScannedModel` with a role and a confidence:

| Signal | Role | Confidence |
| --- | --- | --- |
| Folder `diffusion_models`, `unet`, `checkpoints`, `transformer` | `dit` | high |
| Folder `text_encoders`, `clip`, `text_encoder` | `text_encoder` | high |
| Folder `vae`, `vaes` | `vae` | high |
| Folder `support`, `scheduler`, `pipeline`, `configs` | `support` | high |
| Folder `loras`, `lora`, `lycoris` | `lora` | high; shown but not registrable here (section 5) |
| File name matching `moss_image`, `qwen3.5`, `vae`, `scheduler` and the other `names` patterns | as matched | medium |
| Anything else | `full` | low, unchecked by default |

A folder that holds `model_index.json` or `transformer/config.json` is reported as one candidate with `layout: 'diffusers-folder'` instead of its files.

UI: 模型 › 其他模型 › 自己组合 › 用电脑上的模型文件… (`Ipc.modelsUseFolder` in `main/ipc.ts`). A folder holding a complete diffusers folder is added as in section 4.3. Otherwise the 主模型, 文本编码器 and VAE files found (confidence high or medium) are registered and 自己组合 opens with its slots filled from them, the first of each role; a slot with nothing found keeps its default download. Picking a per-role folder (模型 › 高级 › 文件夹 › 更改, `ModelDirectoriesCard.tsx`) scans it and lists the candidates in 找到的模型文件 to register.

### 4.2 Registering files

`registerScannedModels` in `main/services/modelImports.ts` writes one `ImportedModelFile` per path into `imports/index.json` (`schema_version: 2`): path, relative path, size, mtime, role, layout. Nothing is hashed; the id is `local-scan-<sha1 of the path>`. Registering the same path again updates the record.

In the catalog these records become `ModelEntry` rows with `provider: 'local'`, `family: 'local'`, `format: 'comfyui'` for a file or `'diffusers'` for a folder, `precision: 'local'` (a folder gets the dtype read from its first transformer shard), tags `local-import` and `unhashed` or `sha256:<hash>`. The entry is installed while the file still has the registered size and mtime; otherwise the 模型 page shows 找不到原文件. Removing an entry (移除) deletes the record only.

An older path still exists for a folder of loose weight files without a diffusers layout: `importModelFolder` in `modelImports.ts` hashes every file (SHA-256), ids `local-file-<hash>`, and skips duplicates by content. It is reached through first-run setup's 已有模型文件… when the chosen folder contains no diffusers folder.

### 4.3 Diffusers folders used in place

用电脑上的模型文件… (`Ipc.modelsUseFolder`) and first-run setup's 已有模型文件… (`Ipc.modelsImportFolder`) register a complete diffusers folder where it is. `inspectDiffusersFolder` accepts a folder with `model_index.json` and a `config.json` plus `.safetensors` weights in each of `transformer/`, `text_encoder/` and `vae/`. The flavour (`sft` or `base`) is read from the README title or the folder name; the folder is listed as `MOSS-Image SFT（<folder>）` or `MOSS-Image Base（<folder>）`.

The folder is one `role: 'full'` entry, and `localFolderInstall` in `models.ts` also lets it stand in for the official components: entries of `OpenMOSS-Team/MOSS-Image-SFT` and `OpenMOSS-Team/MOSS-Image-Base` (`MOSS_REPOS`) count as installed when the folder passes `validateSnapshot` for that component. The DiT must be the same flavour; the text encoder, VAE and pipeline files are shared by both. Such a component shows the `local-folder` tag and its `localPath`. When a job prepares the bundle (section 4.4), the folder's files are hard-linked, or symlinked when a hard link is refused (`linkInPlace`), never copied.

### 4.4 How files reach the engine

`prepareModelSource(binding)` in `main/services/modelBundles.ts` turns a binding into what the engine can load, right before the job starts (`startEngineJobNow` in `main/services/supervisor.ts`). MossInfer's `load` always needs `model`, a folder with the configs and tokenizer; `dit_file`, `text_encoder_file` and `vae_file` each replace that part's weights in it, so any part mixes with any other.

| Parts in the binding | Result | Engine `load` payload (`main/services/mossInfer.ts`) |
| --- | --- | --- |
| Three folders (`format: 'diffusers'`) | `{ model: <prepared folder> }` with the bundle's `support` (`moss-pipeline`) | `model` |
| At least one single file (`format: 'comfyui'`, downloaded or the person's own) | `{ model: <prepared folder>, ditFile?, textEncoderFile?, vaeFile? }`: the folder holds `moss-runtime-config` plus the parts that are folders | `model` and a `*_file` per single file |

A prepared folder is `<models root>/bundles/<key>/`, where `<key>` is the first 24 hex characters of the SHA-256 of `clover_model.json` (bundle id, the folder's component ids, repositories, commits, precisions). `materializeBundle` builds it in a staging directory with hard links to the snapshot files (`materialize`: link, else copy after a free-space check) and renames it into place; a path two parts share is taken from the first. An existing folder with the same manifest and file sizes is reused. The layout is a diffusers model: `transformer/`, `text_encoder/`, `tokenizer/`, `vae/`, plus the support files at the root. For three folders, `prepareModelBundle` first checks the binding (`validateBinding`: every component `format: 'diffusers'`, `family: 'moss-image'`). A single file is passed where it is: the person's file by its `localPath`, a downloaded one from its snapshot.

Combinations: `shared/modelCombos.ts` holds the rules (`slotChoices`, `supportFor`: `moss-runtime-config` once any part is a single file, else `moss-pipeline`; `combinationBundle`; `unusedDownloads`). `main/services/modelCombinations.ts` keeps them in `<data root>/model-combinations.json`, and `getCatalog` appends them to `bundles` with `custom: true`. When that file does not exist yet and the catalog has an installed local DiT, text encoder and VAE, the bundle older versions made by themselves (`localFilesBundle` in `shared/localBundle.ts`, id `local-files`) is saved once as the combination 电脑上的模型, so 画面 that use it keep working.

The local-files bundle: `localFilesBundle` in `shared/localBundle.ts` builds `ModelBundle` `local-files`, 本地文件（扫描）, as soon as an installed local DiT, text encoder and VAE exist in the catalog, and `getCatalog` puts it first in `bundles`. `localDitNeeds` gives it a `tier` (and `requires` for NVFP4) guessed from the DiT's precision or file name.

Precision and tier: for component files `jobWeightPrecisions` (`main/services/weightPrecision.ts`) asks the engine's `inspect` what the DiT and text encoder are; `tierForWeights` in `shared/gpuProfile.ts` then settles the tier (an INT4 DiT runs Turbo, an INT8 DiT or INT8/W4A8 text encoder runs High). A prepared bundle folder counts as bf16. When the engine cannot name a file's precision (NVFP4, or an engine without `inspect`), the bundle's own `tier` decides instead (`profileForBundle` in `shared/bundleFit.ts`); either way the job records `source: 'model-weights'`. The CLI engines (兼容模式, AMD 原生) read only a prepared bf16 folder (section 8).

## 5. LoRA

A LoRA is an `AdapterEntry` (`kind: 'lora' | 'lycoris' | 'dmd'`) in the catalog's `adapters`, downloaded or local. Each one lives in `<adapters root>/<id>/`:

| Source | Code (`models.ts`) | Record |
| --- | --- | --- |
| Catalog download | `runAdapterDownload` | The repository files listed in the entry, then `adapter.json` (the entry itself). Installed when `adapter.json` and every file exist. |
| Imported file, 导入 LoRA 文件 | `importAdapterFile` | A `.safetensors` file (LoRA or LyCORIS) is copied into `<adapters root>/<id>/`, id from the file name with `-2`, `-3` on collision; origin `imported`, tag `local-import`. Copied, not referenced, because the engine opens the path itself and people move downloads. |
| Trained in 训练 | `registerTrainedAdapter` | Origin `trained`, tag `trained`. |

Local adapters are indexed in `<adapters root>/index.json` (`LocalAdapterIndex`). Deleting one removes its folder and its index row.

On the board a 风格 (`kind: 'style'`) or 画面 stores `adapters: CanvasAdapter[]`, ids and strengths only (`shared/adapters.ts`: strength 0 to 2, default 1, step 0.05, at most 16 per canvas, ids are single path segments). `resolveCanvasAdapters` (`main/services/adapterResolution.ts`) turns the ids into files at job start through `resolveAdapterFile`; a missing adapter fails the job with the message the Studio shows, it is never dropped silently. `kind: 'dmd'` adapters are not offered in the picker (`isSelectableAdapter` in `shared/adapters.ts`), since the `dmd8` sampling profile applies them. How the 风格 node uses LoRA is in [`studio-node-board.md`](/docs/reference/studio-node-board.md).

UI: 模型 › LoRA (`LoraTab.tsx`): 已安装 with 导入 LoRA 文件 and 删除, and 可以下载.

## 6. Control adapters

A control adapter (控制适配器) is the file that makes a 控制图 (role `control`) usable. `main/services/controlAdapters.ts` keeps them in `<data root>/control-adapters.json` as `ControlAdapterEntry` rows. `addControlAdapter` asks the engine to `inspect` the file (the running `moss-server`, else a short-lived one from the local package) and accepts it only when the report says `kind: 'control_adapter'` and not `loadable: false`; it stores the `control_kinds` (for example `depth`, `canny`) and `base_model` the engine reports. A file of another kind is refused with a hint (这是 LoRA，请在 LoRA 中添加, and the same for DiT, text encoder, VAE). Removing an entry drops the record; the file stays.

UI: 模型 › 控制适配器 › 添加文件 (`ControlAdaptersSection.tsx`). The section is hidden when the engine has no `control` feature and nothing is registered, and disabled until an engine is installed. A control port on the board asks for one before it accepts a wire (`renderer/src/pages/studio/ports.ts`).

## 7. The Models page

Route `/models`, Rail entry 模型, `renderer/src/pages/models/ModelsPage.tsx`. Tabs: 模型, LoRA, 下载 (with the count of unfinished tasks).

| Area | Component | Shows |
| --- | --- | --- |
| 推荐模型 | `FeaturedModel` in `ModelEntries.tsx`, then `ModelList` | The bundle that suits this computer first (`bestBundleFor`), with the reason, name, description and total size and one main action: 下载, 暂停, 继续 or 重试; 可以使用 and 去创作 when installed. Below it every other `certified` bundle. A bundle this GPU cannot run says why; a paused or failed download of it can still be continued or retried. |
| 其他模型 | `ModelList`, `CombinationDialog.tsx` | Every bundle that is not `certified` (the FP16-fixed community versions) as a row, and each combination tagged 我的组合 (hidden on a remote host). 自己组合 (local only) offers 挑选要下载的部件 and 用电脑上的模型文件…: the dialog has 名字 and one select per slot (下载: each `choice` label once, the copy already here first, else the folder version; 电脑上的文件: registered single files and 选择文件…), counts 还要下载 and saves with 下载并保存 or 保存. Deleting a combination removes the downloads only it needs, never the person's files (`DeleteModelDialog`). |
| 控制适配器 | section 6 | Local only. |
| 存储位置 | `StorageRow` | 模型文件夹 with 打开模型文件夹 and 在 设置 › 存储 中更改; on a host, 模型保存在 … 上. |
| 高级 | `AdvancedPanel.tsx` | 文件夹 (`ModelDirectoriesCard`) and 没有用到的文件 (downloads no bundle or combination needs, `unusedDownloads`, with 查看 and 全部删除), or on a host 主机上的文件夹 (模型保存目录, 生成时使用的模型文件夹 with 自动查找, 下载完整的默认模型). |

State texts come from `bundleView` and `itemState` in `logic.ts`: 可以使用, 下载中 N%, 正在校验文件, 已暂停, 下载没有完成, 还差 N 个文件, 未下载, 已下载, 已添加, 找不到原文件, 文件不完整 (action 修复). Files the app downloaded are 删除d; registered files are 移除d from the list. Deep links take `?bundle=<id>&component=<role>&hostId=<id>&tab=models|lora|downloads` (`parseModelsQuery`); first-run setup uses them to point at the model with the missing part.

## 8. Limits

As built at d0883df. None of these is planned work; they describe what the code does today.

- A combination's own file must be a single file (`format: 'comfyui'`); a registered diffusers folder is a whole model (section 4.3), not a slot choice.
- A combination is not edited in place: it is deleted and built again.
- Scanned files are checked by size and mtime, not hashed, so they cannot be matched to a Hugging Face blob or reused by a download. Only the older loose-file import hashes.
- A registered diffusers folder serves only `OpenMOSS-Team/MOSS-Image-SFT` and `OpenMOSS-Team/MOSS-Image-Base` components (`MOSS_REPOS`). An FP16-fixed folder registers as a 完整模型 entry but stands in for no bundle.
- Single-file bundles and combinations with a single file run only on this computer's moss-server. A remote host uses its own model folder, and a GPU running a CLI engine refuses them with the reason the 模型 page and Studio also show.
- The CLI engines refuse any `format: 'comfyui'` component (so a combination with a single file) and any non-bf16 DiT or text encoder (`cliBundleProblem` in `shared/cliEngine.ts`; `cliBundleDtypeProblem` reads the shard dtypes of a prepared folder).
- Remote hosts take no LoRA (`resolveCanvasAdapters` refuses when `hostId` is set), show no combinations and no control adapters; 自己组合 is local only.
- Adding a control adapter needs an engine whose `hello` lists `inspect`; an older engine is refused with 当前引擎版本不能识别控制适配器.
