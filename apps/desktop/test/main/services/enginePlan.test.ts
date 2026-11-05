import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MossInferDownloadState } from '@shared/types'
import type { EngineRelease } from '@main/services/mossInferDownload'
import type { StoredMachineProbe } from '@main/services/engineMachine'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { setPlatform, usePlatform } from '@test/helpers/platform'

const downloadMossInfer = vi.hoisted(() => vi.fn(async (_request: unknown): Promise<MossInferDownloadState> => ({
  channel: 'stable', phase: 'done', bytes: 0, totalBytes: 0, percent: 100, speedBps: 0, updatedAt: '',
})))
const fetchEngineRelease = vi.hoisted(() => vi.fn<(tag?: string) => Promise<EngineRelease>>())
vi.mock('@main/services/mossInferDownload', () => ({ downloadMossInfer, fetchEngineRelease, ensureVulkanProbe: vi.fn() }))
const live = vi.hoisted(() => ({ devices: null as Array<{ uuid: string; index: number; name: string }> | null }))
vi.mock('@main/services/devices', () => ({
  scanNvidiaGpus: vi.fn(), refreshGpuInventory: vi.fn(async () => undefined),
  cachedGpuInventory: () => (live.devices ? { scannedAt: '', status: 'ok', devices: live.devices } : null),
}))
const releaseStaleMossInferRuntimes = vi.hoisted(() => vi.fn(async () => [] as string[]))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath: () => null, shutdownMossInfer: vi.fn(), releaseStaleMossInferRuntimes }))

usePlatform('linux')
const dataRoot = useTempDataRoot()
let plan: typeof import('@main/services/enginePlan')
let machineModule: typeof import('@main/services/engineMachine')
let settingsModule: typeof import('@main/services/settings')

const release = (tag = 'v2.2.0'): EngineRelease => ({
  tag, version: tag.slice(1), sums: '',
  assets: ['cu13', 'cu13-system-cuda', 'cu12-sm70', 'vulkan', 'hip'].map((id) => {
    const name = id === 'vulkan' || id === 'hip'
      ? `mossinfer-${tag.slice(1)}-linux-${id}-x86_64.tar.gz`
      : `mossinfer-${tag.slice(1)}-linux-${id.replace(/^(cu1\d)(-sm70)?(-system-cuda)?$/, '$1-x86_64$2$3')}.tar.gz`
    return { name, size: 1000, url: `https://github.com/dl/${name}` }
  }),
})

function probe(gpus: StoredMachineProbe['machine']['gpus'], patch: Partial<StoredMachineProbe['machine']> = {}): StoredMachineProbe['machine'] {
  return { os: 'linux', gpus, systemCuda: [], rocm7: false, hipAccess: true, vulkanProbed: true, ...patch }
}
const rtx = { id: 'GPU-rtx', name: 'RTX 4090', vendor: 'nvidia' as const, computeCapability: { major: 8, minor: 9 }, driverVersion: '590.48.01' }
const v100 = { id: 'GPU-v100', name: 'V100', vendor: 'nvidia' as const, computeCapability: { major: 7, minor: 0 }, driverVersion: '590.48.01' }
const amd = { id: 'vk-1002-744c-0', name: 'RX 7900 XTX', vendor: 'amd' as const, gfxTarget: 'gfx1100', vulkan: { index: 0, usable: true, discrete: true } }

function installed(name: string, program = 'moss-server'): void {
  mkdirSync(join(dataRoot(), 'mossinfer', name, 'bin'), { recursive: true })
  writeFileSync(join(dataRoot(), 'mossinfer', name, 'bin', program), '#!')
}

beforeEach(async () => {
  vi.resetModules()
  downloadMossInfer.mockClear()
  releaseStaleMossInferRuntimes.mockClear()
  live.devices = null
  fetchEngineRelease.mockReset().mockResolvedValue(release())
  machineModule = await import('@main/services/engineMachine')
  machineModule.clearMachineProbeCache()
  plan = await import('@main/services/enginePlan')
  settingsModule = await import('@main/services/settings')
})

function store(machine: StoredMachineProbe['machine'], rocmLibDir?: string): void {
  machineModule.storeMachineProbe(join(dataRoot(), 'mossinfer'), { machine, vulkanDevices: [], notes: [], ...(rocmLibDir ? { rocmLibDir } : {}) })
}

