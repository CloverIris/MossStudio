---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: apps/desktop/src/shared/enginePackages.ts, apps/desktop/src/shared/engineChoice.ts, apps/desktop/src/shared/cliEngine.ts, apps/desktop/src/shared/gpuProfile.ts, apps/desktop/src/shared/engineProtocol.ts, apps/desktop/src/main/services/engineMachine.ts, apps/desktop/src/main/services/enginePlan.ts, apps/desktop/src/main/services/engineInstalls.ts, apps/desktop/src/main/services/mossInfer.ts, apps/desktop/src/main/services/cliEngine.ts, apps/desktop/src/main/services/supervisor.ts, apps/desktop/src/main/services/weightPrecision.ts, apps/desktop/src/main/services/remoteEngine.ts, apps/desktop/src/main/services/mossInferDownload.ts, apps/desktop/src/main/services/engineAutoUpdate.ts
---

# Engines and GPU support

MossStudio generates pictures through MossInfer, a native engine the app downloads and installs per GPU. An NVIDIA GPU runs the CUDA `moss-server` with every feature; other GPUs run the one-shot programs `moss-infer-vulkan` (兼容模式) or `moss-infer-hip` (AMD 原生), text to image only. This doc describes how the app detects hardware, chooses and installs packages, runs and queues jobs, and uses remote hosts. The engine protocol, build matrix and supported-GPU facts live in the [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp); this doc links them and does not copy them.

Paths in this doc are relative to `apps/desktop/src/`. Decisions: [ADR-0009](/docs/decisions/0009-mossinfer-inference.md) (MossInfer as the only engine) and [ADR-0012](/docs/decisions/0012-vulkan-and-hip-cli-engines.md) (the Vulkan and HIP engines).

## Hardware and packages

### The machine probe

