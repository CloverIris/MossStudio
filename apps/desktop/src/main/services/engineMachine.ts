import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
// sysfs paths are Linux paths: posix joins, whatever the host's separator.
import { join, posix } from 'node:path'
import type { CudaFlavour } from '@shared/enginePackages'
import { engineOsOf, type EngineMachine, type EngineMachineGpu, type GpuVendor } from '@shared/engineChoice'
import type { GpuInventoryDevice } from '@shared/types'
import { drmPciId, hasRocm7Runtime, kfdGpuNodes, type KfdGpuNode } from '../lib/amdGpus'
import { parseVulkanDeviceList, vulkanGpus, type VulkanDevice } from '../lib/vulkanDevices'
import { parseHipDeviceList, type HipDevice } from '../lib/cliProtocol'
import type { RunResult } from '../lib/run'

/**
 * What this computer has for the engine chooser: every GPU (NVIDIA from
 * nvidia-smi, all vendors from `moss-infer-vulkan --list-devices`, AMD gfx
 * targets from the KFD topology), the system CUDA libraries and ROCm 7.
 *
 * Every probe runs a program with an argument array and a timeout, and a
 * failing probe only removes what it would have added.
 */

export interface MachineProbeDeps {
  platform: NodeJS.Platform
  run: (file: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<RunResult>
  readFile: (path: string) => string | null
  readdir: (path: string) => string[]
  exists: (path: string) => boolean
  /** Whether this process may read and write the device node (ROCm needs /dev/kfd and a /dev/dri/renderD*). */
  readWrite: (path: string) => boolean
  /** An installed moss-infer-hip to ask `--list-devices`, when there is one. */
  hipBinary?: () => string | null
  /** NVIDIA GPUs from the GPU inventory (nvidia-smi). */
  nvidia: () => Promise<GpuInventoryDevice[]>
  /** CUDA majors with system libraries (systemCuda.ts). */
  systemCuda: () => Promise<CudaFlavour[]>
  /** Path of a moss-infer-vulkan to probe with (downloading the small package if needed); null when none. */
  vulkanBinary: () => Promise<string | null>
}

export interface MachineProbe {
  machine: EngineMachine
  /** Raw Vulkan devices, CPU rasterizers included. */
  vulkanDevices: VulkanDevice[]
  /** Where libamdhip64.so.7 was found, when ROCm 7 is present. */
  rocmLibDir?: string
  /** Probes that failed, for diagnostics. */
  notes: string[]
}

const NVIDIA = 0x10de
const AMD = 0x1002
const INTEL = 0x8086

function vendorOf(vendorId: number): GpuVendor {
  if (vendorId === NVIDIA) return 'nvidia'
  if (vendorId === AMD) return 'amd'
  if (vendorId === INTEL) return 'intel'
  return 'other'
}

function vendorIdOf(pciId: string | undefined): number | null {
  const match = /^([0-9a-f]{4}):/.exec(pciId ?? '')
  return match ? Number.parseInt(match[1]!, 16) : null
}

/** Stable id for a GPU nvidia-smi does not list: `vk-1002-744c-0` (n = ordinal among the same PCI id). */
export function nonNvidiaGpuId(pciId: string, ordinal: number): string {
  return `vk-${pciId.replace(':', '-')}-${ordinal}`
}

function vulkanInfo(device: VulkanDevice): NonNullable<EngineMachineGpu['vulkan']> {
  return {
    index: device.index,
    usable: device.usable,
    discrete: device.discrete,
    name: device.name,
    ...(device.kernels ? { kernels: device.kernels } : {}),
    ...(device.reason ? { reason: device.reason } : {}),
  }
}

/** Pairs nvidia-smi rows with Vulkan devices: by PCI id in order, then by name, then by order. */
function matchNvidia(nvidia: GpuInventoryDevice[], vulkan: VulkanDevice[]): Map<string, VulkanDevice> {
  const pool = vulkan.filter((device) => device.vendorId === NVIDIA)
  const matches = new Map<string, VulkanDevice>()
  const take = (device: GpuInventoryDevice, found: VulkanDevice | undefined): void => {
    if (!found) return
    matches.set(device.uuid, found)
    pool.splice(pool.indexOf(found), 1)
  }
  const ordered = [...nvidia].sort((a, b) => a.index - b.index)
  for (const device of ordered)
    if (device.pciId)
      take(
        device,
        pool.find((candidate) => candidate.pciId === device.pciId),
      )
  for (const device of ordered)
    if (!matches.has(device.uuid))
      take(
        device,
        pool.find((candidate) => candidate.name === device.name),
      )
  for (const device of ordered) if (!matches.has(device.uuid)) take(device, pool[0])
  return matches
}

async function probeVulkan(deps: MachineProbeDeps, notes: string[]): Promise<VulkanDevice[] | null> {
  let binary: string | null
  try {
    binary = await deps.vulkanBinary()
  } catch (error) {
    notes.push(`Vulkan 探测程序不可用：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!binary) {
    notes.push('没有 Vulkan 探测程序')
    return null
  }
  const result = await deps.run(binary, ['--list-devices'], 15_000)
  if (result.code !== 0) {
    notes.push(
      `moss-infer-vulkan --list-devices 失败（${result.timedOut ? '超时' : `退出码 ${result.code}`}）：${result.stderr.trim().slice(0, 300)}`,
    )
    return null
  }
  return parseVulkanDeviceList(result.stdout)
}

/** What an installed moss-infer-hip lists (its own device order); empty without one or when it fails. */
async function probeHip(deps: MachineProbeDeps, rocmLibDir: string, notes: string[]): Promise<HipDevice[]> {
  const binary = deps.hipBinary?.() ?? null
  if (!binary) return []
  const env = rocmLibDir !== '/opt/rocm/lib' ? { LD_LIBRARY_PATH: rocmLibDir } : undefined
  const result = await deps.run(binary, ['--list-devices'], 15_000, env)
  if (result.code !== 0) {
    notes.push(
      `moss-infer-hip --list-devices 失败（${result.timedOut ? '超时' : `退出码 ${result.code}`}）：${result.stderr.trim().slice(0, 300)}`,
    )
    return []
  }
  return parseHipDeviceList(result.stdout)
}

function readKfd(deps: MachineProbeDeps): KfdGpuNode[] {
  const base = '/sys/class/kfd/kfd/topology/nodes'
  const nodes: Array<{ node: number; properties: string }> = []
  for (const name of deps.readdir(base)) {
    if (!/^\d+$/.test(name)) continue
    const properties = deps.readFile(posix.join(base, name, 'properties'))
    if (properties) nodes.push({ node: Number(name), properties })
  }
  return kfdGpuNodes(nodes)
}

/** PCI ids of the display devices the kernel knows (`/sys/class/drm/card<n>/device`), in card order. */
function readDrm(deps: MachineProbeDeps): string[] {
  const base = '/sys/class/drm'
  return deps
    .readdir(base)
    .filter((name) => /^card\d+$/.test(name))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .flatMap((name) => {
      const vendor = deps.readFile(posix.join(base, name, 'device', 'vendor'))
      const device = deps.readFile(posix.join(base, name, 'device', 'device'))
      const pciId = vendor && device ? drmPciId(vendor, device) : null
      return pciId ? [pciId] : []
    })
}

/** ldconfig is often not on a desktop user's PATH. */
const LDCONFIG = ['ldconfig', '/sbin/ldconfig', '/usr/sbin/ldconfig']

async function probeRocm(deps: MachineProbeDeps): Promise<string | undefined> {
  for (const file of LDCONFIG) {
    const ld = await deps.run(file, ['-p'], 6000)
    if (ld.code !== 0) continue
    if (hasRocm7Runtime(ld.stdout)) {
      const line = ld.stdout.split(/\r?\n/).find((row) => /libamdhip64\.so\.7\b/.test(row))
      const path = line?.split('=>').at(-1)?.trim()
      if (path) return path.slice(0, path.lastIndexOf('/')) || '/'
    }
    break
  }
  const roots = [
    '/opt/rocm',
    ...deps
      .readdir('/opt')
      .filter((name) => /^rocm[-.\d]*$/.test(name))
      .map((name) => `/opt/${name}`),
  ]
  for (const root of [...new Set(roots)]) {
    for (const lib of ['lib', 'lib64']) {
      const dir = `${root}/${lib}`
      if (deps.exists(`${dir}/libamdhip64.so.7`)) return dir
    }
  }
  return undefined
}

export async function probeEngineMachine(deps: MachineProbeDeps): Promise<MachineProbe> {
  const os = engineOsOf(deps.platform)
  const notes: string[] = []
  if (os === 'macos') {
    return { machine: { os, gpus: [], systemCuda: [], rocm7: false, hipAccess: false, vulkanProbed: false }, vulkanDevices: [], notes }
  }
  const [nvidia, systemCuda, vulkanList] = await Promise.all([
    deps.nvidia().catch((error: unknown) => {
      notes.push(`nvidia-smi：${error instanceof Error ? error.message : String(error)}`)
      return [] as GpuInventoryDevice[]
    }),
    deps.systemCuda().catch(() => [] as CudaFlavour[]),
    probeVulkan(deps, notes),
  ])
  const vulkan = vulkanGpus(vulkanList ?? [])
  const kfd = os === 'linux' ? readKfd(deps) : []
  const rocmLibDir = os === 'linux' ? await probeRocm(deps) : undefined

  // ROCm needs read+write on /dev/kfd and a render node; without them (not in the render/video group) HIP cannot start.
  const hipAccess =
    os === 'linux' &&
    Boolean(rocmLibDir) &&
    deps.readWrite('/dev/kfd') &&
    deps.readdir('/dev/dri').some((name) => /^renderD\d+$/.test(name) && deps.readWrite(`/dev/dri/${name}`))
  const hipListed = os === 'linux' && rocmLibDir ? await probeHip(deps, rocmLibDir, notes) : []

  const gpus: EngineMachineGpu[] = []
  const nvidiaMatches = matchNvidia(nvidia, vulkan)
  for (const device of [...nvidia].sort((a, b) => a.index - b.index)) {
    const vk = nvidiaMatches.get(device.uuid)
    gpus.push({
      id: device.uuid,
      name: device.name,
      vendor: 'nvidia',
      ...((device.pciId ?? vk?.pciId) ? { pciId: device.pciId ?? vk!.pciId } : {}),
      ...(device.memoryTotalBytes ? { memoryBytes: device.memoryTotalBytes } : {}),
      ...(device.computeCapability ? { computeCapability: device.computeCapability } : {}),
      ...(device.driverVersion ? { driverVersion: device.driverVersion } : {}),
      ...(vk ? { vulkan: vulkanInfo(vk) } : {}),
    })
  }

  // Everything else Vulkan lists. An NVIDIA GPU nvidia-smi did not list (no driver tools) still counts.
  const ordinals = new Map<string, number>()
  const nextId = (pciId: string): string => {
    const ordinal = ordinals.get(pciId) ?? 0
    ordinals.set(pciId, ordinal + 1)
    return nonNvidiaGpuId(pciId, ordinal)
  }
  const kfdPool = [...kfd]
  const matched = new Set(nvidiaMatches.values())
  for (const device of vulkan) {
    if (matched.has(device)) continue
    const vendor = vendorOf(device.vendorId)
    const node = vendor === 'amd' ? kfdPool.find((candidate) => candidate.pciId === device.pciId) : undefined
    if (node) kfdPool.splice(kfdPool.indexOf(node), 1)
    gpus.push({
      id: nextId(device.pciId),
      name: device.name,
      vendor,
      pciId: device.pciId,
      vulkan: vulkanInfo(device),
      ...(node ? { gfxTarget: node.gfxTarget } : {}),
    })
  }

  if (!vulkanList) {
    // No Vulkan probe: AMD GPUs from the KFD topology, other non-NVIDIA cards from DRM, usability unknown.
    for (const node of kfdPool.filter((candidate) => candidate.vendorId === AMD)) {
      gpus.push({
        id: nextId(node.pciId),
        name: `AMD 显卡（${node.gfxTarget}）`,
        vendor: 'amd',
        pciId: node.pciId,
        gfxTarget: node.gfxTarget,
      })
    }
    const known = new Set(gpus.map((gpu) => gpu.pciId))
    for (const pciId of os === 'linux' ? readDrm(deps) : []) {
      const vendorId = vendorIdOf(pciId)
      if (vendorId === null || vendorId === NVIDIA || known.has(pciId)) continue
      const vendor = vendorOf(vendorId)
      gpus.push({ id: nextId(pciId), name: vendor === 'intel' ? 'Intel 显卡' : vendor === 'amd' ? 'AMD 显卡' : '显卡', vendor, pciId })
    }
  }

  // HIP's own device order, matched by gfx target and position among the cards of that target.
  const seen = new Map<string, number>()
  for (const gpu of gpus) {
    if (gpu.vendor !== 'amd' || !gpu.gfxTarget) continue
    const ordinal = seen.get(gpu.gfxTarget) ?? 0
    seen.set(gpu.gfxTarget, ordinal + 1)
    const listed = hipListed.filter((device) => device.arch === gpu.gfxTarget)[ordinal]
    if (listed) gpu.hip = { index: listed.index, usable: listed.usable }
  }

  return {
    machine: { os, gpus, systemCuda, rocm7: Boolean(rocmLibDir), hipAccess, vulkanProbed: vulkanList !== null },
    vulkanDevices: vulkanList ?? [],
    ...(rocmLibDir ? { rocmLibDir } : {}),
    notes,
  }
}

/* ------------------------------------------------------------------ */
/* Cache (memory + <engine root>/machine.json)                         */
/* ------------------------------------------------------------------ */

export interface StoredMachineProbe extends MachineProbe {
  probedAt: string
}

let cached: StoredMachineProbe | null = null
let cacheRoot: string | null = null

function cacheFile(root: string): string {
  return join(root, 'machine.json')
}

export function readStoredMachineProbe(root: string): StoredMachineProbe | null {
  if (cached && cacheRoot === root) return cached
  try {
    const raw = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as StoredMachineProbe
    if (!raw?.machine || !Array.isArray(raw.machine.gpus)) return null
    cached = raw
    cacheRoot = root
    return raw
  } catch {
    return null
  }
}

export function storeMachineProbe(root: string, probe: MachineProbe, now = new Date()): StoredMachineProbe {
  const stored: StoredMachineProbe = { ...probe, probedAt: now.toISOString() }
  cached = stored
  cacheRoot = root
  try {
    mkdirSync(root, { recursive: true })
    const file = cacheFile(root)
    writeFileSync(`${file}.tmp`, JSON.stringify(stored, null, 2), 'utf8')
    renameSync(`${file}.tmp`, file)
  } catch (error) {
    console.warn('[engine-machine] store', error)
  }
  return stored
}

/**
 * The stored machine with what nvidia-smi says now: driver version and
 * compute capability can change (driver update) without a new probe, and
 * those decide CUDA 13 vs 12.
 */
export function withLiveNvidia(machine: EngineMachine, live: GpuInventoryDevice[]): EngineMachine {
  if (live.length === 0) return machine
  const byUuid = new Map(live.map((device) => [device.uuid, device]))
  return {
    ...machine,
    gpus: machine.gpus.map((gpu) => {
      const now = byUuid.get(gpu.id)
      if (!now) return gpu
      return {
        ...gpu,
        ...(now.driverVersion ? { driverVersion: now.driverVersion } : {}),
        ...(now.computeCapability ? { computeCapability: now.computeCapability } : {}),
      }
    }),
  }
}

/** Whether nvidia-smi now lists another set of NVIDIA GPUs than the stored probe saw (a card added or removed). */
export function nvidiaSetChanged(machine: EngineMachine, live: GpuInventoryDevice[]): boolean {
  const stored = machine.gpus
    .filter((gpu) => gpu.vendor === 'nvidia' && !gpu.id.startsWith('vk-'))
    .map((gpu) => gpu.id)
    .sort()
  const now = live
    .filter((device) => (device.vendor ?? 'nvidia') === 'nvidia' && !device.uuid.startsWith('vk-'))
    .map((device) => device.uuid)
    .sort()
  return stored.join('|') !== now.join('|')
}

export function clearMachineProbeCache(): void {
  cached = null
  cacheRoot = null
}

/** Real filesystem helpers for the default deps. */
export const fsProbe = {
  readFile: (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  readdir: (path: string): string[] => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  exists: (path: string): boolean => existsSync(path),
  readWrite: (path: string): boolean => {
    try {
      accessSync(path, constants.R_OK | constants.W_OK)
      return true
    } catch {
      return false
    }
  },
}
