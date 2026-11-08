import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { decodeEngineHello } from '@shared/engineProtocol'
import { engineBinaryName } from '@shared/enginePackages'
import type { GpuInventoryDevice, JobRecord } from '@shared/types'
import type { MossInferSink } from '@main/services/mossInfer'
import { useTempDataRoot } from '@test/helpers/tempDir'

const emit = vi.hoisted(() => vi.fn())
const runMossInferJob = vi.hoisted(() => vi.fn())
const prepareModelSource = vi.hoisted(() => vi.fn())
const refreshGpuInventory = vi.hoisted(() => vi.fn())
const probeLocalEngineGpuCompatibility = vi.hoisted(() => vi.fn())
const cancelMossInferJob = vi.hoisted(() => vi.fn(() => true))
const restartMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const runRemoteEngineJob = vi.hoisted(() => vi.fn())
const cancelRemoteEngineJob = vi.hoisted(() => vi.fn(() => true))
const jobWeightPrecisions = vi.hoisted(() => vi.fn())
const getTrainingHost = vi.hoisted(() => vi.fn())
const getCatalog = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/events', () => ({ emit, onEmit: () => () => undefined }))
vi.mock('@main/services/mossInfer', () => ({
  runMossInferJob,
  // No MOSS_SERVER / bundled / PATH moss-server: jobs must find the install this branch made.
  resolveServerPath: () => null,
  cancelMossInferJob,
  restartMossInfer,
}))
vi.mock('@main/services/remoteEngine', () => ({ runRemoteEngineJob, cancelRemoteEngineJob }))
vi.mock('@main/services/trainingHosts', () => ({ getTrainingHost }))
vi.mock('@main/services/ssh', () => ({ remoteAbsolute: async (_host: unknown, path: string) => path, sshExec: vi.fn() }))
vi.mock('@main/services/modelBundles', () => ({ prepareModelSource }))
vi.mock('@main/services/models', async (importOriginal) => ({ ...(await importOriginal<object>()), getCatalog }))
vi.mock('@main/services/weightPrecision', () => ({ jobWeightPrecisions }))
vi.mock('@main/services/devices', () => ({ refreshGpuInventory, cachedGpuInventory: () => ({ devices: [gpu] }) }))
vi.mock('@main/services/engines', () => ({ probeLocalEngineGpuCompatibility }))
// Every GPU here runs moss-server from a real managed install (see beforeEach); supervisor.cliJobs.test.ts covers the CLI engines.
vi.mock('@main/services/desktopNotifications', () => ({ pushLocalNotification: vi.fn() }))
vi.mock('@main/services/diagnostics', () => ({ pushDiagnostic: vi.fn() }))
vi.mock('@main/lib/engineActivation', () => ({ waitForEngineActivation: async () => undefined }))

const dataRoot = useTempDataRoot()
let supervisor: typeof import('@main/services/supervisor')
// Runs before useTempDataRoot removes the folder (after-hooks run last-registered first): the job list and
// log writes the supervisor does not wait for must be done, or the removal races them (ENOTEMPTY).
afterEach(async () => {
  await supervisor?.settleJobWrites()
})

const gpu: GpuInventoryDevice = {
  uuid: 'GPU-a',
  index: 0,
  name: 'RTX Test',
  computeCapability: { major: 8, minor: 9 },
  driverVersion: '590.48.01',
}