describe('getEnginePlan', () => {
  it('plans every GPU against the latest release and says what is missing', async () => {
    store(probe([rtx, v100, amd], { rocm7: true }))
    installed('stable-v2.2.0-cu13')
    const view = await plan.getEnginePlan()
    expect(view.choices.map((choice) => [choice.gpuId, choice.packageId])).toEqual([['GPU-rtx', 'cu13'], ['GPU-v100', 'cu12-sm70'], ['vk-1002-744c-0', 'hip']])
    expect(view).toMatchObject({ releaseTag: 'v2.2.0', channel: 'stable', installed: ['cu13'], missing: ['cu12-sm70', 'hip'] })
  })

  it('an older install of a package counts as missing for the new release', async () => {
    store(probe([rtx]))
    installed('stable-v2.1.1-cu13')
    expect((await plan.getEnginePlan()).missing).toEqual(['cu13'])
  })

  it('honours the per-GPU override from settings', async () => {
    store(probe([{ ...rtx, vulkan: { index: 0, usable: true, discrete: true } }]))
    settingsModule.updateSettings({ engineDeviceOverrides: { 'GPU-rtx': 'vulkan' } })
    expect((await plan.getEnginePlan()).choices[0]!.packageId).toBe('vulkan')
  })

  it('offline: plans with every package as possible and reports the release error', async () => {
    store(probe([rtx]))
    fetchEngineRelease.mockRejectedValue(new Error('GitHub API 网络请求失败'))
    const view = await plan.getEnginePlan()
    expect(view.releaseError).toContain('网络请求失败')
    expect(view.choices[0]!.packageId).toBe('cu13')
  })
})

describe('installEnginePlan', () => {
  it('installs only the missing packages, telling the downloader which GPU each one is for', async () => {
    store(probe([rtx, v100, amd], { rocm7: true }), '/opt/rocm-7.0.2/lib')
    installed('stable-v2.2.0-cu13')
    await plan.installEnginePlan({ channel: 'stable' })
    expect(downloadMossInfer).toHaveBeenCalledTimes(1)
    expect(downloadMossInfer.mock.calls[0]![0]).toMatchObject({
      channel: 'stable',
      packages: [{ kind: 'cuda', flavour: 'cu12', arch: 'sm70', runtime: 'bundled' }, { kind: 'hip' }],
      targets: { cu13: ['GPU-rtx'], 'cu12-sm70': ['GPU-v100'], hip: ['vk-1002-744c-0'] },
      env: { hip: { LD_LIBRARY_PATH: '/opt/rocm-7.0.2/lib' } },
    })
  })

  it('reports done without downloading when everything is installed', async () => {
    store(probe([rtx]))
    installed('stable-v2.2.0-cu13')
    const state = await plan.installEnginePlan({ channel: 'stable' })
    expect(state).toMatchObject({ phase: 'done', packages: ['cu13'] })
    expect(downloadMossInfer).not.toHaveBeenCalled()
  })

  it('a chosen release reinstalls every planned package', async () => {
    store(probe([rtx]))
    installed('stable-v2.2.0-cu13')
    await plan.installEnginePlan({ channel: 'stable', releaseTag: 'v2.2.0' })
    expect(downloadMossInfer.mock.calls[0]![0]).toMatchObject({ releaseTag: 'v2.2.0', packages: [{ kind: 'cuda', flavour: 'cu13' }] })
  })

  it('explicit packages go straight to the downloader', async () => {
    store(probe([rtx]))
    await plan.installEnginePlan({ channel: 'stable', packages: plan.packagesFromIds(['vulkan']) })
    expect(downloadMossInfer.mock.calls[0]![0]).toMatchObject({ packages: [{ kind: 'vulkan' }] })
    expect(() => plan.packagesFromIds(['cu11'])).toThrow(/未知的引擎包/)
  })

  it('refuses a machine nothing runs on', async () => {
    setPlatform('darwin')
    await expect(plan.installEnginePlan({ channel: 'stable' })).rejects.toThrow(/macOS/)
    expect(downloadMossInfer).not.toHaveBeenCalled()
  })
})

describe('detectEngineMachine', () => {
  it('reuses a fresh probe and probes again when asked', async () => {
    store(probe([rtx]))
    const deps = {
      platform: 'linux' as const, run: vi.fn(async () => ({ code: 0, stdout: 'no Vulkan devices\n', stderr: '', timedOut: false })),
      readFile: () => null, readdir: () => [], exists: () => false, readWrite: () => false,
      nvidia: vi.fn(async () => []), systemCuda: async () => [], vulkanBinary: async () => '/vk',
    }
    const cached = await plan.detectEngineMachine({ deps })
    expect(cached.machine.gpus.map((gpu) => gpu.id)).toEqual(['GPU-rtx'])
    expect(deps.nvidia).not.toHaveBeenCalled()
    const fresh = await plan.detectEngineMachine({ refresh: true, deps })
    expect(fresh.machine.gpus).toEqual([])
    expect(deps.nvidia).toHaveBeenCalledTimes(1)
  })
})

