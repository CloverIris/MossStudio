import { chooseEnginePackages, engineOsOf, installedAsRelease, type EngineAssetList, type EngineMachine } from '@shared/engineChoice'
import { compareEngineTags } from '@shared/engineUpdate'
import { allEnginePackages, engineAssetName, enginePackageId, parseEnginePackageId, type EnginePackage } from '@shared/enginePackages'
import { Events } from '@shared/channels'
import { emit } from '../lib/events'
import type { EnginePlanView, GpuInventoryDevice, MossInferDownloadState } from '@shared/types'
import type { ActivationGate } from '../lib/engineActivation'
import { paths } from '../lib/paths'
import { run } from '../lib/run'
import { cachedGpuInventory, scanNvidiaGpus, refreshGpuInventory } from './devices'
import { listInstalledEnginePackages, newestPerPackage } from './engineInstalls'
import {
  fsProbe,
  nvidiaSetChanged,
  probeEngineMachine,
  readStoredMachineProbe,
  storeMachineProbe,
  type MachineProbeDeps,
  type StoredMachineProbe,
} from './engineMachine'
import { invalidateEngineReadiness } from './engineReadiness'
import { downloadMossInfer, ensureVulkanProbe, fetchEngineRelease, type EngineRelease } from './mossInferDownload'
import { getSettings, legacyEngineVariant, updateSettings } from './settings'
import { releaseStaleMossInferRuntimes } from './mossInfer'
import { detectSystemCuda } from './systemCuda'

/**
 * Ties detection, the chooser and the downloader together:
 * - detect the machine (downloading the small Vulkan package as the probe),
 * - plan which package each GPU gets from the latest (or a chosen) release,
 * - install the packages that are not there yet.
 */

/** A probe is reused for this long; 重新检测 / Setup's first look refresh it. */
const MACHINE_TTL_MS = 10 * 60_000

function defaultDeps(release: EngineRelease | null): MachineProbeDeps {
  return {
    platform: process.platform,
    run: (file, args, timeoutMs, env) => run(file, args, { timeoutMs, ...(env ? { env } : {}) }),
    ...fsProbe,
    hipBinary: () => newestPerPackage(listInstalledEnginePackages()).get('hip')?.binaryPath ?? null,
    nvidia: async () => (await scanNvidiaGpus()).devices,
    systemCuda: async () => (await detectSystemCuda()).flavours,
    vulkanBinary: async () => {
      const installed = newestPerPackage(listInstalledEnginePackages()).get('vulkan')
      if (installed) return installed.binaryPath
      return release ? ensureVulkanProbe(release) : null
    },
  }
}

/**
 * The old global 「内置 CUDA」 setting (settings.ts keeps it until now): each
 * NVIDIA GPU that gets a CUDA package is pinned to its bundled-runtime build.
 * Kept for later when the probe saw no GPU at all.
 */
export function applyLegacyBundledChoice(root: string, machine: EngineMachine): void {
  if (machine.os === 'macos' || machine.gpus.length === 0 || !legacyEngineVariant(root)) return
  const settings = getSettings()
  const overrides = { ...settings.engineDeviceOverrides }
  const plan = chooseEnginePackages(machine, installedAsRelease(machine.os, allEnginePackages(machine.os)), { overrides })
  for (const choice of plan.choices) {
    if (choice.package?.kind !== 'cuda' || overrides[choice.gpuId]) continue
    overrides[choice.gpuId] = enginePackageId({ ...choice.package, runtime: 'bundled' })
  }
  emit(Events.settingsChanged, updateSettings({ engineDeviceOverrides: overrides }))
  legacyEngineVariant(root, true)
  void releaseStaleMossInferRuntimes().catch(() => undefined)
}

let probing: Promise<StoredMachineProbe> | null = null

/** The machine, probed again when asked or when the last probe is old. */
export async function detectEngineMachine(
  options: { refresh?: boolean; release?: EngineRelease | null; deps?: MachineProbeDeps; liveNvidia?: GpuInventoryDevice[] } = {},
): Promise<StoredMachineProbe> {
  const root = paths.mossinfer()
  const stored = readStoredMachineProbe(root)
  const fresh = stored && Date.now() - Date.parse(stored.probedAt) < MACHINE_TTL_MS
  // A probe that could not run Vulkan is redone once a release (and so the probe package) is at hand.
  // (Only when there is a release now: offline, macOS or headless it would re-probe on every call.)
  const incomplete = stored && !stored.machine.vulkanProbed && Boolean(options.release) && stored.machine.os !== 'macos'
  // A card added or removed since the probe (nvidia-smi already knows): probe again.
  const changed = stored && options.liveNvidia !== undefined && nvidiaSetChanged(stored.machine, options.liveNvidia)
  if (stored && fresh && !options.refresh && !incomplete && !changed) return stored
  if (probing) return probing
  probing = (async () => {
    const probe = await probeEngineMachine(options.deps ?? defaultDeps(options.release ?? null))
    const next = storeMachineProbe(root, probe)
    applyLegacyBundledChoice(root, next.machine)
    invalidateEngineReadiness()
    // New AMD / Intel GPUs and Vulkan indexes show up in the GPU inventory.
    await refreshGpuInventory().catch(() => undefined)
    return next
  })()
  try {
    return await probing
  } finally {
    probing = null
  }
}

