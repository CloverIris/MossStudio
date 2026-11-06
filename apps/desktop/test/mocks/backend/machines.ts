/**
 * Machines for the engine chooser in the mock backend: what the main
 * process' machine probe would have found, and the GPU inventory that goes
 * with it. `engine:plan` answers by running the real chooser over these.
 */
import { chooseEnginePackages, type EngineAssetList, type EngineMachine, type EngineMachineGpu } from '@shared/engineChoice'
import { parseEngineStamp } from '@shared/engineUpdate'
import type { EnginePlanView, GpuInventoryDevice, LocalEngineVersion, Settings } from '@shared/types'

const GiB = 1024 ** 3
const NOW = '2026-04-01T12:00:00.000Z'

/** The real v2.2.0 release assets and sizes. */
export const RELEASE_220: EngineAssetList = {
  version: '2.2.0',
  assets: [
    ['mossinfer-2.2.0-linux-cu12-x86_64-sm70-system-cuda.tar.gz', 50162713],
    ['mossinfer-2.2.0-linux-cu12-x86_64-sm70.tar.gz', 556009175],
    ['mossinfer-2.2.0-linux-cu12-x86_64-system-cuda.tar.gz', 37896314],
    ['mossinfer-2.2.0-linux-cu12-x86_64.tar.gz', 543743047],
    ['mossinfer-2.2.0-linux-cu13-x86_64-system-cuda.tar.gz', 25036827],
    ['mossinfer-2.2.0-linux-cu13-x86_64.tar.gz', 386148983],
    ['mossinfer-2.2.0-linux-hip-x86_64.tar.gz', 1151047],
    ['mossinfer-2.2.0-linux-vulkan-x86_64.tar.gz', 1280514],
    ['mossinfer-2.2.0-windows-cu12-x86_64-system-cuda.zip', 35874471],
    ['mossinfer-2.2.0-windows-cu12-x86_64.zip', 515651091],
    ['mossinfer-2.2.0-windows-cu13-x86_64-sm75-system-cuda.zip', 27432030],
    ['mossinfer-2.2.0-windows-cu13-x86_64-sm75.zip', 373216837],
    ['mossinfer-2.2.0-windows-cu13-x86_64-system-cuda.zip', 22909199],
    ['mossinfer-2.2.0-windows-cu13-x86_64.zip', 368693986],
    ['mossinfer-2.2.0-windows-vulkan-x86_64.zip', 612948],
  ].map(([name, size]) => ({ name: name as string, size: size as number })),
}

const vk = (index: number, discrete = true): EngineMachineGpu['vulkan'] => ({ index, usable: true, discrete, kernels: 'coop' })

const RTX_4090: EngineMachineGpu = {
  id: 'GPU-00000000-1111-2222-3333-444444444444',
  name: 'NVIDIA GeForce RTX 4090',
  vendor: 'nvidia',
  pciId: '10de:2684',
  memoryBytes: 24 * GiB,
  computeCapability: { major: 8, minor: 9 },
  driverVersion: '581.42',
  vulkan: vk(0),
}
const RTX_2080: EngineMachineGpu = {
  id: 'GPU-20802080-aaaa-bbbb-cccc-dddddddddddd',
  name: 'NVIDIA GeForce RTX 2080 Ti',
  vendor: 'nvidia',
  pciId: '10de:1e07',
  memoryBytes: 11 * GiB,
  computeCapability: { major: 7, minor: 5 },
  driverVersion: '581.42',
  vulkan: vk(0),
}
const V100: EngineMachineGpu = {
  id: 'GPU-70707070-aaaa-bbbb-cccc-dddddddddddd',
  name: 'Tesla V100-PCIE-32GB',
  vendor: 'nvidia',
  pciId: '10de:1db6',
  memoryBytes: 32 * GiB,
  computeCapability: { major: 7, minor: 0 },
  driverVersion: '550.163.01',
  vulkan: vk(0),
}
const RX_7900: EngineMachineGpu = {
  id: 'vk-1002-744c-0',
  name: 'AMD Radeon RX 7900 XTX',
  vendor: 'amd',
  pciId: '1002:744c',
  memoryBytes: 24 * GiB,
  gfxTarget: 'gfx1100',
  vulkan: vk(0),
}
const ARC_A770: EngineMachineGpu = {
  id: 'vk-8086-56a0-0',
  name: 'Intel(R) Arc(TM) A770 Graphics',
  vendor: 'intel',
  pciId: '8086:56a0',
  memoryBytes: 16 * GiB,
  vulkan: vk(0),
}

