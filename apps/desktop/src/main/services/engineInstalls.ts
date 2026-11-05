import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  chooseEnginePackages,
  engineOsOf,
  installedAsRelease,
  type EngineMachine,
  type EngineMachineGpu,
} from '@shared/engineChoice'
import { compareEngineTags, parseEngineStamp } from '@shared/engineUpdate'
import { allEnginePackages, enginePackageId, isCliEngine, type EnginePackage, type EnginePackageKind } from '@shared/enginePackages'
import type { GpuInventoryDevice, Settings } from '@shared/types'
import { engineBinaryPath, isManagedEngineDirectory } from '../lib/engineStore'
import { isInside, paths } from '../lib/paths'
import { readStoredMachineProbe, withLiveNvidia } from './engineMachine'
import { cachedGpuInventory } from './devices'
import { getSettings } from './settings'
import { releaseStaleMossInferRuntimes, resolveServerPath } from './mossInfer'

/**
 * Installed engine packages side by side (`<root>/stable-v2.2.0-cu13`,
 * `<root>/stable-v2.2.0-vulkan`, …) and which one each GPU runs.
 */

export interface InstalledEnginePackage {
  /** Folder name, e.g. `stable-v2.2.0-cu13-sm75-system-cuda`. */
  id: string
  packageId: string
  package: EnginePackage
  channel: 'stable' | 'dev'
  tag: string
  installDir: string
  binaryPath: string
  /** When the folder was installed (mtime), to order CI builds against releases. */
  installedAt: number
}

export interface DeviceEngine {
  deviceUuid: string
  package: EnginePackage
  packageId: string
  /** moss-server for CUDA, moss-infer-vulkan / moss-infer-hip for the CLIs. */
  binaryPath: string
  installDir: string
  /** Release tag, CI label, or `自定义` for an external moss-server. */
  version: string
  /** Index in `moss-infer-vulkan --list-devices`. */
  vulkanIndex?: number
  /** The name `--list-devices` printed for that index: a CLI reporting another device at the start means the order changed. */
  expectedVulkanName?: string
  gfxTarget?: string
  /** Extra environment for the process, e.g. LD_LIBRARY_PATH when ROCm 7 is not in /opt/rocm/lib. */
  env?: Record<string, string>
}

export function listInstalledEnginePackages(root = paths.mossinfer()): InstalledEnginePackage[] {
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const installed = entries.flatMap((name): InstalledEnginePackage[] => {
    const stamp = parseEngineStamp(name)
    if (!stamp) return []
    const installDir = join(root, name)
    const binaryPath = engineBinaryPath(installDir, stamp.package.kind)
    if (!existsSync(binaryPath)) return []
    let installedAt = 0
    try { installedAt = statSync(installDir).mtimeMs } catch { /* just listed */ }
    return [{ id: name, packageId: stamp.packageId, package: stamp.package, channel: stamp.channel, tag: stamp.tag, installDir, binaryPath, installedAt }]
  })
  return installed.sort(newerFirst)
}

/**
 * Releases compare by tag; a CI build has no comparable version, so it
 * compares with anything by when it was installed (the later install wins).
 */
function newerFirst(a: InstalledEnginePackage, b: InstalledEnginePackage): number {
  if (a.channel === 'stable' && b.channel === 'stable') {
    return compareEngineTags(b.tag, a.tag) || a.id.localeCompare(b.id)
  }
  return b.installedAt - a.installedAt || a.id.localeCompare(b.id)
}

/** The newest install of each package id (newest stable vs newest CI build: the later install). */
export function newestPerPackage(installed: InstalledEnginePackage[]): Map<string, InstalledEnginePackage> {
  const newest = new Map<string, InstalledEnginePackage>()
  for (const item of installed) {
    const known = newest.get(item.packageId)
    if (!known || newerFirst(item, known) < 0) newest.set(item.packageId, item)
  }
  return newest
}

/** A machine from the GPU inventory alone, for when the machine probe never ran (Vulkan usability unknown). */
export function machineFromInventory(platform: NodeJS.Platform, devices: GpuInventoryDevice[]): EngineMachine {
  const os = engineOsOf(platform)
  const gpus: EngineMachineGpu[] = devices.map((device) => ({
    id: device.uuid,
    name: device.name,
    vendor: device.vendor ?? 'nvidia',
    ...(device.pciId ? { pciId: device.pciId } : {}),
    ...(device.memoryTotalBytes ? { memoryBytes: device.memoryTotalBytes } : {}),
    ...(device.computeCapability ? { computeCapability: device.computeCapability } : {}),
    ...(device.driverVersion ? { driverVersion: device.driverVersion } : {}),
    ...(device.gfxTarget ? { gfxTarget: device.gfxTarget } : {}),
  }))
  return { os, gpus, systemCuda: [], rocm7: false, vulkanProbed: false }
}

