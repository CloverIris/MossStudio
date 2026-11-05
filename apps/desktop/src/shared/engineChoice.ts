import {
  HIP_GFX_TARGETS,
  archRunsOn,
  driverMinimumLabel,
  driverSupports,
  engineAssetName,
  enginePackageId,
  packageExistsFor,
  parseEnginePackageId,
  type CudaArch,
  type CudaFlavour,
  type EngineOs,
  type EnginePackage,
} from './enginePackages'

/**
 * Which MossInfer package each GPU of a machine should run, from what was
 * detected on it and what a release publishes. Pure: the main process feeds
 * it the detection and the release, the renderer and the mock backend reuse it.
 *
 * Per GPU, first match wins (see the table in the engine-variants spec):
 * - NVIDIA with a CUDA kernel image (8.x, 12.x+): CUDA 13 when the driver
 *   allows, else CUDA 12, else Vulkan with an "update the driver" tip.
 * - NVIDIA 7.5: Windows CUDA 13 SM75 (driver ≥ R580), Linux CUDA 12 SM70.
 * - NVIDIA 7.0: Linux CUDA 12 SM70; Windows Vulkan.
 * - AMD gfx1100/1200/1201 on Linux: HIP with ROCm 7, else Vulkan + tip.
 * - Anything else: Vulkan if its probe says the device is usable.
 * - macOS: nothing runs locally.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other'

export interface EngineMachineGpu {
  /** The deviceUuid used everywhere: nvidia-smi's UUID, or `vk-<vendor>-<device>-<n>`. */
  id: string
  name: string
  vendor: GpuVendor
  /** `10de:2757` */
  pciId?: string
  memoryBytes?: number
  /** NVIDIA only. */
  computeCapability?: { major: number; minor: number }
  /** NVIDIA only, as nvidia-smi prints it. */
  driverVersion?: string
  /** From `moss-infer-vulkan --list-devices`; absent when Vulkan did not list this GPU. */
  vulkan?: { index: number; usable: boolean; reason?: string; kernels?: string; discrete: boolean; name?: string }
  /** AMD on Linux, from the KFD topology: `gfx1100`. */
  gfxTarget?: string
  /** Listed by an installed `moss-infer-hip --list-devices` (its own index). */
  hip?: { index: number; usable: boolean }
}

export interface EngineMachine {
  os: EngineOs
  gpus: EngineMachineGpu[]
  /** CUDA majors whose libraries are installed system-wide. */
  systemCuda: CudaFlavour[]
  /** ROCm 7's HIP runtime (libamdhip64.so.7) was found. */
  rocm7: boolean
  /**
   * This user may open /dev/kfd and a /dev/dri/renderD* (read+write). Absent
   * on older probes and hosts: then only a HIP listing of the GPU counts.
   */
  hipAccess?: boolean
  /** Whether `--list-devices` ran; when it did not, Vulkan usability is unknown. */
  vulkanProbed: boolean
}

/** A release reduced to what the chooser needs. Also used with the installed packages as the "release". */
export interface EngineAssetList {
  version: string
  assets: Array<{ name: string; size: number }>
}

export interface GpuEngineChoice {
  gpuId: string
  gpuName: string
  /** null: nothing in this release runs on this GPU. */
  package: EnginePackage | null
  packageId: string | null
  asset?: { name: string; size: number }
  /** Why, in plain words: "RTX 4090 使用 CUDA 13". */
  reason: string
  /** A quiet suggestion that would give a better package (driver update, ROCm). */
  tip?: string
  /** Every package of this release that runs on this GPU, best first (for the 高级 override). */
  compatible: EnginePackage[]
  /** The override in settings was ignored because it does not run on this GPU. */
  overrideIgnored?: boolean
  /** An integrated GPU left without an engine because a discrete GPU runs one (an override can still pick it). */
  integratedSkipped?: boolean
}

