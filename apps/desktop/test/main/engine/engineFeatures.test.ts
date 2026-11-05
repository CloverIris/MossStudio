import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeEngineHello } from '@shared/engineProtocol'
import type { TrainingHost } from '@shared/types'
import { useTempDir } from '@test/helpers/tempDir'

const probeEngine = vi.hoisted(() => vi.fn())
/** The moss-server a GPU runs (engineInstalls.localServerPath: its own CUDA install). */
const localServerPath = vi.hoisted(() => vi.fn())
const runningEngineHello = vi.hoisted(() => vi.fn())
const remoteEngineHello = vi.hoisted(() => vi.fn())
const getTrainingHost = vi.hoisted(() => vi.fn())
const resolveDeviceEngine = vi.hoisted(() => vi.fn())
const deviceEngines = vi.hoisted(() => vi.fn())
const getSettings = vi.hoisted(() => vi.fn())
vi.mock('@main/services/engineInstalls', () => ({ resolveDeviceEngine, deviceEngines, localServerPath }))
vi.mock('@main/services/settings', () => ({ getSettings }))
vi.mock('@main/lib/probeEngine', () => ({ probeEngine }))
vi.mock('@main/services/mossInfer', () => ({ runningEngineHello }))
vi.mock('@main/services/remoteEngine', () => ({ remoteEngineHello }))
vi.mock('@main/services/trainingHosts', () => ({ getTrainingHost }))

const dir = useTempDir('mossstudio-features-')
let features: typeof import('@main/services/engineFeatures')
let serverPath: string

const hello22 = decodeEngineHello({
  protocol_version: 2,
  version: '2.2.0',
  capabilities: { preview: true, image_input: true, control: true, references: true, hires: true, samplers: true },
  values: { sampler: ['euler', 'heun'], scheduler: ['karras'] },
})
const helloOld = decodeEngineHello({ protocol_version: 2, version: '2.1.1', capabilities: { tiers: true } })
const all = { preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true, lora: true, values: { sampler: ['euler', 'heun'], scheduler: ['karras'] } }

beforeEach(async () => {
  vi.resetModules()
  serverPath = join(dir(), 'moss-server')
  writeFileSync(serverPath, '#!')
  probeEngine.mockReset().mockResolvedValue(hello22)
  localServerPath.mockReset().mockReturnValue(serverPath)
  runningEngineHello.mockReset().mockReturnValue(null)
  remoteEngineHello.mockReset()
  getTrainingHost.mockReset()
  resolveDeviceEngine.mockReset().mockReturnValue(null)
  deviceEngines.mockReset().mockReturnValue([])
  getSettings.mockReset().mockReturnValue({ gpuSelection: 'auto', trainingHosts: [] })
  features = await import('@main/services/engineFeatures')
})

describe('getEngineFeatures (local)', () => {
  it('uses the running moss-server of that GPU without probing', async () => {
    runningEngineHello.mockReturnValue(hello22)
    expect(await features.getEngineFeatures({ deviceUuid: 'GPU-a' })).toEqual(all)
    expect(runningEngineHello).toHaveBeenCalledWith('GPU-a')
    expect(probeEngine).not.toHaveBeenCalled()
  })

  it('probes the engine binary once and reuses the answer until the binary changes', async () => {
    const [a, b] = await Promise.all([features.getEngineFeatures(), features.getEngineFeatures()])
    expect(a).toEqual(all)
    expect(b).toEqual(all)
    await features.getEngineFeatures({ deviceUuid: 'GPU-a' })
    expect(probeEngine).toHaveBeenCalledTimes(1)
    utimesSync(serverPath, new Date(), new Date(Date.now() + 60_000))
    probeEngine.mockResolvedValue(helloOld)
    expect(await features.getEngineFeatures()).toMatchObject({ preview: false, imageInput: false, control: false })
    expect(probeEngine).toHaveBeenCalledTimes(2)
  })

  it('reports an engine older than 2.2 as supporting none of the new inputs', async () => {
    probeEngine.mockResolvedValue(helloOld)
    expect(await features.getEngineFeatures()).toEqual({ preview: false, imageInput: false, control: false, references: false, hires: false, samplers: false, lora: true, values: {} })
  })

  it('is null without an engine, with a failed probe (not retried at once) or another protocol', async () => {
    localServerPath.mockReturnValue(null)
    expect(await features.getEngineFeatures()).toBeNull()
    localServerPath.mockReturnValue(serverPath)
    probeEngine.mockRejectedValue(new Error('hello 超时'))
    expect(await features.getEngineFeatures()).toBeNull()
    expect(await features.getEngineFeatures()).toBeNull()
    expect(probeEngine).toHaveBeenCalledTimes(1)
    vi.resetModules()
    features = await import('@main/services/engineFeatures')
    probeEngine.mockResolvedValue(decodeEngineHello({ protocol_version: 1 }))
    expect(await features.getEngineFeatures()).toBeNull()
  })
})

