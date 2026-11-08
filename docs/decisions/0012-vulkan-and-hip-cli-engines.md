---
status: proposed
date: 2026-11-08
amends: ADR-0009
---

# ADR-0012: Vulkan and HIP CLI engines beside the CUDA server

## Context and problem statement

ADR-0009 made MossInfer the only inference engine and, in point 2, limited it to Windows and Linux x86_64 with an NVIDIA GPU. MossInfer 2.2.0 changed what is available. Instead of one universal build it publishes per-hardware CUDA builds plus two one-shot programs: `moss-infer-vulkan` (Windows and Linux, any Vulkan GPU) and `moss-infer-hip` (Linux, AMD through ROCm 7). Neither speaks the `moss-server` protocol; each runs one text-to-image job per process. Commit 84f55ce (PR #26, 2026-11-05) taught the app to detect the machine and install a build per GPU, including these two. The question: do non-NVIDIA GPUs get local inference, and on what terms?

## Decision drivers

- Users with AMD, Intel or older NVIDIA cards otherwise get nothing locally; ADR-0009 pointed them at a remote host.
- No Python and no manual runtime download: whatever runs must be a release asset of MossInfer that the app installs and verifies itself (ADR-0009 points 1 and 5).
- A feature the engine cannot do must be hidden before the job starts, with a reason, rather than fail during a run.
- Jobs are dispatched per GPU (`docs/reference/engines.md`), so one machine can mix a CUDA GPU and a Vulkan one.
- Remote hosts stay CUDA only; they run `moss-server`.

## Considered options

1. Stay NVIDIA only, as ADR-0009 says, and keep pointing other GPUs at remote hosts.
2. Wait for a Vulkan or HIP build of `moss-server` with the full protocol.
3. Add a second backend for AMD, such as PyTorch with ROCm.
4. Install `moss-infer-vulkan` and `moss-infer-hip` as engines of a reduced kind: text to image only, chosen per GPU, with the Studio hiding what they cannot do.

## Decision outcome

Chosen option: 4. Option 1 leaves most AMD and Intel owners, and NVIDIA owners with old drivers, unable to try the app. Option 2 depends on work in another repository with no date; MossInfer 2.2.0 ships the CLIs and no server for those backends. Option 3 brings back the Python environment that ADR-0009 removed and would need its own model files and update path.

As built at f727e95:

- **Packages.** `apps/desktop/src/shared/enginePackages.ts` defines `EnginePackage` as `{ kind: 'cuda', flavour, arch, runtime }`, `{ kind: 'vulkan' }` or `{ kind: 'hip' }`. `packageExistsFor` encodes the release matrix: Vulkan on Windows and Linux, HIP on Linux only, nothing on macOS. HIP targets `gfx1100`, `gfx1200` and `gfx1201` and needs ROCm 7's `libamdhip64.so.7`. `isCliEngine` separates the two one-shot programs from `moss-server`.
- **Names.** In the UI Vulkan is 兼容模式 and HIP is AMD 原生 (`enginePackageTitle`; `CLI_ENGINE_LABEL` in `shared/cliEngine.ts`). Pickers say 兼容模式（Vulkan） and AMD 原生（ROCm）.
- **Choice per GPU.** `chooseEnginePackages` in `shared/engineChoice.ts` walks a ladder for each GPU. An NVIDIA card with a kernel image takes CUDA 13 if the driver allows, else CUDA 12, else Vulkan with a driver tip. Turing and Volta take the `sm75` or `sm70` CUDA builds where the release has them, else Vulkan. An AMD card with a listed gfx target, ROCm 7 and access to `/dev/kfd` takes HIP, else Vulkan with a ROCm tip. Anything else takes Vulkan when the probe says the device is usable. macOS is blocked and pointed at remote hosts. An integrated GPU gets no engine while a discrete GPU runs one. Each GPU can be overridden from 设置 › 设备 › 高级, and `cudaOnly` restricts the same chooser for remote hosts. Detection comes from `main/services/engineMachine.ts` (nvidia-smi, `moss-infer-vulkan --list-devices`, sysfs gfx targets, the ROCm runtime).
- **Running jobs.** `main/services/cliEngine.ts` spawns one process per job with a FIFO per device, turns the program's stderr into the runner events `supervisor.ts` already handles, cancels by terminating the process (killed after 3 seconds if it is still there), and stops before the model loads when the program picked a different GPU than the job's. HIP device indices come from `moss-infer-hip --list-devices`.
- **What is hidden.** `cliEngineFeatures` (`shared/cliEngine.ts`) reports `preview`, `imageInput`, `control`, `references`, `hires`, `samplers` and `lora` as off, and `cli: 'vulkan' | 'hip'`. The Studio hides those inputs behind one note (`cliEngineNote`); `main/services/jobInputs.ts` refuses a job that still carries them, and `supervisor.ts` never routes such a job to a CLI GPU. The sampler is fixed to `euler` with the `moss` schedule.
- **Models.** The CLIs read a diffusers bundle folder whose DiT and text encoder are bf16. `cliBundleProblem` (from the catalog) and `cliBundleDtypeProblem` (from the safetensors headers, `main/services/cliEngine.ts`) refuse anything else and tell the user to download MOSS-Image (bf16).

ADR-0009 point 2 now reads: CUDA on NVIDIA is the full engine; Vulkan and HIP are reduced engines for other GPUs on Windows and Linux; macOS has no local inference. Points 1 and 3 to 8 stand.

### Consequences

- Good: AMD, Intel and old-driver NVIDIA owners can generate locally on the first run, and the app says in plain words why some inputs are missing.
- Good: one chooser, one install path and one verification path for every package. The renderer and the mock backend reuse `engineChoice.ts`.
- Bad: two engine kinds to test. The CLI path has its own E2E specs (`apps/desktop/e2e/specs/engineDetect.e2e.ts`, `studio-cli.e2e.ts`). Commit 84f55ce records Vulkan verified on a real RTX 4090; no run on a real AMD GPU is recorded.
- Bad: a user on 兼容模式 gets a smaller Studio (no 起始图, 遮罩, 控制图, 参考图, LoRA or 高清修复), slower runs, and only the bf16 bundle.
- Bad: every new engine feature must say which kinds support it (`EngineFeatures` in `shared/types.ts`).

## More information

- PR #26 (merge ab672fb, 2026-11-05): detection, chooser and CLI runner.
- The build matrix is documented in the engine repository, `mossimage-cpp/mossimage.cpp`; `shared/enginePackages.ts` quotes the facts it relies on.
- Amends [ADR-0009](0009-mossinfer-inference.md), point 2.