export interface EnginePlan {
  os: EngineOs
  version: string
  choices: GpuEngineChoice[]
  /** Distinct packages to install, with the GPUs that use each. */
  packages: Array<{ package: EnginePackage; packageId: string; asset: { name: string; size: number }; gpuIds: string[] }>
  totalBytes: number
  /** Set when nothing can run here at all (macOS, no GPU, no usable GPU). */
  blocked?: string
}

export interface ChooseOptions {
  /** deviceUuid → packageId from 设置 › 设备 › 高级. */
  overrides?: Record<string, string>
  /** Only consider CUDA builds (remote hosts run moss-server only). */
  cudaOnly?: boolean
}

const UPDATE_DRIVER_R580 = '把 NVIDIA 显卡驱动更新到 R580 或更新版本，可以使用更快的 CUDA 引擎。'
const ROCM_TIP = '安装 ROCm 7 可获得更快的原生支持。'
const HIP_ACCESS_TIP = '已安装 ROCm 7，但当前用户不能访问 /dev/kfd 或 /dev/dri/renderD*：把用户加入 render 和 video 组（sudo usermod -aG render,video $USER）后重新登录，即可使用更快的 AMD 原生引擎。'

function updateDriverTip(os: 'windows' | 'linux'): string {
  return `把 NVIDIA 显卡驱动更新到 ${driverMinimumLabel('cu12', os)} 或更新版本，可以使用更快的 CUDA 引擎。`
}

function assetIn(release: EngineAssetList, os: EngineOs, pkg: EnginePackage): { name: string; size: number } | undefined {
  if (os === 'macos' || !packageExistsFor(pkg, os)) return undefined
  const name = engineAssetName(release.version, os, pkg)
  return release.assets.find((asset) => asset.name === name)
}

/** The CUDA package for this flavour/arch, preferring the runtime the machine already has. */
function cudaCandidates(machine: EngineMachine, flavour: CudaFlavour, arch: CudaArch): EnginePackage[] {
  const system: EnginePackage = { kind: 'cuda', flavour, arch, runtime: 'system-cuda' }
  const bundled: EnginePackage = { kind: 'cuda', flavour, arch, runtime: 'bundled' }
  return machine.systemCuda.includes(flavour) ? [system, bundled] : [bundled, system]
}

interface Step {
  pkg: EnginePackage[]
  /** Reason shown when this step is picked. */
  reason: string
  /** Tip shown when this step is picked. */
  tip?: string
}

function vulkanUsable(machine: EngineMachine, gpu: EngineMachineGpu): boolean {
  if (gpu.vulkan) return gpu.vulkan.usable
  // Not listed by a probe that ran: Vulkan cannot use it.
  return !machine.vulkanProbed
}