const folderBundle = { id: 'b', name: 'Folder', description: '', support: 's', components: { dit: 'dit', textEncoder: 'te', vae: 'vae' } }
const fileBundle = {
  id: 'files',
  name: 'SFT · INT4',
  description: '',
  support: 's',
  components: { dit: 'dit-file', textEncoder: 'te', vae: 'vae' },
  tier: 'turbo' as const,
}

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
  runMossInferJob
    .mockReset()
    .mockImplementation(async (job: JobRecord, params: JobRecord['params'], opts: Record<string, unknown>, sink: MossInferSink) => {
      starts.push({ job, params, opts })
      sinks.set(job.id, sink)
    })
  // What downloadMossInfer leaves behind: <engine root>/stable-<tag>-<package>/bin/moss-server, nothing in settings.
  // Named for the OS the test runs on (moss-server.exe on Windows), like the real package.
  const server = join(dataRoot(), 'mossinfer', 'stable-v2.2.0-cu13', 'bin', engineBinaryName('cuda', process.platform))
  mkdirSync(join(server, '..'), { recursive: true })
  writeFileSync(server, '#!')
  const bundle = join(dataRoot(), 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'clover_model.json'), JSON.stringify({ bundleId: 'b' }))
  prepareModelSource.mockReset().mockResolvedValue({ model: bundle, bundle: folderBundle })
  getCatalog.mockReset().mockResolvedValue({
    bundles: [folderBundle, fileBundle],
    models: [
      { id: 'dit', role: 'dit', provider: 'hf', format: 'diffusers' },
      { id: 'dit-file', role: 'dit', provider: 'hf', format: 'comfyui' },
    ],
    adapters: [],
  })
  jobWeightPrecisions.mockReset().mockResolvedValue({ dit: 'bf16', textEncoder: 'bf16' })
  refreshGpuInventory.mockReset().mockResolvedValue({ devices: [gpu] })
  const hello = decodeEngineHello({
    protocol_version: 2,
    probe: { devices: [{ index: 0, name: 'RTX Test', supported: true, compute_capability: '8.9' }] },
  })
  probeLocalEngineGpuCompatibility.mockReset().mockResolvedValue({ hello, helloFor: () => hello })
  supervisor = await import('@main/services/supervisor')
})

const request = (prompt: string, patch: Record<string, unknown> = {}) =>
  ({
    prompt,
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 4,
    seed: 1,
    deviceUuid: 'GPU-a',
    modelBinding: { bundleId: 'b' },
    ...patch,
  }) as Parameters<typeof supervisor.startEngineJob>[0]

/** Every job update emitted for `id`, in order. */
const updates = (id: string): JobRecord[] =>
  emit.mock.calls.filter(([channel, job]) => channel === Events.job && (job as JobRecord).id === id).map(([, job]) => job as JobRecord)

describe("engine jobs: the moss-server of the GPU's own install", () => {
  it('starts on a managed install with no moss-server path in settings, and says so when there is none', async () => {
    const { getSettings } = await import('@main/services/settings')
    expect(getSettings().mossInferServerPath).toBeNull()
    await supervisor.startEngineJob(request('installed'))
    expect(runMossInferJob).toHaveBeenCalledTimes(1)

    const { rmSync } = await import('node:fs')
    rmSync(join(dataRoot(), 'mossinfer'), { recursive: true, force: true })
    // The first instance's writes are its own; the afterEach only sees the second one.
    await supervisor.settleJobWrites()
    vi.resetModules()
    supervisor = await import('@main/services/supervisor')
    await expect(supervisor.startEngineJob(request('nothing installed'))).rejects.toThrow('未找到 moss-server')
  })
})

describe('engine jobs: writes the caller does not wait for', () => {
  it('settleJobWrites resolves once the job list is on disk with every job', async () => {
    const jobs = [
      await supervisor.startEngineJob(request('first')),
      await supervisor.startEngineJob(request('second')),
      await supervisor.startEngineJob(request('third')),
    ]
    await supervisor.settleJobWrites()
    const saved = JSON.parse(readFileSync(join(dataRoot(), 'jobs', 'jobs.json'), 'utf8')) as JobRecord[]
    expect(saved.map((job) => job.id).sort()).toEqual(jobs.map((job) => job.id).sort())
    // Nothing is left in flight: settling again returns at once.
    await supervisor.settleJobWrites()
  })
})

describe('engine jobs: inputs', () => {
  it('records the canvas title for Activity, trimmed and at most 120 characters', async () => {
    const named = await supervisor.startEngineJob(request('installed', { canvasTitle: '  画面 1  ' }))
    expect(named.canvasTitle).toBe('画面 1')
    const long = await supervisor.startEngineJob(request('installed', { canvasTitle: 'x'.repeat(200) }))
    expect(long.canvasTitle).toHaveLength(120)
    const blank = await supervisor.startEngineJob(request('installed', { canvasTitle: '   ' }))
    expect(blank.canvasTitle).toBeUndefined()
  })

  it('carries the image inputs into the job params and to the engine', async () => {
    const job = await supervisor.startEngineJob(
      request('with inputs', {
        initImage: { path: '/assets/init.png', strength: 0.5 },
        mask: { path: '/assets/mask.png' },
        references: { paths: ['/assets/ref.png'], maxEdge: 512 },
        sampling: { sampler: 'heun' },
      }),
    )
    expect(job.params).toMatchObject({
      initImage: { path: '/assets/init.png', strength: 0.5 },
      mask: { path: '/assets/mask.png' },
      references: { paths: ['/assets/ref.png'], maxEdge: 512 },
      sampling: { sampler: 'heun' },
    })
    expect(job.params).not.toHaveProperty('control')
    expect(starts[0]!.params).toEqual(job.params)
    expect(starts[0]!.opts['previewOutput']).toBe(join(dataRoot(), 'cache', 'previews', `${job.id}.png`))
  })
})

