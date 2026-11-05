import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { GpuInventoryDevice, GpuInventorySnapshot, Settings, TrainingHost } from '@shared/types'
import { decodeEngineHello, type EngineHello } from '@shared/engineProtocol'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { setPlatform } from '@test/helpers/platform'

const probeEngine = vi.hoisted(() => vi.fn<(path: string) => Promise<EngineHello>>())
const resolveServerPath = vi.hoisted(() => vi.fn<(settings: Settings) => string | null>())
const shutdownMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const getGpuInventory = vi.hoisted(() => vi.fn<() => Promise<GpuInventorySnapshot>>())
const hosts = vi.hoisted(() => ({ list: [] as TrainingHost[] }))
const shutdownCliEngines = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@main/services/cliEngine', () => ({ shutdownCliEngines }))
const remoteEngineStatus = vi.hoisted(() => vi.fn(async () => ({ installed: false })))
vi.mock('@main/lib/probeEngine', () => ({ probeEngine }))
const releaseStaleMossInferRuntimes = vi.hoisted(() => vi.fn(async () => [] as string[]))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath, shutdownMossInfer, releaseStaleMossInferRuntimes }))
const cachedInventory = vi.hoisted(() => ({ value: null as GpuInventorySnapshot | null }))
vi.mock('@main/services/devices', () => ({ getGpuInventory, cachedGpuInventory: () => cachedInventory.value }))
vi.mock('@main/services/trainingHosts', () => ({ getTrainingHost: (_s: unknown, id: string) => hosts.list.find((h) => h.id === id) }))
vi.mock('@main/services/remoteEngine', () => ({ remoteEngineStatus }))

const dataRoot = useTempDataRoot()
const hostPlatform = process.platform
afterEach(() => setPlatform(hostPlatform))
type Engines = typeof import('@main/services/engines')
let engines: Engines
let settingsModule: typeof import('@main/services/settings')
let emitted: Array<{ channel: string; payload: unknown }>
const engineRoot = (): string => join(dataRoot(), 'mossinfer')
const SERVER = process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'

const gpu: GpuInventoryDevice = { index: 0, uuid: 'GPU-a', name: 'RTX 4080', computeCapability: { major: 8, minor: 9 } }
function inventory(devices: GpuInventoryDevice[]): GpuInventorySnapshot {
  return { scannedAt: '', status: devices.length ? 'ok' : 'unavailable', devices }
}
function hello(patch: Record<string, unknown> = {}, device: Record<string, unknown> = {}): EngineHello {
  return decodeEngineHello({
    protocol_version: 2, version: '2.1.1',
    probe: { devices: [{ index: 0, name: 'RTX 4080', supported: true, compute_capability: '8.9', ...device }] },
    ...patch,
  })
}
function managed(name: string, inBin = true): string {
  const path = inBin ? join(engineRoot(), name, 'bin', SERVER) : join(engineRoot(), name, SERVER)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!')
  return path
}
/** A managed install whose program is named for the platform the test models (not the host). */
function managedFor(name: string, program: string): string {
  const path = join(engineRoot(), name, 'bin', program)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!')
  return path
}

function external(dir: string, inBin = true): string {
  const path = inBin ? join(dir, 'bin', SERVER) : join(dir, SERVER)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!')
  return path
}

beforeEach(async () => {
  vi.resetModules()
  probeEngine.mockReset().mockResolvedValue(hello())
  resolveServerPath.mockReset().mockReturnValue(null)
  shutdownMossInfer.mockClear()
  releaseStaleMossInferRuntimes.mockClear()
  getGpuInventory.mockReset().mockResolvedValue(inventory([gpu]))
  remoteEngineStatus.mockClear()
  cachedInventory.value = null
  shutdownCliEngines.mockReset().mockResolvedValue(undefined)
  hosts.list = []
  engines = await import('@main/services/engines')
  settingsModule = await import('@main/services/settings')
  const { onEmit } = await import('@main/lib/events')
  emitted = []
  onEmit((channel, payload) => emitted.push({ channel, payload }))
})