describe('getEngineFeatures (CLI engines)', () => {
  const engine = (kind: 'cuda' | 'vulkan' | 'hip') => ({
    deviceUuid: 'x', package: kind === 'cuda' ? { kind, flavour: 'cu13', arch: 'standard', runtime: 'bundled' } : { kind },
    packageId: kind, binaryPath: `/e/${kind}`, installDir: '/e', version: 'v2.2.0',
  })
  const cliFeatures = (kind: 'vulkan' | 'hip') => ({
    preview: false, imageInput: false, control: false, references: false, hires: false, samplers: false, lora: false, cli: kind,
    values: { sampler: ['euler'], scheduler: ['moss'] },
  })

  it('answers text to image only for a GPU that runs moss-infer-vulkan or moss-infer-hip, without probing moss-server', async () => {
    resolveDeviceEngine.mockImplementation((uuid: string) => engine(uuid === 'vk-1002-744c-0' ? 'hip' : 'vulkan'))
    expect(await features.getEngineFeatures({ deviceUuid: 'vk-8086-56a0-0' })).toEqual(cliFeatures('vulkan'))
    expect(await features.getEngineFeatures({ deviceUuid: 'vk-1002-744c-0' })).toEqual(cliFeatures('hip'))
    expect(probeEngine).not.toHaveBeenCalled()
    expect(runningEngineHello).not.toHaveBeenCalled()
  })

  it('asks moss-server for a GPU that runs a CUDA package or has none installed', async () => {
    resolveDeviceEngine.mockReturnValue(engine('cuda'))
    expect(await features.getEngineFeatures({ deviceUuid: 'GPU-a' })).toEqual(all)
    resolveDeviceEngine.mockReturnValue(null)
    expect(await features.getEngineFeatures({ deviceUuid: 'GPU-b' })).toEqual(all)
  })

  it('without a device: the default GPU, else the machine when every installed engine on it is a CLI one', async () => {
    getSettings.mockReturnValue({ gpuSelection: { uuid: 'vk-8086-56a0-0' } })
    resolveDeviceEngine.mockReturnValue(engine('vulkan'))
    expect(await features.getEngineFeatures()).toEqual(cliFeatures('vulkan'))
    expect(resolveDeviceEngine).toHaveBeenLastCalledWith('vk-8086-56a0-0')

    getSettings.mockReturnValue({ gpuSelection: 'auto' })
    deviceEngines.mockReturnValue([{ gpu: {}, engine: engine('hip') }, { gpu: {}, engine: null }])
    expect(await features.getEngineFeatures()).toEqual(cliFeatures('hip'))
    // One CUDA GPU on the machine: auto may pick it, so the server's answer stands.
    deviceEngines.mockReturnValue([{ gpu: {}, engine: engine('vulkan') }, { gpu: {}, engine: engine('cuda') }])
    expect(await features.getEngineFeatures()).toEqual(all)
  })

  it('an SSH host is never asked about local CLI engines', async () => {
    resolveDeviceEngine.mockReturnValue(engine('vulkan'))
    getTrainingHost.mockReturnValue({ id: 'h1', kind: 'ssh', host: 'gpu.lab', user: 'me' })
    remoteEngineHello.mockResolvedValue(hello22)
    expect(await features.getEngineFeatures({ hostId: 'h1', deviceUuid: 'vk-8086-56a0-0' })).toMatchObject({ imageInput: true, lora: true })
  })
})

describe('getEngineFeatures (SSH host)', () => {
  const host = { id: 'h1', kind: 'ssh', host: 'gpu.lab', user: 'me' } as TrainingHost

  it("reads the host engine's hello; control and previews are not available over SSH yet", async () => {
    getTrainingHost.mockReturnValue(host)
    remoteEngineHello.mockResolvedValue(hello22)
    expect(await features.getEngineFeatures({ hostId: 'h1' })).toEqual({ ...all, control: false, preview: false })
    expect(remoteEngineHello).toHaveBeenCalledWith(host)
    expect(probeEngine).not.toHaveBeenCalled()
  })

  it('is null for an unknown or unreachable host', async () => {
    getTrainingHost.mockReturnValue(undefined)
    expect(await features.getEngineFeatures({ hostId: 'gone' })).toBeNull()
    getTrainingHost.mockReturnValue({ ...host, kind: 'local' })
    expect(await features.getEngineFeatures({ hostId: 'local' })).toBeNull()
    getTrainingHost.mockReturnValue(host)
    remoteEngineHello.mockResolvedValue(null)
    expect(await features.getEngineFeatures({ hostId: 'h1' })).toBeNull()
  })
})

describe('engine features: the moss-server of the GPU asked about', () => {
  it('asks the device its own moss-server, and the default GPU without a device', async () => {
    await features.getEngineFeatures({ deviceUuid: 'GPU-b' })
    expect(localServerPath).toHaveBeenLastCalledWith('GPU-b')
    getSettings.mockReturnValue({ gpuSelection: { uuid: 'GPU-c' }, trainingHosts: [] })
    await features.getEngineFeatures({})
    expect(localServerPath).toHaveBeenLastCalledWith('GPU-c')
  })
})
