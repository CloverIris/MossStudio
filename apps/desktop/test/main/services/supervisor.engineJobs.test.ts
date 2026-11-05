import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { decodeEngineHello } from '@shared/engineProtocol'
import type { GpuInventoryDevice, JobRecord } from '@shared/types'
import type { MossInferSink } from '@main/services/mossInfer'
import { useTempDataRoot } from '@test/helpers/tempDir'

const emit = vi.hoisted(() => vi.fn())
const runMossInferJob = vi.hoisted(() => vi.fn())
const resolveServerPath = vi.hoisted(() => vi.fn())
const prepareModelSource = vi.hoisted(() => vi.fn())
const refreshGpuInventory = vi.hoisted(() => vi.fn())
const probeLocalEngineGpuCompatibility = vi.hoisted(() => vi.fn())
const cancelMossInferJob = vi.hoisted(() => vi.fn(() => true))
const restartMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const runRemoteEngineJob = vi.hoisted(() => vi.fn())
const cancelRemoteEngineJob = vi.hoisted(() => vi.fn(() => true))
const getTrainingHost = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/events', () => ({ emit, onEmit: () => () => undefined }))
vi.mock('@main/services/mossInfer', () => ({
  runMossInferJob,
  resolveServerPath,
  cancelMossInferJob,
  restartMossInfer,
}))
vi.mock('@main/services/remoteEngine', () => ({ runRemoteEngineJob, cancelRemoteEngineJob }))
vi.mock('@main/services/trainingHosts', () => ({ getTrainingHost }))
vi.mock('@main/services/ssh', () => ({ remoteAbsolute: async (_host: unknown, path: string) => path, sshExec: vi.fn() }))
vi.mock('@main/services/modelBundles', () => ({ prepareModelSource }))
vi.mock('@main/services/devices', () => ({ refreshGpuInventory }))
vi.mock('@main/services/engines', () => ({ probeLocalEngineGpuCompatibility }))
vi.mock('@main/services/desktopNotifications', () => ({ pushLocalNotification: vi.fn() }))
vi.mock('@main/services/diagnostics', () => ({ pushDiagnostic: vi.fn() }))
vi.mock('@main/lib/engineActivation', () => ({ waitForEngineActivation: async () => undefined }))

const dataRoot = useTempDataRoot()
let supervisor: typeof import('@main/services/supervisor')

const gpu: GpuInventoryDevice = { uuid: 'GPU-a', index: 0, name: 'RTX Test', computeCapability: { major: 8, minor: 9 } }

/** The sink of every job handed to the engine, by job id. */
let sinks: Map<string, MossInferSink>
let starts: Array<{ job: JobRecord; params: JobRecord['params']; opts: Record<string, unknown> }>

beforeEach(async () => {
  vi.resetModules()
  emit.mockReset()
  cancelMossInferJob.mockClear()
  restartMossInfer.mockClear()
  cancelRemoteEngineJob.mockClear()
  runRemoteEngineJob.mockReset().mockImplementation(async (_host: unknown, opts: { jobId: string }, sink: MossInferSink) => {
    sinks.set(opts.jobId, sink)
  })
  getTrainingHost.mockReset().mockReturnValue({ id: 'h1', name: 'Lab', kind: 'ssh', host: 'gpu.lab', user: 'me', outputRoot: '/out' })
  sinks = new Map()
  starts = []
  runMossInferJob.mockReset().mockImplementation(async (job: JobRecord, params: JobRecord['params'], opts: Record<string, unknown>, sink: MossInferSink) => {
    starts.push({ job, params, opts })
    sinks.set(job.id, sink)
  })
  const server = join(dataRoot(), 'moss-server')
  writeFileSync(server, '#!')
  resolveServerPath.mockReset().mockReturnValue(server)
  const bundle = join(dataRoot(), 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'clover_model.json'), JSON.stringify({ bundleId: 'b' }))
  prepareModelSource.mockReset().mockResolvedValue({ model: bundle })
  refreshGpuInventory.mockReset().mockResolvedValue({ devices: [gpu] })
  probeLocalEngineGpuCompatibility.mockReset().mockResolvedValue({
    hello: decodeEngineHello({ protocol_version: 2, probe: { devices: [{ index: 0, name: 'RTX Test', supported: true, compute_capability: '8.9' }] } }),
  })
  supervisor = await import('@main/services/supervisor')
})

const request = (prompt: string, patch: Record<string, unknown> = {}) => ({
  prompt, width: 1024, height: 1024, steps: 20, cfg: 4, seed: 1, deviceUuid: 'GPU-a', modelBinding: { bundleId: 'b' }, ...patch,
}) as Parameters<typeof supervisor.startEngineJob>[0]

/** Every job update emitted for `id`, in order. */
const updates = (id: string): JobRecord[] =>
  emit.mock.calls.filter(([channel, job]) => channel === Events.job && (job as JobRecord).id === id).map(([, job]) => job as JobRecord)