function assetList(machine: EngineMachine, release: EngineRelease | null): EngineAssetList {
  if (release) return { version: release.version, assets: release.assets.map(({ name, size }) => ({ name, size })) }
  const os = machine.os === 'windows' ? 'windows' : 'linux'
  return { version: 'dev', assets: allEnginePackages(os).map((pkg) => ({ name: engineAssetName('dev', os, pkg), size: 0 })) }
}

/** What Setup and 设置 › 设备 show: the detection, the plan and what is already installed. */
export function planView(stored: StoredMachineProbe, release: EngineRelease | null, channel: 'stable' | 'dev'): EnginePlanView {
  const settings = getSettings()
  const plan = chooseEnginePackages(stored.machine, assetList(stored.machine, release), { overrides: settings.engineDeviceOverrides })
  const installed = newestPerPackage(listInstalledEnginePackages())
  const upToDate = (packageId: string): boolean => {
    const item = installed.get(packageId)
    if (!item) return false
    // A dev plan is satisfied by any install of the package; a stable one by this release (or newer).
    return channel === 'dev' || !release || item.channel === 'dev' || compareEngineTags(item.tag, release.tag) >= 0
  }
  return {
    ...plan,
    channel,
    releaseTag: release?.tag ?? null,
    machine: stored.machine,
    probedAt: stored.probedAt,
    notes: stored.notes,
    installed: [...installed.keys()],
    missing: plan.packages.filter((item) => !upToDate(item.packageId)).map((item) => item.packageId),
  }
}

/** Detect (fresh when asked), fetch the release, and plan. Offline: plan against what is installed. */
export async function getEnginePlan(options: { refresh?: boolean; releaseTag?: string; channel?: 'stable' | 'dev' } = {}): Promise<EnginePlanView> {
  const channel = options.channel ?? getSettings().mossInferChannel
  let release: EngineRelease | null = null
  let releaseError: string | undefined
  try {
    release = await fetchEngineRelease(options.releaseTag)
  } catch (error) {
    releaseError = error instanceof Error ? error.message : String(error)
  }
  const live = cachedGpuInventory()?.devices
  const stored = await detectEngineMachine({ refresh: options.refresh, release, ...(live ? { liveNvidia: live } : {}) })
  const view = planView(stored, release, channel)
  return releaseError ? { ...view, releaseError } : view
}

export interface InstallPlanRequest {
  channel: 'stable' | 'dev'
  releaseTag?: string
  cudaWheels?: boolean
  /** Install exactly these packages instead of what the plan is missing. */
  packages?: EnginePackage[]
  /** Reinstall every planned package, not only the missing ones. */
  all?: boolean
  activation?: Omit<ActivationGate, 'signal'>
}

/** Install what the plan says this machine needs (or the given packages). */
export async function installEnginePlan(request: InstallPlanRequest): Promise<MossInferDownloadState> {
  let release: EngineRelease | null = null
  if (request.channel === 'stable') {
    try {
      release = await fetchEngineRelease(request.releaseTag)
    } catch (error) {
      if (request.releaseTag) throw error
      release = null // no release yet: the downloader falls back to CI artifacts
    }
  }
  // The probe Setup / 设置 just showed (re-probed when it is old).
  const stored = await detectEngineMachine({ release })
  const view = planView(stored, release, request.channel)
  if (!request.packages && view.blocked) throw new Error(view.blocked)
  const packages = request.packages ?? view.packages
    .filter((item) => request.all || request.releaseTag || view.missing.includes(item.packageId))
    .map((item) => item.package)
  const targets = Object.fromEntries(view.packages.map((item) => [item.packageId, item.gpuIds]))
  const os = engineOsOf(process.platform)
  const rocm = stored.rocmLibDir && stored.rocmLibDir !== '/opt/rocm/lib' ? { LD_LIBRARY_PATH: stored.rocmLibDir } : undefined
  if (packages.length === 0) {
    // Everything planned is installed already: report done without downloading.
    return {
      channel: request.channel, phase: 'done', bytes: 0, totalBytes: 0, percent: 100, speedBps: 0,
      packages: view.installed, note: os === 'macos' ? undefined : '引擎已是最新', updatedAt: new Date().toISOString(),
    }
  }
  return downloadMossInfer({
    channel: request.channel,
    packages,
    ...(request.releaseTag ? { releaseTag: request.releaseTag } : {}),
    release,
    cudaWheels: request.cudaWheels,
    targets,
    ...(rocm ? { env: { hip: rocm } } : {}),
    ...(request.activation ? { activation: request.activation } : {}),
  })
}

/** For IPC: package ids → packages, rejecting unknown ids. */
export function packagesFromIds(ids: string[] | undefined): EnginePackage[] | undefined {
  if (!ids) return undefined
  return ids.map((id) => {
    const pkg = parseEnginePackageId(id)
    if (!pkg) throw new Error(`未知的引擎包：${id}`)
    return pkg
  })
}

/**
 * At start-up: scan nvidia-smi first, so a card added or removed since the
 * last probe triggers a new one, then plan (offline: plan against what is installed).
 */
export async function startupEnginePlan(): Promise<EnginePlanView> {
  await scanNvidiaGpus().catch(() => undefined)
  return getEnginePlan()
}