export type MachineName = 'nvidia' | 'nvidiaOldDriver' | 'turing' | 'volta' | 'amdRocm' | 'amd' | 'intel' | 'multiGpu' | 'macos'

/** The machines the spec asks for: NVIDIA new/old driver, Turing, Volta, AMD with/without ROCm, Intel, multi-GPU, macOS. */
export function machineFixture(name: MachineName): EngineMachine {
  const base = { systemCuda: [], rocm7: false, vulkanProbed: true }
  switch (name) {
    case 'nvidia':
      return { ...base, os: 'windows', gpus: [RTX_4090] }
    case 'nvidiaOldDriver':
      return { ...base, os: 'windows', gpus: [{ ...RTX_4090, driverVersion: '560.94' }] }
    case 'turing':
      return { ...base, os: 'windows', gpus: [RTX_2080] }
    case 'volta':
      return { ...base, os: 'linux', gpus: [V100] }
    case 'amdRocm':
      return { ...base, os: 'linux', rocm7: true, hipAccess: true, gpus: [RX_7900] }
    case 'amd':
      return { ...base, os: 'linux', gpus: [RX_7900] }
    case 'intel':
      return { ...base, os: 'windows', gpus: [ARC_A770] }
    case 'multiGpu':
      return {
        ...base,
        os: 'linux',
        rocm7: false,
        gpus: [
          { ...RTX_4090, driverVersion: '590.48.01' },
          { ...RTX_2080, id: 'GPU-20802080-1', driverVersion: '590.48.01', vulkan: vk(1) },
          { ...RX_7900, vulkan: vk(2) },
        ],
      }
    case 'macos':
      return { ...base, os: 'macos', gpus: [], vulkanProbed: false }
  }
}

/** The GPU inventory the main process would show for this machine (non-NVIDIA GPUs merged from the probe). */
export function inventoryDevicesFor(machine: EngineMachine): GpuInventoryDevice[] {
  return machine.gpus.map((gpu, index) => ({
    uuid: gpu.id,
    index,
    name: gpu.name,
    ...(gpu.memoryBytes ? { memoryTotalBytes: gpu.memoryBytes, memoryFreeBytes: gpu.memoryBytes - GiB } : {}),
    ...(gpu.computeCapability ? { computeCapability: gpu.computeCapability } : {}),
    ...(gpu.driverVersion ? { driverVersion: gpu.driverVersion } : {}),
    ...(gpu.vendor !== 'nvidia' ? { vendor: gpu.vendor } : {}),
    ...(gpu.pciId ? { pciId: gpu.pciId } : {}),
    ...(gpu.vulkan ? { vulkanIndex: gpu.vulkan.index } : {}),
    ...(gpu.gfxTarget ? { gfxTarget: gpu.gfxTarget } : {}),
  }))
}

/** What main's engine:plan answers for this state: the real chooser over the fixture machine and release. */
export function enginePlanFor(
  machine: EngineMachine,
  release: EngineAssetList,
  settings: Pick<Settings, 'engineDeviceOverrides' | 'mossInferChannel'>,
  versions: LocalEngineVersion[],
): EnginePlanView {
  const plan = chooseEnginePackages(machine, release, { overrides: settings.engineDeviceOverrides })
  const installed = [
    ...new Set(
      versions.flatMap((version) => {
        const stamp = parseEngineStamp(version.name)
        return stamp ? [stamp.packageId] : []
      }),
    ),
  ]
  // A version the app did not name (custom engine, older fixture) serves every GPU it is used for.
  const custom = versions.some((version) => version.current && !parseEngineStamp(version.name))
  return {
    ...plan,
    channel: settings.mossInferChannel,
    releaseTag: `v${release.version}`,
    machine,
    probedAt: NOW,
    notes: [],
    installed,
    missing: custom ? [] : plan.packages.map((item) => item.packageId).filter((id) => !installed.includes(id)),
  }
}