`EngineMachine` (`shared/engineChoice.ts`) is everything the chooser needs to know about one computer: the OS, every GPU, which CUDA majors have system libraries, whether ROCm 7 is present, and whether the user may open the AMD device nodes. Each `EngineMachineGpu` carries a stable `id` (nvidia-smi's UUID, or `vk-<vendor>-<device>-<n>` for a GPU nvidia-smi does not list), the vendor, the PCI id, memory, and per-backend facts: `computeCapability` and `driverVersion` for NVIDIA, `vulkan` (index, usable, discrete) from the Vulkan probe, `gfxTarget` and `hip` for AMD.

`probeEngineMachine` (`main/services/engineMachine.ts`) fills it from several programs, each run with an argument array and a timeout. A probe that fails only removes what it would have added and leaves a line in `notes`.

| Source | What it adds | Where |
| --- | --- | --- |
| `nvidia-smi` | NVIDIA GPUs: UUID, index, name, memory, driver, compute capability, PCI id | `main/services/devices.ts` (`scanNvidiaGpus`), `main/lib/gpuInventory.ts` |
| `moss-infer-vulkan --list-devices` | Every GPU Vulkan sees, with usability and discrete/integrated. Uses the installed Vulkan package, or downloads the small Vulkan package as the probe (`ensureVulkanProbe`, `<engine root>/.probe`) | `main/lib/vulkanDevices.ts`, `main/services/mossInferDownload.ts` |
| KFD topology (`/sys/class/kfd/kfd/topology/nodes`) | AMD gfx targets on Linux | `main/lib/amdGpus.ts` |
| `ldconfig -p`, `/opt/rocm*/lib*` | Whether `libamdhip64.so.7` (ROCm 7) is installed, and where | `engineMachine.ts` (`probeRocm`) |
| `/dev/kfd`, `/dev/dri/renderD*` | `hipAccess`: read and write access, which HIP needs | `engineMachine.ts` |
| `moss-infer-hip --list-devices` | HIP's own device order and usability, when HIP is installed | `main/lib/cliProtocol.ts` (`parseHipDeviceList`) |
| system CUDA libraries | `systemCuda`: `cu12`, `cu13` or both | `main/services/systemCuda.ts` |

The result is cached in `<engine root>/machine.json` for ten minutes (`MACHINE_TTL_MS` in `main/services/enginePlan.ts`). It is probed again on 重新检测显卡 in 设置 › 设备与引擎, when nvidia-smi lists a different set of cards (`nvidiaSetChanged`), or when an earlier probe had no Vulkan program and a release is now at hand. Driver version and compute capability are always taken live from nvidia-smi (`withLiveNvidia`), because a driver update changes which CUDA build runs. On macOS the machine has no GPUs and nothing runs locally.

The GPU list the UI shows (`gpu:inventory`, `GpuInventorySnapshot`) and the telemetry stream (`gpu:telemetry`, `main/services/gpuTelemetry.ts`) merge nvidia-smi rows with the Vulkan-listed GPUs, so AMD and Intel cards appear with a `vendor` and a `vulkanIndex`.

### Packages

An `EnginePackage` (`shared/enginePackages.ts`) is one downloadable build of a MossInfer release.

| `kind` | Fields | Program | Published for |
| --- | --- | --- | --- |
| `cuda` | `flavour: 'cu12' \| 'cu13'`, `arch: 'standard' \| 'sm75' \| 'sm70'`, `runtime: 'bundled' \| 'system-cuda'` | `moss-server` | Windows and Linux; `sm75` only as Windows CUDA 13, `sm70` only as Linux CUDA 12 (`packageExistsFor`) |
| `vulkan` | none | `moss-infer-vulkan` | Windows and Linux |
| `hip` | none | `moss-infer-hip` | Linux; GPUs `gfx1100`, `gfx1200`, `gfx1201` (`HIP_GFX_TARGETS`) with ROCm 7 |

What each field means:

- **Flavour** is the CUDA major. Each needs a minimum NVIDIA driver (`DRIVER_MINIMUM`): CUDA 12 from 525.60.13 on Linux and 527.41 on Windows, CUDA 13 from 580.65.06 on Linux and 580.88 on Windows. `driverSupports` applies these; an unknown driver version supports nothing.
- **Arch** is the set of GPU kernel images in the build. The `standard` build has images for compute capability 8.x and 12.x and newer, and none for 9.x, 10.x or 11.x; `archRunsOn` encodes this together with what `sm75` and `sm70` add. The header comment of `enginePackages.ts` cites the engine sources these facts come from.
- **Runtime**: `bundled` ships the CUDA libraries (UI 自带运行库); `system-cuda` loads the ones installed on the computer, cuBLASLt included (UI 系统运行库).

Package ids are the suffixes of asset and folder names: `cu13`, `cu13-sm75-system-cuda`, `cu12-sm70`, `vulkan`, `hip` (`enginePackageId`, `parseEnginePackageId`). Release assets are named `mossinfer-<version>-<os>-<flavour>-x86_64[-<arch>][-system-cuda].zip|tar.gz` for CUDA and `mossinfer-<version>-<os>-<kind>-x86_64.…` for the CLIs (`engineAssetName`); Windows ships `.zip`, Linux `.tar.gz`. The UI calls the kinds CUDA 13 / CUDA 12, 兼容模式 and AMD 原生 (`enginePackageTitle`); the picker labels are CUDA 13 · 自带运行库, 兼容模式（Vulkan） and AMD 原生（ROCm） (`enginePackageOptionLabel`).

### Which package a GPU gets

`chooseEnginePackages(machine, release, options)` (`shared/engineChoice.ts`) is pure: the main process feeds it a machine and a release's asset list, and the renderer and the E2E mock reuse it. For every GPU it walks a ladder and takes the first step whose package the release publishes for this OS and whose program can use the GPU.

| GPU | Steps, in order |
| --- | --- |
| NVIDIA with a kernel image in the standard build (8.x, 12.x and newer) | CUDA 13 if the driver allows; CUDA 12 if the driver allows, with the tip to update to R580; Vulkan, with the tip to update the driver |
| NVIDIA, compute capability 7.x | The `sm75` or `sm70` CUDA build the release has for this OS and flavour, when the driver allows; else Vulkan |
| Other NVIDIA | Vulkan |
| AMD `gfx1100`/`gfx1200`/`gfx1201` on Linux | HIP, when ROCm 7 is present and either `moss-infer-hip` lists the GPU as usable or the user has device access and it is not listed unusable; else Vulkan, with a tip to install ROCm 7 or join the `render` and `video` groups |
| Anything else | Vulkan, if the probe says the device is usable |

Within a CUDA step the runtime the machine already has comes first: `system-cuda` when `systemCuda` includes that flavour, else `bundled` (`cudaCandidates`). Two rules run after the ladder: an integrated GPU gets no engine while a discrete GPU runs one (`integratedSkipped`), and a per-GPU override from 设置 › 设备与引擎 › 高级 › 每块显卡的引擎 (`Settings.engineDeviceOverrides`, deviceUuid to package id) replaces the choice when that package runs on the GPU, or is flagged `overrideIgnored` when it does not. On macOS the plan is `blocked` with a message that points at 远程主机.

The result is an `EnginePlan`: one `GpuEngineChoice` per GPU (package, reason in plain words, optional tip, every compatible package for the override picker) and the distinct `packages` to install with the GPUs each serves and the total download size. `EnginePlanView` (`shared/types.ts`) adds what is installed and what is missing; it is what `/setup` and 设置 › 设备与引擎 show (IPC `engine:plan`, `main/services/enginePlan.ts`).

Two more callers use the same chooser: `installedAsRelease` turns the installed packages into a release so the chooser says which installed package a GPU runs, and `cudaOnly: true` restricts it to CUDA builds for remote hosts.

### Installed packages and the engine each GPU runs

Packages install side by side under the engine root (`paths.mossinfer()`: `<data root>/mossinfer`, or `Settings.engineRoot`). Each folder is named by its stamp, `stable-<tag>-<packageId>` for a release or `dev-run<id>-<sha>-<packageId>` for a CI build (`shared/engineUpdate.ts`, `parseEngineStamp`), and keeps the upstream layout: `bin/moss-server` with `lib/`, `bin/moss-infer-vulkan`, or `bin/moss-infer-hip`.

`resolveDeviceEngine(deviceUuid)` (`main/services/engineInstalls.ts`) answers which installed program a GPU runs, as a `DeviceEngine` (package, binary path, version, Vulkan index, gfx target, extra environment such as `LD_LIBRARY_PATH` for a ROCm outside `/opt/rocm/lib`). A pinned `Settings.mossInferServerPath` (an older version or a custom engine chosen in 高级) serves the NVIDIA GPUs it can run on; otherwise the chooser picks among the newest install of each package, honouring the per-GPU overrides. External engines are registered in `<engine root>/external.json` (`main/services/engines.ts`) and never copied. Without any install, `resolveServerPath` (`main/services/mossInfer.ts`) falls back to `MOSS_SERVER`, `resources/mossinfer/bin/moss-server` in the app bundle, then `PATH`.

`EngineReadiness` (`main/services/engineReadiness.ts`, IPC `engine:status`) is `ready` when at least one local GPU has an installed package that runs on it, and lists the package per GPU in `devices`. It carries the current install progress and the last install attempt (`<engine root>/last-attempt.json`) so the UI can say MossInfer 已就绪 · 上次更新失败 (`describeEngineReadiness` in `shared/engineReadiness.ts`).

## Engines and jobs

### The CUDA server

`main/services/mossInfer.ts` keeps one long-lived `moss-server` per GPU UUID (`runtimes`). The process is started with `--parent-pid` and `CUDA_VISIBLE_DEVICES=<uuid>`, so the GPU appears as device 0 in the engine's own numbering, and judged by `judgeEngineSupport` with `indexOnly` (`shared/engineProtocol.ts`): the engine's `supported: true` for the device is the only compatibility authority. Requests and events are JSON lines over stdio. Every `hello` the app reads goes through `decodeEngineHello`, and only protocol 2 (`ENGINE_PROTOCOL_VERSION`) is accepted.

Each runtime has one FIFO (`queue`, `pump`). Before a job runs, `ensureEngine` sends `load` with the memory mode, device, tier, `cache_dir` (`<data root>/cache/mossinfer`) and either a bundle folder (`model`) or component files (`dit_file`, `text_encoder_file`, `vae_file`); the request is re-sent only when that key changes. `generate` uses the job id as request id so `cancel` matches it. A crash fails the active job and the runtime respawns for the next one. After `Settings.mossInferRefreshEvery` finished generations (default 5; 连跑时重新加载引擎 in 高级, with 不重载, 每 5 张, 每 10 张, 每 20 张) the server is stopped and started again before the next job, so a long batch gets its GPU memory and file cache back at the cost of one reload. A server whose GPU now runs another package is stopped when idle (`releaseStaleMossInferRuntimes`), also right after the engine choice changes in settings (`releaseAfterSettingsChange` in `engineInstalls.ts`); `shutdown` is asked first and the process killed after 3 seconds. Engine events are translated into the runner event shapes `hello`, `ready`, `log`, `stage`, `progress`, `result`, `error`, `canceled` that `supervisor.handleRunnerEvent` consumes. When the engine reports the `preview` capability, the live preview PNG is written to `<data root>/cache/previews/<job>.png` (`main/services/jobPreview.ts`).

### The CLI engines

`moss-infer-vulkan` and `moss-infer-hip` are one-shot programs: one process per job, one job at a time per device (`main/services/cliEngine.ts`), with the argument list and stderr grammar in `main/lib/cliProtocol.ts`. They read a bundle folder in diffusers layout whose DiT and text encoder are bf16, and run the `euler` sampler with the `moss` schedule (`CLI_SAMPLER`, `CLI_SCHEDULER` in `shared/cliEngine.ts`). Nothing else the server does is available.

| Check | Where | What it refuses |
| --- | --- | --- |
| `cliUnsupported` | `main/lib/cliProtocol.ts` | A job with LoRA, 起始图, 遮罩, 控制图, 参考图, 高清修复 or another sampler |
| `cliBundleProblem` | `shared/cliEngine.ts` | A bundle the catalog cannot confirm as bf16, or scanned single files |
| `cliBundleDtypeProblem` | `main/services/cliEngine.ts` | Safetensors headers that are not bf16 |

The program prints the device it chose before loading; a different card than the job's stops the job there (`sameCliDevice`). Vulkan device indices come from the probe list, HIP indices from `moss-infer-hip --list-devices` (`hipDeviceIndex`). Cancel terminates the process and kills it after 3 seconds (`CLI_CANCEL_GRACE_MS`). Exit code 1 is a failed run, 2 an unsupported request. Before a CLI job starts, a `moss-server` left on the same GPU is released so its memory is free.

### What the engine can do

`EngineFeatures` (`shared/types.ts`) tells the Studio which inputs to offer: `preview`, `imageInput` (起始图 and 遮罩), `control`, `references`, `hires`, `samplers`, `lora`, `cli` (set to `'vulkan'` or `'hip'` for a CLI engine) and `values`, the accepted names per enum parameter (sampler, scheduler, resize). For a server it is read from the `hello` capabilities (`engineFeaturesOf`): a capability the hello does not name counts as unsupported, except `lora`, which is on unless the engine says `false`. A CLI engine reports everything off (`cliEngineFeatures`).

`getEngineFeatures({ deviceUuid?, hostId? })` (`main/services/engineFeatures.ts`, IPC `engine:features`) never starts a server for the question: it uses the running server's hello, or one probe per engine binary cached until the binary changes; for a remote host it uses the host's hello with `control` and `preview` forced off. The Studio hides inputs the engine lacks (`renderer/src/pages/studio/useEngineFeatures.ts`, one note from `cliEngineNote` for the CLIs), `main/services/jobInputs.ts` refuses a job that still carries them, and the scheduler never routes such a job to a CLI GPU.

`inspect` is the engine's header-only reader: it names a file's `kind` and `precision` without touching the GPU. The app uses it for weight precision (below) and to register control adapters (`main/services/controlAdapters.ts`).

### Tiers and weights

`Settings.mossInferTier` is `reference`, `high` or `turbo`; the UI (性能档位 in 设置 › 设备与引擎 › 高级) keeps the English names. The weights a job loads settle the tier (`tierForWeights` in `shared/gpuProfile.ts`):

| Weights | Tier | Reason recorded |
| --- | --- | --- |
| INT4 DiT (`w4a4`) | `turbo` | `weights` |
| INT8 DiT, or INT8 / `w4a8` text encoder | `high` | `weights` |
| bf16 on a GPU without 8-bit attention (compute capability below 8) | `reference` | `gpu` |
| bf16, `turbo` asked | `high` | `weights` |
| bf16 or unknown, otherwise | as asked | none |

`main/services/weightPrecision.ts` finds the precision by asking the job's engine `inspect` for the DiT and text encoder files, through the GPU's running server when there is one, else a short-lived server of the GPU's package; answers are cached per file size, mtime and engine. A bundle folder's own components count as bf16, and a CLI job is always bf16. The job records what decided its profile in `JobGpuProfile.source`: `recommended`, `global`, `gpu-override`, `hardware-compatibility` or `model-weights`.

### Memory modes

`Settings.mossInferMemoryMode` is `min_memory`, `balanced` or `max_speed` (UI 省显存, 均衡, 速度优先). With `gpuProfileMode: 'auto'` the mode follows the GPU's memory (`recommendGpuMemoryMode`): under 6 GiB `min_memory`, 24 GiB and above `max_speed`, otherwise `balanced`. Each GPU can override mode and tier (`gpuProfileOverrides`, UI 每块显卡单独设置). `resolveGpuProfile` combines these, and the mode goes to the engine as `mode` in `load`. The mode only changes how the engine manages memory; it never changes the model, its precision or the job's parameters.

### Scheduling and queues

The Studio posts a generation to the local backend (`POST /api/engine-jobs`), which calls `startRequestedEngineJob` (`main/services/engineJobStart.ts`): the update gate (`minimumVersion`), LoRA id resolution and input validation happen there, then `startEngineJob` in `main/services/supervisor.ts` takes over.

1. The job waits for any engine activation in progress (`main/lib/engineActivation.ts`), so it never starts on a build about to be stopped.
2. One active job per canvas branch: a 画面 with a queued or running job refuses another.
3. `resolveLocalGpu` picks the GPU: the card bound to the canvas, else `Settings.gpuSelection`, else automatic. Automatic choice (`selectAutomaticGpu` in `shared/gpuScheduling.ts`) takes an idle compatible GPU first, ordered by compute capability, memory and index, else the least loaded one. It prefers CUDA GPUs; a CLI GPU is used only when the machine has no CUDA GPU and the job is plain text to image, and an integrated GPU only when there is no discrete one. A hand-picked GPU is checked against its engine's hello (`judgeEngineSupport`) or its CLI's limits.
4. The job takes a slot, `gpu:<uuid>` or `host:<hostId>` (`engineSlotKey`). One job runs per slot; the rest wait in `engineQueues` with a `queuePosition` the Activity panel shows. The record keeps `queuedBehind` (how many jobs were ahead when it was queued) and `runStartedAt` (when its turn came), so a card can tell waiting time from generation time.
5. `startEngineJobNow` materialises the model (`main/services/modelBundles.ts`), runs the CLI bundle checks, settles the tier from the weights, and dispatches to `runMossInferJob`, `runCliJob` or `runRemoteEngineJob`.

Jobs are persisted in `<data root>/jobs/jobs.json` with one log per job in `jobs/<id>.jsonl`; outputs land in `<data root>/outputs/<job>-1.png` and are recorded for the Library. `main/services/launchQueue.ts` is a leftover from the runner era: it stores `LaunchRow`s in `launch-queue.json` behind the `launch-queue:*` IPC and takes no part in engine scheduling.

## Remote hosts

Remote hosts are an optional feature, off by default (`Settings.remoteHostsEnabled`, 设置 › 功能 › 远程主机). A host is a Linux machine with an NVIDIA GPU reached over SSH (`TrainingHost` with `kind: 'ssh'` in `shared/types.ts`, stored in `<data root>/hosts.json`); its engine lives at `engineRoot` (default `~/.mossstudio/engine`) and its pictures at `outputRoot` (default `~/.mossstudio/outputs`). Hosts run `moss-server` only: `chooseRemotePackage` (`main/services/remoteEngineInstall.ts`) runs the chooser with `cudaOnly` on the host's probe (`main/services/remoteCuda.ts`: nvidia-smi, CUDA libraries, driver) and `installRemoteEngine` downloads the Linux release asset on the host with `curl`, checked against the release digest or `SHA256SUMS`, without Python.

Each job opens its own SSH session (`runRemoteEngineJob` in `main/services/remoteEngine.ts`), which runs `cd <engineRoot> && exec bin/moss-server` and speaks the same JSON-lines protocol: `hello` (protocol 2), `load` with the host's model path, memory mode, tier and `<engineRoot>/cache`, upload of the job's input pictures into a per-job folder on the host (`uploadJobInputs`), then `generate`. The result PNG comes back as base64 over a second SSH command into `<data root>/outputs`. When the job ends the input folder is removed, `shutdown` is sent and the session closed (killed after 5 seconds, `REMOTE_SHUTDOWN_TIMEOUT_MS`), so no server lingers in the host's GPU memory. Cancel sends the engine's `cancel` and closes the session if it does not confirm within 5 seconds (`REMOTE_CANCEL_TIMEOUT_MS`); before `generate`, cancel closes the session outright.

Jobs on one host run one at a time (slot `host:<id>`). The host's hello is cached for ten minutes (`remoteEngineHello`). Control adapters and live previews are not carried over SSH, and the Studio refuses LoRA on a remote host (`renderer/src/pages/studio/useGenerate.ts`). Models for a host are prepared on the host (`main/services/remoteModels.ts`); see [models.md](/docs/reference/models.md).

## Install and update

### Installing a plan

`installEnginePlan` (`main/services/enginePlan.ts`) installs the plan's missing packages through `downloadMossInfer` (`main/services/mossInferDownload.ts`). `/setup` and 设置 › 设备与引擎 › 高级 › 按以上选项安装 call it; the dev channel and a chosen release tag are 高级 options. On first run, 开始下载 on `/setup` starts the engine packages and the recommended model together, and the renderer shows them as one preparation (`renderer/src/lib/preparation.ts`), also on the Studio's 生成 button while it runs (`usePreparation.ts`).

| Step | What happens |
| --- | --- |
| Source | The upstream repository `MOSSINFER_REPO` (`main/lib/engineAssets.ts`). Stable: the latest GitHub Release (or a chosen tag). Dev: the latest successful `ci` run's artifact, which needs a GitHub token (网络 › 高级). |
| Verify | Release assets are checked against GitHub's per-asset digest or `SHA256SUMS`, read from github.com and never through a mirror; mirrors (`main/services/network.ts`) carry only the download itself. |
| Stage | Unpacked into `<engine root>/.staging` (`.zip` through `yauzl` on Windows, `tar` on Linux), after a free-space check. For a `system-cuda` package without cuBLASLt on the machine, `main/services/cudaWheels.ts` can add the NVIDIA CUDA libraries (IPC `engine:install-cuda-wheels`). |
| Check | The staged program is run (`--version`, and for CUDA a `hello` judged against the target GPUs, `verifyStaged`). |
| Promote | `main/lib/engineStore.ts`: the folder moves into place, the replaced one into `.backup`, with `.pending.json` for recovery at the next start (`recoverEngineInstall`). |
| Activate | Under the activation lock (`activateWhenAllowed`): running servers of that GPU stop and the next job starts the new build. A background update passes a gate so it activates only while no local engine job runs. |

Progress is one `MossInferDownloadState` (`event:mossinfer-download`), with `step` for multi-package installs; the outcome is written to `last-attempt.json`.

### Auto-update

`Settings.engineAutoUpdate` (自动更新 in 设置 › 设备与引擎, on by default) keeps the engine on the newest stable release (`main/services/engineAutoUpdate.ts`). The first check runs three minutes after start, then every six hours, or after twenty minutes when the engine was busy. Only managed stable installs in use are updated, every package kind among them; a custom engine or CI build is left alone. Installing an older release by hand pins it (`<data root>/engine-auto-update.json`) until the person installs the newest or turns the switch off and on. A failed release is retried after one day, then two, four, up to a week.

## Not built

- No run of the HIP engine on a real AMD GPU is recorded (ADR-0012).
- Live preview, control adapters and LoRA do not work on remote hosts.
- Remote hosts cannot run the Vulkan or HIP engines.