describe('detectEngineMachine: when to probe again', () => {
  const deps = () => ({
    platform: 'linux' as const, run: vi.fn(async () => ({ code: 0, stdout: 'no Vulkan devices\n', stderr: '', timedOut: false })),
    readFile: () => null, readdir: () => [], exists: () => false, readWrite: () => false,
    nvidia: vi.fn(async () => []), systemCuda: async () => [], vulkanBinary: async () => null,
  })

  it('offline, headless or on macOS a probe without Vulkan is not redone on every call', async () => {
    store(probe([rtx], { vulkanProbed: false }))
    const d = deps()
    await plan.detectEngineMachine({ release: null, deps: d })
    await plan.detectEngineMachine({ release: null, deps: d })
    expect(d.nvidia).not.toHaveBeenCalled()
    store(probe([], { os: 'macos', vulkanProbed: false }))
    await plan.detectEngineMachine({ release: release(), deps: d })
    expect(d.nvidia).not.toHaveBeenCalled()
    // With a release at hand the Vulkan probe can now run: once.
    store(probe([rtx], { vulkanProbed: false }))
    await plan.detectEngineMachine({ release: release(), deps: d })
    expect(d.nvidia).toHaveBeenCalledTimes(1)
  })

  it('probes again when nvidia-smi lists another set of GPUs than the stored probe', async () => {
    store(probe([rtx]))
    const d = deps()
    await plan.detectEngineMachine({ deps: d, liveNvidia: [{ uuid: 'GPU-rtx', index: 0, name: 'RTX 4090' }] })
    expect(d.nvidia).not.toHaveBeenCalled()
    await plan.detectEngineMachine({ deps: d, liveNvidia: [{ uuid: 'GPU-rtx', index: 0, name: 'RTX 4090' }, { uuid: 'GPU-new', index: 1, name: 'RTX 3060' }] })
    expect(d.nvidia).toHaveBeenCalledTimes(1)
  })

  it('getEnginePlan uses the live inventory for that check', async () => {
    store(probe([rtx]))
    live.devices = [{ uuid: 'GPU-other', index: 0, name: 'RTX 3060' }]
    // Stub the probe itself: the real one runs nvidia-smi, ldconfig and the Vulkan probe.
    const spy = vi.spyOn(machineModule, 'probeEngineMachine').mockResolvedValue({ machine: probe([rtx]), vulkanDevices: [], notes: [] })
    await plan.getEnginePlan().catch(() => undefined)
    expect(spy).toHaveBeenCalled()
  })
})

describe('applyLegacyBundledChoice', () => {
  it('turns the old global 「内置 CUDA」 into bundled overrides for the NVIDIA GPUs, once', async () => {
    const root = join(dataRoot(), 'mossinfer')
    settingsModule.writeLegacyEngineVariant(root, 'bundled')
    const machine = probe([rtx, v100, amd], { rocm7: true, systemCuda: ['cu13', 'cu12'] })
    plan.applyLegacyBundledChoice(root, machine)
    expect(settingsModule.getSettings().engineDeviceOverrides).toEqual({ 'GPU-rtx': 'cu13', 'GPU-v100': 'cu12-sm70' })
    expect(settingsModule.legacyEngineVariant(root)).toBeNull()
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledTimes(1)
    // Without the marker nothing changes.
    settingsModule.updateSettings({ engineDeviceOverrides: {} })
    plan.applyLegacyBundledChoice(root, machine)
    expect(settingsModule.getSettings().engineDeviceOverrides).toEqual({})
  })

  it('keeps a choice made by hand and waits when no GPU was seen', async () => {
    const root = join(dataRoot(), 'mossinfer')
    settingsModule.writeLegacyEngineVariant(root, 'bundled')
    plan.applyLegacyBundledChoice(root, probe([]))
    expect(settingsModule.legacyEngineVariant(root)).toBe('bundled')
    settingsModule.updateSettings({ engineDeviceOverrides: { 'GPU-rtx': 'vulkan' } })
    plan.applyLegacyBundledChoice(root, probe([{ ...rtx, vulkan: { index: 0, usable: true, discrete: true } }]))
    expect(settingsModule.getSettings().engineDeviceOverrides).toEqual({ 'GPU-rtx': 'vulkan' })
  })
})

