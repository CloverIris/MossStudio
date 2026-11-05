import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeEngineHello } from '@shared/engineProtocol'
import type { TrainingHost } from '@shared/types'
import { useTempDir } from '@test/helpers/tempDir'

const probeEngine = vi.hoisted(() => vi.fn())
const resolveServerPath = vi.hoisted(() => vi.fn())
const runningEngineHello = vi.hoisted(() => vi.fn())
const remoteEngineHello = vi.hoisted(() => vi.fn())
const getTrainingHost = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/probeEngine', () => ({ probeEngine }))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath, runningEngineHello }))
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
const all = { preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true, values: { sampler: ['euler', 'heun'], scheduler: ['karras'] } }

beforeEach(async () => {
  vi.resetModules()
  serverPath = join(dir(), 'moss-server')
  writeFileSync(serverPath, '#!')
  probeEngine.mockReset().mockResolvedValue(hello22)
  resolveServerPath.mockReset().mockReturnValue(serverPath)
  runningEngineHello.mockReset().mockReturnValue(null)
  remoteEngineHello.mockReset()
  getTrainingHost.mockReset()
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
    expect(await features.getEngineFeatures()).toEqual({ preview: false, imageInput: false, control: false, references: false, hires: false, samplers: false, values: {} })
  })

  it('is null without an engine, with a failed probe (not retried at once) or another protocol', async () => {
    resolveServerPath.mockReturnValue(null)
    expect(await features.getEngineFeatures()).toBeNull()
    resolveServerPath.mockReturnValue(serverPath)
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