describe('localEngineVersions', () => {
  it('lists managed versions with a server binary and registered external ones, newest name first', () => {
    const current = managed('stable-v2.1.0-cu13')
    managed('stable-v2.1.1-cu13', false)
    mkdirSync(join(engineRoot(), 'stable-v9-empty'), { recursive: true })
    mkdirSync(join(engineRoot(), '.staging', 'x', 'bin'), { recursive: true })
    writeFileSync(join(engineRoot(), '.staging', 'x', 'bin', SERVER), '')
    const ext = external(join(dataRoot(), 'my-engine'))
    writeFileSync(join(engineRoot(), 'external.json'), JSON.stringify([
      { path: ext, name: 'mine' }, { path: join(dataRoot(), 'gone', SERVER) }, { nope: true }, 'junk',
    ]))
    resolveServerPath.mockReturnValue(current)

    expect(engines.localEngineVersions()).toEqual([
      { id: 'stable-v2.1.1-cu13', name: 'stable-v2.1.1-cu13', path: join(engineRoot(), 'stable-v2.1.1-cu13', SERVER), current: false, source: 'managed' },
      { id: 'stable-v2.1.0-cu13', name: 'stable-v2.1.0-cu13', path: current, current: true, source: 'managed' },
      { id: `external:${ext}`, name: 'mine · 外部', path: ext, current: false, source: 'external' },
    ])
  })

  it('is empty without an engine root or with a corrupt registry', () => {
    expect(engines.localEngineVersions()).toEqual([])
    mkdirSync(engineRoot(), { recursive: true })
    writeFileSync(join(engineRoot(), 'external.json'), '{')
    expect(engines.localEngineVersions()).toEqual([])
  })
})

describe('selectLocalEngineDirectory', () => {
  it('registers a directory holding bin/moss-server after a protocol-2 hello', async () => {
    const dir = join(dataRoot(), 'picked')
    const path = external(dir)
    const versions = await engines.selectLocalEngineDirectory(dir)
    expect(probeEngine).toHaveBeenCalledWith(path)
    expect(versions).toEqual([{ id: `external:${path}`, name: 'picked · 外部', path, current: false, source: 'external' }])
    // Registering again does not duplicate; the newest registration is listed first.
    const other = external(join(dataRoot(), 'other'), false)
    await engines.selectLocalEngineDirectory(dir)
    await engines.selectLocalEngineDirectory(join(dataRoot(), 'other'))
    const registry = JSON.parse(readFileSync(join(engineRoot(), 'external.json'), 'utf8'))
    expect(registry).toEqual([{ path: other, name: 'other' }, { path, name: 'picked' }])
  })

  it('rejects a missing directory, a file, a folder without the server and an old protocol', async () => {
    await expect(engines.selectLocalEngineDirectory(join(dataRoot(), 'missing'))).rejects.toThrow('所选路径不是有效的引擎目录')
    writeFileSync(join(dataRoot(), 'file'), '')
    await expect(engines.selectLocalEngineDirectory(join(dataRoot(), 'file'))).rejects.toThrow('所选路径不是有效的引擎目录')
    mkdirSync(join(dataRoot(), 'empty'))
    await expect(engines.selectLocalEngineDirectory(join(dataRoot(), 'empty'))).rejects.toThrow(`未找到 ${SERVER}`)
    external(join(dataRoot(), 'old'))
    probeEngine.mockResolvedValue(hello({ protocol_version: 1 }))
    await expect(engines.selectLocalEngineDirectory(join(dataRoot(), 'old'))).rejects.toThrow('引擎协议不兼容（protocol 1）')
    expect(existsSync(join(engineRoot(), 'external.json'))).toBe(false)
  })
})

describe('selectLocalEngineVersion', () => {
  it('activates a compatible version, persists the path and restarts the sidecar', async () => {
    const path = managed('stable-v2.1.1-cu13')
    await engines.selectLocalEngineVersion('stable-v2.1.1-cu13')
    expect(settingsModule.getSettings()).toMatchObject({ inferenceBackend: 'mossinfer', mossInferServerPath: path })
    expect(emitted.find((e) => e.channel === Events.settingsChanged)?.payload).toMatchObject({ mossInferServerPath: path })
    expect(shutdownMossInfer).toHaveBeenCalledTimes(1)
    // Activating a version also releases moss-servers that no longer match their GPU.
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledTimes(1)
  })

  it('skips the GPU check when no GPU is selected or present', async () => {
    managed('stable-v2.1.1-cu13')
    getGpuInventory.mockResolvedValue(inventory([]))
    await engines.selectLocalEngineVersion('stable-v2.1.1-cu13')
    expect(probeEngine).not.toHaveBeenCalled()
  })

  it('refuses an engine that does not support the selected GPU or speaks an old protocol', async () => {
    managed('stable-v2.1.1-cu13')
    probeEngine.mockResolvedValue(hello({}, { supported: false, unsupported_reason: 'sm_89 kernels missing' }))
    await expect(engines.selectLocalEngineVersion('stable-v2.1.1-cu13')).rejects.toThrow('RTX 4080 不兼容。sm_89 kernels missing')
    probeEngine.mockResolvedValue(hello({ protocol_version: 3 }))
    await expect(engines.selectLocalEngineVersion('stable-v2.1.1-cu13')).rejects.toThrow('引擎协议不兼容（protocol 3）')
    expect(settingsModule.getSettings().mossInferServerPath).toBeNull()
    expect(shutdownMossInfer).not.toHaveBeenCalled()
  })

  it('rejects an unknown version', async () => {
    await expect(engines.selectLocalEngineVersion('nope')).rejects.toThrow('引擎版本不存在或安装不完整')
  })
})