/** Ordered candidate steps for one GPU: the table, row by row. */
function ladder(machine: EngineMachine, gpu: EngineMachineGpu): Step[] {
  const os = machine.os as 'windows' | 'linux'
  const name = gpu.name
  const vulkan = (reason: string, tip?: string): Step => ({ pkg: [{ kind: 'vulkan' }], reason, tip })
  const steps: Step[] = []
  if (gpu.vendor === 'nvidia' && gpu.computeCapability) {
    const cc = gpu.computeCapability
    const cu13 = driverSupports('cu13', os, gpu.driverVersion)
    const cu12 = driverSupports('cu12', os, gpu.driverVersion)
    const sm = `SM${cc.major}${cc.minor}`
    if (archRunsOn('standard', 'cu13', cc)) {
      if (cu13) steps.push({ pkg: cudaCandidates(machine, 'cu13', 'standard'), reason: `${name} 使用 CUDA 13 引擎` })
      if (cu12) {
        steps.push({
          pkg: cudaCandidates(machine, 'cu12', 'standard'),
          reason: `${name} 使用 CUDA 12 引擎（当前驱动 ${gpu.driverVersion} 还不支持 CUDA 13）`,
          tip: UPDATE_DRIVER_R580,
        })
      }
      steps.push(vulkan(
        `${name} 的显卡驱动${gpu.driverVersion ? `（${gpu.driverVersion}）` : ''}太旧，暂时使用兼容模式`,
        updateDriverTip(os),
      ))
    } else if (cc.major === 7 && cc.minor >= 5) {
      if (os === 'windows') {
        if (cu13) steps.push({ pkg: cudaCandidates(machine, 'cu13', 'sm75'), reason: `${name}（${sm}）使用 CUDA 13 的 SM75 引擎` })
        steps.push(vulkan(`${name}（${sm}）的 CUDA 引擎需要 R580 或更新的驱动，暂时使用兼容模式`, UPDATE_DRIVER_R580))
      } else {
        if (cu12) steps.push({ pkg: cudaCandidates(machine, 'cu12', 'sm70'), reason: `${name}（${sm}）使用 CUDA 12 的 SM70 引擎` })
        steps.push(vulkan(`${name}（${sm}）的显卡驱动太旧，暂时使用兼容模式`, updateDriverTip(os)))
      }
    } else if (cc.major === 7) {
      if (os === 'linux') {
        if (cu12) steps.push({ pkg: cudaCandidates(machine, 'cu12', 'sm70'), reason: `${name}（${sm}）使用 CUDA 12 的 SM70 引擎` })
        steps.push(vulkan(`${name}（${sm}）的显卡驱动太旧，暂时使用兼容模式`, updateDriverTip(os)))
      } else {
        steps.push(vulkan(`${name}（${sm}）在 Windows 上没有 CUDA 引擎，使用兼容模式`))
      }
    } else {
      steps.push(vulkan(`${name}（${sm}）没有对应的 CUDA 引擎，使用兼容模式`))
    }
  } else if (gpu.vendor === 'amd' && os === 'linux' && gpu.gfxTarget && (HIP_GFX_TARGETS as readonly string[]).includes(gpu.gfxTarget)) {
    // HIP only when it can really open the GPU: device nodes accessible, or moss-infer-hip lists it.
    const hipRuns = machine.rocm7 && (gpu.hip?.usable === true || (machine.hipAccess === true && gpu.hip?.usable !== false))
    if (hipRuns) steps.push({ pkg: [{ kind: 'hip' }], reason: `${name} 使用 AMD 原生引擎（ROCm）` })
    steps.push(vulkan(`${name} 使用兼容模式`, hipRuns ? undefined : machine.rocm7 ? HIP_ACCESS_TIP : ROCM_TIP))
  } else {
    steps.push(vulkan(`${name} 使用兼容模式`))
  }
  return steps
}

function usableStep(machine: EngineMachine, gpu: EngineMachineGpu, step: Step): boolean {
  return step.pkg[0]!.kind !== 'vulkan' || vulkanUsable(machine, gpu)
}

function unsupportedReason(machine: EngineMachine, gpu: EngineMachineGpu, cudaOnly: boolean): string {
  if (cudaOnly) {
    return gpu.vendor === 'nvidia' ? `${gpu.name} 没有可用的 CUDA 引擎` : `${gpu.name} 不是 NVIDIA 显卡，远程主机只能运行 CUDA 引擎`
  }
  if (gpu.vulkan && !gpu.vulkan.usable) return `${gpu.name} 不能运行引擎（${gpu.vulkan.reason ?? 'Vulkan 不可用'}）`
  return `${gpu.name} 不能运行引擎`
}