describe('engine jobs: single-file models', () => {
  it('loads the files next to the runtime-config folder with the tier the model needs', async () => {
    const folder = join(dataRoot(), 'bundle')
    prepareModelSource.mockResolvedValue({ model: folder, ditFile: '/models/dit-int4.safetensors', bundle: fileBundle })
    jobWeightPrecisions.mockResolvedValue({ dit: 'w4a4', textEncoder: 'int8' })
    const job = await supervisor.startEngineJob(request('int4', { modelBinding: { bundleId: 'files' } }))
    expect(starts[0]!.opts).toMatchObject({ model: folder, ditFile: '/models/dit-int4.safetensors' })
    // 设置 says high (the default); an INT4 DiT runs only under turbo.
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('turbo')
    expect(job.gpuProfile).toMatchObject({ tier: 'turbo', source: 'model-weights' })
    expect(job.modelSnapshot).toMatchObject({ bundleId: 'b', files: { ditFile: '/models/dit-int4.safetensors' } })
  })

  it('runs INT4 on Turing with its own tier, though Turing runs folder models at reference', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [{ ...gpu, computeCapability: { major: 7, minor: 5 } }] })
    prepareModelSource.mockResolvedValue({ model: join(dataRoot(), 'bundle'), ditFile: '/models/dit-int4.safetensors', bundle: fileBundle })
    jobWeightPrecisions.mockResolvedValue({ dit: 'w4a4', textEncoder: 'int8' })
    const job = await supervisor.startEngineJob(request('int4 on turing', { modelBinding: { bundleId: 'files' } }))
    expect(job.gpuProfile).toMatchObject({ tier: 'turbo', source: 'model-weights' })
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('turbo')
  })

  it('uses the tier the model names when the engine has no name for its weights (NVFP4)', async () => {
    prepareModelSource.mockResolvedValue({ model: join(dataRoot(), 'bundle'), ditFile: '/models/nvfp4.safetensors', bundle: fileBundle })
    jobWeightPrecisions.mockResolvedValue({ dit: null, textEncoder: 'int8' })
    const job = await supervisor.startEngineJob(request('nvfp4', { modelBinding: { bundleId: 'files' } }))
    expect(job.gpuProfile).toMatchObject({ tier: 'turbo', source: 'model-weights' })
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('turbo')
  })

  it('lets the weights the engine reads overrule the tier a model names', async () => {
    // A scanned file named like INT4 that is really bf16 runs as bf16.
    prepareModelSource.mockResolvedValue({ model: join(dataRoot(), 'bundle'), ditFile: '/models/dit-int4.safetensors', bundle: fileBundle })
    const job = await supervisor.startEngineJob(request('bf16 named int4', { modelBinding: { bundleId: 'files' } }))
    expect(job.gpuProfile?.tier).toBe('high')
    expect(job.gpuProfile?.source).not.toBe('model-weights')
  })

  it('keeps the tier from 设置 for a folder model', async () => {
    const job = await supervisor.startEngineJob(request('folder'))
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('high')
    expect(job.gpuProfile?.source).not.toBe('model-weights')
  })

  it('refuses a model made for another GPU before starting the engine', async () => {
    prepareModelSource.mockResolvedValue({
      model: join(dataRoot(), 'bundle'),
      ditFile: '/models/nvfp4.safetensors',
      bundle: { ...fileBundle, name: 'SFT · NVFP4', requires: { computeCapability: { major: 12, minor: 0 }, label: 'RTX 50 系列显卡' } },
    })
    await expect(supervisor.startEngineJob(request('nvfp4', { modelBinding: { bundleId: 'files' } }))).rejects.toThrow(
      '「SFT · NVFP4」只能在 RTX 50 系列显卡上运行，请换一个模型',
    )
    expect(runMossInferJob).not.toHaveBeenCalled()
  })

  it('refuses a single-file model on another computer', async () => {
    await expect(
      supervisor.startEngineJob(
        request('remote', { deviceUuid: undefined, hostId: 'h1', remoteModelPath: '/models/moss', modelBinding: { bundleId: 'files' } }),
      ),
    ).rejects.toThrow('「SFT · INT4」只能在这台电脑上运行')
    expect(runRemoteEngineJob).not.toHaveBeenCalled()
  })
})