describe('removeLocalEngineVersion', () => {
  it('deletes a managed version directory', async () => {
    managed('stable-v1-cu13')
    expect(await engines.removeLocalEngineVersion('stable-v1-cu13')).toBe(true)
    expect(existsSync(join(engineRoot(), 'stable-v1-cu13'))).toBe(false)
    // A GPU whose install is gone frees its moss-server now.
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledTimes(1)
    expect(shutdownCliEngines).not.toHaveBeenCalled()
  })

  it('stops running Vulkan / HIP jobs before deleting a CLI package', async () => {
    const path = join(engineRoot(), 'stable-v2.1.0-vulkan', 'bin', process.platform === 'win32' ? 'moss-infer-vulkan.exe' : 'moss-infer-vulkan')
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!')
    let existedAtShutdown = false
    shutdownCliEngines.mockImplementation(async () => { existedAtShutdown = existsSync(path) })
    // A HIP install next to it must not be touched.
    const hip = join(engineRoot(), 'stable-v2.1.0-hip', 'bin', 'moss-infer-hip')
    mkdirSync(join(hip, '..'), { recursive: true })
    writeFileSync(hip, '#!')
    expect(await engines.removeLocalEngineVersion('stable-v2.1.0-vulkan')).toBe(true)
    expect(shutdownCliEngines).toHaveBeenCalledTimes(1)
    expect(shutdownCliEngines).toHaveBeenCalledWith({ kind: 'vulkan', binary: join(engineRoot(), 'stable-v2.1.0-vulkan') })
    expect(existsSync(hip)).toBe(true)
    expect(existedAtShutdown).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('unregisters an external version without touching its files', async () => {
    const dir = join(dataRoot(), 'picked')
    const path = external(dir)
    await engines.selectLocalEngineDirectory(dir)
    expect(await engines.removeLocalEngineVersion(`external:${path}`)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(engines.localEngineVersions()).toEqual([])
  })

  it('refuses to remove the current version or an unknown one', async () => {
    const path = managed('stable-v1-cu13')
    resolveServerPath.mockReturnValue(path)
    await expect(engines.removeLocalEngineVersion('stable-v1-cu13')).rejects.toThrow('当前使用的引擎版本不能删除')
    await expect(engines.removeLocalEngineVersion('../../etc')).rejects.toThrow('引擎版本不存在或安装不完整')
    expect(existsSync(path)).toBe(true)
  })
})

describe('probeLocalEngineGpuCompatibility', () => {
  it('fails without an installed server', async () => {
    await expect(engines.probeLocalEngineGpuCompatibility()).rejects.toThrow('未找到 moss-server')
  })

  it('maps the engine verdict onto the inventory and caches by binary fingerprint', async () => {
    const path = managed('stable-v1-cu13')
    resolveServerPath.mockReturnValue(path)
    const first = await engines.probeLocalEngineGpuCompatibility()
    expect(first.snapshot.enginePath).toBe(path)
    expect(first.hello.version).toBe('2.1.1')
    await engines.probeLocalEngineGpuCompatibility()
    expect(probeEngine).toHaveBeenCalledTimes(1)
    await engines.probeLocalEngine()
    expect(probeEngine).toHaveBeenCalledTimes(2)
    // A rebuilt binary (new mtime) invalidates the cache.
    utimesSync(path, new Date(), new Date(Date.now() + 10_000))
    await engines.probeLocalEngineGpuCompatibility()
    expect(probeEngine).toHaveBeenCalledTimes(3)
  })

  it('judges each GPU against the moss-server of its own package (Linux: 4090 on cu13, Titan V on cu12-sm70)', async () => {
    // The SM70 build is Linux-only: model a Linux host whatever this test runs on.
    setPlatform('linux')
    const rtx: GpuInventoryDevice = { index: 0, uuid: 'GPU-4090', name: 'NVIDIA GeForce RTX 4090', computeCapability: { major: 8, minor: 9 }, driverVersion: '590.48.01' }
    const titan: GpuInventoryDevice = { index: 1, uuid: 'GPU-titan', name: 'NVIDIA TITAN V', computeCapability: { major: 7, minor: 0 }, driverVersion: '590.48.01' }
    cachedInventory.value = inventory([rtx, titan])
    getGpuInventory.mockResolvedValue(inventory([rtx, titan]))
    const cu13 = managedFor('stable-v2.2.0-cu13', 'moss-server')
    const sm70 = managedFor('stable-v2.2.0-cu12-sm70', 'moss-server')
    const devices = (titanSupported: boolean) => [
      { index: 0, name: 'NVIDIA GeForce RTX 4090', supported: true, compute_capability: '8.9' },
      { index: 1, name: 'NVIDIA TITAN V', supported: titanSupported, compute_capability: '7.0', ...(titanSupported ? {} : { unsupported_reason: 'compute capability 7.0 is below the required 8.0' }) },
    ]
    probeEngine.mockImplementation(async (path: string) => decodeEngineHello({
      protocol_version: 2, version: path === sm70 ? '2.2.0-sm70' : '2.2.0', probe: { devices: devices(path === sm70) },
    }))
    const probe = await engines.probeLocalEngineGpuCompatibility()
    expect(probeEngine.mock.calls.map(([path]) => path).sort()).toEqual([cu13, sm70].sort())
    expect(probe.snapshot.devices.map((device) => [device.uuid, device.status])).toEqual([['GPU-4090', 'supported'], ['GPU-titan', 'supported']])
    expect(probe.helloFor('GPU-titan')?.version).toBe('2.2.0-sm70')
    expect(probe.helloFor('GPU-4090')?.version).toBe('2.2.0')
    // Each binary is cached on its own.
    await engines.probeLocalEngineGpuCompatibility()
    expect(probeEngine).toHaveBeenCalledTimes(2)
  })

  it('on Windows the Titan V has no CUDA build (no SM70 there): only the cu13 moss-server is probed', async () => {
    setPlatform('win32')
    const rtx: GpuInventoryDevice = { index: 0, uuid: 'GPU-4090', name: 'NVIDIA GeForce RTX 4090', computeCapability: { major: 8, minor: 9 }, driverVersion: '581.42' }
    const titan: GpuInventoryDevice = { index: 1, uuid: 'GPU-titan', name: 'NVIDIA TITAN V', computeCapability: { major: 7, minor: 0 }, driverVersion: '581.42' }
    cachedInventory.value = inventory([rtx, titan])
    getGpuInventory.mockResolvedValue(inventory([rtx, titan]))
    const cu13 = managedFor('stable-v2.2.0-cu13', 'moss-server.exe')
    probeEngine.mockResolvedValue(decodeEngineHello({ protocol_version: 2, version: '2.2.0', probe: { devices: [
      { index: 0, name: 'NVIDIA GeForce RTX 4090', supported: true, compute_capability: '8.9' },
      { index: 1, name: 'NVIDIA TITAN V', supported: false, compute_capability: '7.0', unsupported_reason: 'compute capability 7.0 is below the required 8.0' },
    ] } }))
    const probe = await engines.probeLocalEngineGpuCompatibility()
    expect(probeEngine.mock.calls.map(([path]) => path)).toEqual([cu13])
    expect(probe.helloFor('GPU-4090')?.version).toBe('2.2.0')
    expect(probe.helloFor('GPU-titan')).toBeNull()
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    const path = managed('stable-v1-cu13')
    resolveServerPath.mockReturnValue(path)
    await Promise.all([engines.probeLocalEngineGpuCompatibility(true), engines.probeLocalEngineGpuCompatibility(true)])
    expect(probeEngine).toHaveBeenCalledTimes(1)
  })
})

describe('remoteEngineInfo', () => {
  it('requires an existing SSH host', async () => {
    hosts.list = [{ id: 'l', name: 'L', kind: 'local', trainerRoot: '', status: 'ok' }, { id: 's', name: 'S', kind: 'ssh', trainerRoot: '', status: 'ok' }]
    await expect(engines.remoteEngineInfo('nope')).rejects.toThrow('主机不存在')
    await expect(engines.remoteEngineInfo('l')).rejects.toThrow('不是 SSH 主机')
    await engines.remoteEngineInfo('s', true)
    expect(remoteEngineStatus).toHaveBeenCalledWith(hosts.list[1], true)
  })
})