/** Plan for every GPU of a machine against one release. */
export function chooseEnginePackages(machine: EngineMachine, release: EngineAssetList, options: ChooseOptions = {}): EnginePlan {
  const version = release.version.replace(/^v/i, '')
  const plan: EnginePlan = { os: machine.os, version, choices: [], packages: [], totalBytes: 0 }
  const overridden = new Set<string>()
  if (machine.os === 'macos') {
    plan.blocked = 'macOS 上不能在本机运行推理引擎。可以在 设置 › 功能 中开启「远程主机」，用一台装有 NVIDIA 显卡的电脑生成。'
    return plan
  }
  if (machine.gpus.length === 0) {
    plan.blocked = '没有找到可以运行引擎的显卡。'
    return plan
  }
  for (const gpu of machine.gpus) {
    const steps = ladder(machine, gpu).filter((step) => !options.cudaOnly || step.pkg[0]!.kind === 'cuda')
    // Everything that runs here and is in the release, best first.
    const compatible: EnginePackage[] = []
    let picked: { pkg: EnginePackage; asset: { name: string; size: number }; step: Step } | null = null
    for (const step of steps) {
      if (!usableStep(machine, gpu, step)) continue
      for (const pkg of step.pkg) {
        const asset = assetIn(release, machine.os, pkg)
        if (!asset) continue
        compatible.push(pkg)
        if (!picked) picked = { pkg, asset, step }
      }
    }
    const choice: GpuEngineChoice = {
      gpuId: gpu.id,
      gpuName: gpu.name,
      package: null,
      packageId: null,
      reason: unsupportedReason(machine, gpu, options.cudaOnly === true),
      compatible,
    }
    const override = options.overrides?.[gpu.id]
    if (override) {
      const wanted = compatible.find((pkg) => enginePackageId(pkg) === override)
      if (wanted) {
        overridden.add(gpu.id)
        picked = { pkg: wanted, asset: assetIn(release, machine.os, wanted)!, step: { pkg: [wanted], reason: `${gpu.name} 使用你在高级设置里选的引擎` } }
      } else if (parseEnginePackageId(override)) {
        choice.overrideIgnored = true
      }
    }
    if (picked) {
      choice.package = picked.pkg
      choice.packageId = enginePackageId(picked.pkg)
      choice.asset = picked.asset
      choice.reason = picked.step.reason
      if (picked.step.tip) choice.tip = picked.step.tip
    } else if (!options.cudaOnly) {
      // Nothing usable: still say what would help.
      const tip = steps.find((step) => step.tip)?.tip
      if (tip) choice.tip = tip
    }
    plan.choices.push(choice)
  }
  // An integrated GPU is only worth the slow compatibility mode when nothing better is there:
  // with a discrete GPU that runs an engine, it gets none (unless chosen in 高级).
  const integrated = (gpuId: string): boolean => machine.gpus.find((gpu) => gpu.id === gpuId)?.vulkan?.discrete === false
  const discreteServed = plan.choices.some((choice) => choice.package && !integrated(choice.gpuId))
  if (discreteServed) {
    for (const choice of plan.choices) {
      if (!choice.package || choice.package.kind !== 'vulkan' || !integrated(choice.gpuId) || overridden.has(choice.gpuId)) continue
      choice.package = null
      choice.packageId = null
      delete choice.asset
      delete choice.tip
      choice.reason = `${choice.gpuName} 是集成显卡，已有独立显卡运行引擎，默认不使用它（可在 高级 › 每块 GPU 的引擎 里选用兼容模式）`
      choice.integratedSkipped = true
    }
  }
  for (const choice of plan.choices) {
    if (!choice.package || !choice.asset) continue
    const existing = plan.packages.find((item) => item.packageId === choice.packageId)
    if (existing) existing.gpuIds.push(choice.gpuId)
    else plan.packages.push({ package: choice.package, packageId: choice.packageId!, asset: choice.asset, gpuIds: [choice.gpuId] })
  }
  plan.totalBytes = plan.packages.reduce((sum, item) => sum + item.asset.size, 0)
  if (plan.packages.length === 0) {
    plan.blocked = plan.choices.length === 1 ? `${plan.choices[0]!.reason}。` : '这台电脑的显卡都不能运行引擎。'
  }
  return plan
}

/**
 * The installed packages as a release, so the same chooser answers "which
 * installed package does this GPU use" without a network call.
 */
export function installedAsRelease(os: Exclude<EngineOs, 'macos'>, packages: EnginePackage[]): EngineAssetList {
  const version = '0.0.0-installed'
  return { version, assets: packages.map((pkg) => ({ name: engineAssetName(version, os, pkg), size: 0 })) }
}

export function engineOsOf(platform: string): EngineOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
}