describe('engine jobs: the tier follows the weights', () => {
  const turing: GpuInventoryDevice = { ...gpu, computeCapability: { major: 7, minor: 5 } }
  const turingHello = decodeEngineHello({
    protocol_version: 2,
    probe: { devices: [{ index: 0, name: 'RTX Test', supported: true, compute_capability: '7.5' }] },
  })

  it('runs an INT8 DiT file at High on a GPU without 8-bit attention, where a bf16 bundle runs Reference', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [turing] })
    probeLocalEngineGpuCompatibility.mockResolvedValue({ hello: turingHello, helloFor: () => turingHello })
    const bundle = await supervisor.startEngineJob(request('bf16 bundle'))
    expect(bundle.gpuProfile).toMatchObject({ tier: 'reference', source: 'hardware-compatibility' })
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('reference')
    expect(jobWeightPrecisions).toHaveBeenLastCalledWith({ ditFile: undefined, textEncoderFile: undefined, vaeFile: undefined }, 'GPU-a')
    sinks.get(bundle.id)!.done(1)

    prepareModelSource.mockResolvedValue({ model: join(dataRoot(), 'bundle'), ditFile: '/models/moss_image_heal_int8_convrot.safetensors' })
    jobWeightPrecisions.mockResolvedValue({ dit: 'int8', textEncoder: 'bf16' })
    const int8 = await supervisor.startEngineJob(request('int8 dit'))
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    expect(jobWeightPrecisions).toHaveBeenLastCalledWith(
      { ditFile: '/models/moss_image_heal_int8_convrot.safetensors', textEncoderFile: undefined, vaeFile: undefined },
      'GPU-a',
    )
    expect(int8.gpuProfile).toMatchObject({ tier: 'high', source: 'global' })
    expect((starts[1]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('high')
  })

  it('settles a queued job when it starts: queued as asked, run as its weights allow', async () => {
    const first = await supervisor.startEngineJob(request('first'))
    jobWeightPrecisions.mockResolvedValue({ dit: 'w4a4', textEncoder: 'bf16' })
    const queued = await supervisor.startEngineJob(request('queued int4'))
    expect(queued).toMatchObject({ state: 'queued', gpuProfile: { tier: 'high' } })

    sinks.get(first.id)!.done(1)
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    expect(starts[1]!.job).toMatchObject({ id: queued.id, gpuProfile: { tier: 'turbo', source: 'model-weights' } })
    expect((starts[1]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('turbo')
  })

  it('never starts a job canceled while its weights are looked up, and runs the next one', async () => {
    const first = await supervisor.startEngineJob(request('first'))
    const second = await supervisor.startEngineJob(request('canceled on the way'))
    const third = await supervisor.startEngineJob(request('third'))
    let answer: (value: unknown) => void = () => undefined
    jobWeightPrecisions.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))

    sinks.get(first.id)!.done(1)
    await vi.waitFor(() => expect(jobWeightPrecisions).toHaveBeenCalledTimes(2))
    expect(await supervisor.cancelJob(second.id)).toMatchObject({ state: 'canceled' })
    answer({ dit: 'bf16', textEncoder: 'bf16' })

    await vi.waitFor(() => expect(starts.map((start) => start.job.id)).toEqual([first.id, third.id]))
    expect(updates(second.id).at(-1)).toMatchObject({ state: 'canceled' })
  })

  it('runs an INT4 DiT as Turbo even when High was chosen', async () => {
    jobWeightPrecisions.mockResolvedValue({ dit: 'w4a4', textEncoder: 'bf16' })
    const job = await supervisor.startEngineJob(request('int4 dit'))
    expect(job.gpuProfile).toMatchObject({ tier: 'turbo', source: 'model-weights' })
    expect((starts[0]!.opts['settings'] as { mossInferTier: string }).mossInferTier).toBe('turbo')
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

    const previews = () =>
      updates(job.id)
        .map((item) => item.preview)
        .filter(Boolean)
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
      const job = await supervisor.startEngineJob(
        request('remote', { deviceUuid: undefined, hostId: 'h1', remoteModelPath: '/models/moss' }),
      )
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