export interface ResolveInput {
  platform: NodeJS.Platform
  machine: EngineMachine
  installed: InstalledEnginePackage[]
  settings: Pick<Settings, 'engineDeviceOverrides' | 'mossInferServerPath'>
  /** Managed engine root, to tell a pinned managed install from an external moss-server. */
  root: string
  rocmLibDir?: string
  /** A moss-server found outside the managed folder (MOSS_SERVER, the app bundle, PATH) for NVIDIA GPUs nothing else serves. */
  fallbackServerPath?: () => string | null
  exists?: (path: string) => boolean
}

/** A GPU nvidia-smi lists but the machine probe does not know yet (new card): treat it like an NVIDIA GPU. */
function gpuFor(machine: EngineMachine, deviceUuid: string): EngineMachineGpu | undefined {
  return machine.gpus.find((gpu) => gpu.id === deviceUuid)
}

/**
 * Pure: which installed package this GPU runs.
 * 1. A pinned moss-server (`mossInferServerPath`: an older version picked by
 *    hand, or a custom engine) serves the NVIDIA GPUs it can run on.
 * 2. Otherwise the chooser picks among the newest installed packages, honouring
 *    the per-GPU override from 设置 › 设备 › 高级.
 */
export function resolveDeviceEngineFrom(deviceUuid: string, input: ResolveInput): DeviceEngine | null {
  const exists = input.exists ?? existsSync
  const gpu = gpuFor(input.machine, deviceUuid)
  if (!gpu) return null
  const os = input.machine.os
  if (os === 'macos') return null
  const newest = newestPerPackage(input.installed)
  const pinned = input.settings.mossInferServerPath
  if (pinned && exists(pinned) && gpu.vendor === 'nvidia') {
    const managed = isInside(input.root, pinned)
      ? input.installed.find((item) => resolve(item.binaryPath) === resolve(pinned))
      : undefined
    const pinnedPackage = managed?.package
    const runs = !pinnedPackage || chooseEnginePackages(input.machine, installedAsRelease(os, [pinnedPackage]))
      .choices.find((choice) => choice.gpuId === gpu.id)?.package
    if (runs) {
      return {
        deviceUuid,
        package: pinnedPackage ?? { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'bundled' },
        packageId: managed?.packageId ?? 'custom',
        binaryPath: pinned,
        installDir: resolve(pinned, '..', '..'),
        version: managed?.tag ?? '自定义',
        ...(gpu.vulkan ? { vulkanIndex: gpu.vulkan.index, ...(gpu.vulkan.name ? { expectedVulkanName: gpu.vulkan.name } : {}) } : {}),
      }
    }
  }
  const packages = [...newest.values()].map((item) => item.package)
  const plan = packages.length
    ? chooseEnginePackages(input.machine, installedAsRelease(os, packages), { overrides: input.settings.engineDeviceOverrides })
    : null
  const choice = plan?.choices.find((item) => item.gpuId === gpu.id)
  const install = choice?.package ? newest.get(enginePackageId(choice.package)) : undefined
  if (!install) {
    const fallback = gpu.vendor === 'nvidia' ? input.fallbackServerPath?.() : null
    if (!fallback || !exists(fallback)) return null
    return {
      deviceUuid,
      package: { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'bundled' },
      packageId: 'custom',
      binaryPath: fallback,
      installDir: resolve(fallback, '..', '..'),
      version: '自定义',
      ...(gpu.vulkan ? { vulkanIndex: gpu.vulkan.index, ...(gpu.vulkan.name ? { expectedVulkanName: gpu.vulkan.name } : {}) } : {}),
    }
  }
  if (!choice?.package) return null
  const env: Record<string, string> = {}
  if (choice.package.kind === 'hip' && input.rocmLibDir && input.rocmLibDir !== '/opt/rocm/lib') {
    env['LD_LIBRARY_PATH'] = [input.rocmLibDir, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(':')
  }
  return {
    deviceUuid,
    package: install.package,
    packageId: install.packageId,
    binaryPath: install.binaryPath,
    installDir: install.installDir,
    version: install.tag,
    ...(gpu.vulkan ? { vulkanIndex: gpu.vulkan.index, ...(gpu.vulkan.name ? { expectedVulkanName: gpu.vulkan.name } : {}) } : {}),
    ...(gpu.gfxTarget ? { gfxTarget: gpu.gfxTarget } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  }
}

/** The machine as last probed, or built from the GPU inventory when the probe has not run yet. */
export function currentEngineMachine(): { machine: EngineMachine; rocmLibDir?: string } {
  const stored = readStoredMachineProbe(paths.mossinfer())
  const inventory = cachedGpuInventory()?.devices ?? []
  if (!stored) return { machine: machineFromInventory(process.platform, inventory) }
  // The live driver and compute capability win over the stored probe; NVIDIA GPUs plugged in after it still count.
  const live = withLiveNvidia(stored.machine, inventory.filter((device) => (device.vendor ?? 'nvidia') === 'nvidia'))
  const missing = inventory.filter((device) => (device.vendor ?? 'nvidia') === 'nvidia' && !live.gpus.some((gpu) => gpu.id === device.uuid))
  const machine = missing.length
    ? { ...live, gpus: [...live.gpus, ...machineFromInventory(process.platform, missing).gpus] }
    : live
  return { machine, ...(stored.rocmLibDir ? { rocmLibDir: stored.rocmLibDir } : {}) }
}

/** MOSS_SERVER, the app bundle or PATH (mossInfer.ts resolveServerPath), unless that is a managed install. */
function legacyServerPath(): string | null {
  const path = resolveServerPath({ ...getSettings(), mossInferServerPath: null })
  return path && !isInside(paths.mossinfer(), path) ? path : null
}

/** Which installed package this GPU runs, or null when none is installed for it. */
export function resolveDeviceEngine(deviceUuid: string): DeviceEngine | null {
  const { machine, rocmLibDir } = currentEngineMachine()
  return resolveDeviceEngineFrom(deviceUuid, {
    platform: process.platform,
    machine,
    installed: listInstalledEnginePackages(),
    settings: getSettings(),
    root: paths.mossinfer(),
    fallbackServerPath: legacyServerPath,
    ...(rocmLibDir ? { rocmLibDir } : {}),
  })
}

/**
 * The moss-server for this GPU: its own CUDA install (resolveDeviceEngine), or,
 * without a GPU, the first GPU's CUDA install. Falls back to a pinned / custom
 * moss-server, MOSS_SERVER, the app bundle or PATH (resolveServerPath). Null
 * when the GPU runs a CLI engine or nothing serves it.
 */
export function localServerPath(deviceUuid?: string): string | null {
  if (deviceUuid) {
    const own = resolveDeviceEngine(deviceUuid)
    if (own) return own.package.kind === 'cuda' ? own.binaryPath : null
  } else {
    const first = deviceEngines().find(({ engine }) => engine?.package.kind === 'cuda')?.engine
    if (first) return first.binaryPath
  }
  return resolveServerPath(getSettings())
}

/** Every local GPU with the package it runs (null = nothing installed that runs on it). */
export function deviceEngines(): Array<{ gpu: EngineMachineGpu; engine: DeviceEngine | null }> {
  const { machine } = currentEngineMachine()
  return machine.gpus.map((gpu) => ({ gpu, engine: resolveDeviceEngine(gpu.id) }))
}

/** True for a CLI package (Vulkan / HIP): one job per process, text-to-image only. */
export function deviceRunsCli(deviceUuid: string): boolean {
  const engine = resolveDeviceEngine(deviceUuid)
  return Boolean(engine && isCliEngine(engine.package))
}

/**
 * Which engine kinds this computer's GPUs run: the installed packages they use,
 * or, before anything is installed, what the chooser would give them. Onboarding
 * uses it to ask a Vulkan / HIP-only machine for the bf16 model bundle.
 */
export function localEngineKinds(): EnginePackageKind[] {
  const resolved = deviceEngines().flatMap(({ engine }) => (engine && engine.packageId !== 'custom' ? [engine.package.kind] : []))
  if (resolved.length) return [...new Set(resolved)]
  const { machine } = currentEngineMachine()
  if (machine.os === 'macos' || machine.gpus.length === 0) return []
  const plan = chooseEnginePackages(machine, installedAsRelease(machine.os, allEnginePackages(machine.os)), { overrides: getSettings().engineDeviceOverrides })
  return [...new Set(plan.packages.map((item) => item.package.kind))]
}

/**
 * Whether a settings change can move a GPU to another engine (its per-GPU
 * choice or the pinned moss-server changed): then the moss-servers that no
 * longer match are released right away (mossInfer.releaseStaleMossInferRuntimes).
 */
export function engineChoiceChanged(
  before: Pick<Settings, 'engineDeviceOverrides' | 'mossInferServerPath'>,
  after: Pick<Settings, 'engineDeviceOverrides' | 'mossInferServerPath'>,
): boolean {
  const overrides = (value: Record<string, string> | undefined) => JSON.stringify(Object.entries(value ?? {}).sort())
  return overrides(before.engineDeviceOverrides) !== overrides(after.engineDeviceOverrides)
    || (before.mossInferServerPath ?? null) !== (after.mossInferServerPath ?? null)
}

/** After a settings update: free the moss-servers of GPUs whose engine choice just changed. True when it did. */
export function releaseAfterSettingsChange(
  before: Pick<Settings, 'engineDeviceOverrides' | 'mossInferServerPath'>,
  after: Pick<Settings, 'engineDeviceOverrides' | 'mossInferServerPath'>,
): boolean {
  if (!engineChoiceChanged(before, after)) return false
  void releaseStaleMossInferRuntimes().catch(() => undefined)
  return true
}