describe('engine jobs: inputs', () => {
  it('carries the image inputs into the job params and to the engine', async () => {
    const job = await supervisor.startEngineJob(request('with inputs', {
      initImage: { path: '/assets/init.png', strength: 0.5 },
      mask: { path: '/assets/mask.png' },
      references: { paths: ['/assets/ref.png'], maxEdge: 512 },
      sampling: { sampler: 'heun' },
    }))
    expect(job.params).toMatchObject({
      initImage: { path: '/assets/init.png', strength: 0.5 }, mask: { path: '/assets/mask.png' },
      references: { paths: ['/assets/ref.png'], maxEdge: 512 }, sampling: { sampler: 'heun' },
    })
    expect(job.params).not.toHaveProperty('control')
    expect(starts[0]!.params).toEqual(job.params)
    expect(starts[0]!.opts['previewOutput']).toBe(join(dataRoot(), 'cache', 'previews', `${job.id}.png`))
  })
})

describe('engine jobs: queue positions', () => {
  it('numbers waiting jobs from 1 and renumbers them as the queue moves', async () => {
    const first = await supervisor.startEngineJob(request('first'))
    const second = await supervisor.startEngineJob(request('second'))
    const third = await supervisor.startEngineJob(request('third'))
    expect(first.queuePosition).toBeUndefined()
    expect(second).toMatchObject({ state: 'queued', queuePosition: 1 })
    expect(third).toMatchObject({ state: 'queued', queuePosition: 2 })

    await supervisor.cancelJob(second.id)
    expect(updates(second.id).at(-1)).toMatchObject({ state: 'canceled' })
    expect(updates(second.id).at(-1)!.queuePosition).toBeUndefined()
    expect(updates(third.id).at(-1)).toMatchObject({ state: 'queued', queuePosition: 1 })

    // The first job ends: the third starts and leaves the queue.
    sinks.get(first.id)!.event({ type: 'ready' })
    sinks.get(first.id)!.event({ type: 'result', images: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }] })
    sinks.get(first.id)!.done(0)
    await vi.waitFor(() => expect(starts.map((start) => start.job.id)).toEqual([first.id, third.id]))
    const started = updates(third.id).at(-1)!
    expect(started.state).toBe('starting')
    expect(started.queuePosition).toBeUndefined()
  })
})

describe('engine jobs: live previews', () => {
  it('turns preview events into JobRecord.preview (throttled) and removes the preview when the job ends', async () => {
    const job = await supervisor.startEngineJob(request('preview'))
    const sink = sinks.get(job.id)!
    const file = starts[0]!.opts['previewOutput'] as string
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'png')
    sink.event({ type: 'ready' })
    sink.event({ type: 'stage', name: 'denoise' })
    for (let step = 1; step <= 5; step += 1) sink.event({ type: 'preview', path: file, step, total: 20 })

    const previews = () => updates(job.id).map((item) => item.preview).filter(Boolean)
    // The first write shows at once; the burst behind it collapses into its latest frame.
    expect(previews()).toEqual([{ path: file, step: 1, total: 20, seq: 1 }])
    await vi.waitFor(() => expect(previews().at(-1)).toEqual({ path: file, step: 5, total: 20, seq: 5 }), { timeout: 2000 })
    expect(previews()).toHaveLength(2)

    sink.event({ type: 'result', images: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }] })
    sink.done(0)
    const last = updates(job.id).at(-1)!
    expect(last.state).toBe('succeeded')
    expect(last.preview).toBeUndefined()
    await vi.waitFor(() => expect(existsSync(file)).toBe(false))
    // A late write after the end changes nothing.
    sink.event({ type: 'preview', path: file, step: 6, total: 20 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(updates(job.id).at(-1)!.preview).toBeUndefined()
  })
})

describe('engine jobs: cancel', () => {
  it('cancels a remote job over its own session and never touches the local engines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const job = await supervisor.startEngineJob(request('remote', { deviceUuid: undefined, hostId: 'h1', remoteModelPath: '/models/moss' }))
      expect(runRemoteEngineJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobId: job.id }), expect.anything())
      await supervisor.cancelJob(job.id)
      expect(cancelRemoteEngineJob).toHaveBeenCalledWith(job.id)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(cancelMossInferJob).not.toHaveBeenCalled()
      expect(restartMossInfer).not.toHaveBeenCalled()
      sinks.get(job.id)!.event({ type: 'canceled', at_stage: 'denoise' })
      sinks.get(job.id)!.done(130)
      expect(updates(job.id).at(-1)).toMatchObject({ state: 'canceled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it("restarts only the local job's own GPU runtime when the engine does not confirm", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const job = await supervisor.startEngineJob(request('local'))
      await supervisor.cancelJob(job.id)
      expect(cancelMossInferJob).toHaveBeenCalledWith(job.id)
      expect(cancelRemoteEngineJob).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      expect(restartMossInfer.mock.calls).toEqual([['GPU-a']])
    } finally {
      vi.useRealTimers()
    }
  })
})
