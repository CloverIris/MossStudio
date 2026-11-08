import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { decodeEngineHello } from '@shared/engineProtocol'
import type { GpuInventoryDevice, JobRecord, ModelEntry } from '@shared/types'
import type { MossInferSink } from '@main/services/mossInfer'
import type { CliJobOptions } from '@main/services/cliEngine'
import type { DeviceEngine } from '@main/services/engineInstalls'
import { useTempDataRoot } from '@test/helpers/tempDir'

/** Routing of local jobs by the package a GPU runs: moss-server for CUDA, the one-shot CLI for Vulkan / HIP. */
const emit = vi.hoisted(() => vi.fn())
const runMossInferJob = vi.hoisted(() => vi.fn())
const cancelMossInferJob = vi.hoisted(() => vi.fn(() => true))
const restartMossInfer = vi.hoisted(() => vi.fn(async () => undefined))
const releaseStaleMossInferRuntimes = vi.hoisted(() => vi.fn(async (_uuid?: string): Promise<string[]> => []))
const runCliJob = vi.hoisted(() => vi.fn())
const cancelCliJob = vi.hoisted(() => vi.fn((_id: string) => false))
const hipDeviceIndex = vi.hoisted(() => vi.fn())
const cliBundleDtypeProblem = vi.hoisted(() => vi.fn())
const currentEngineMachine = vi.hoisted(() => vi.fn())
const resolveDeviceEngine = vi.hoisted(() => vi.fn())
const prepareModelSource = vi.hoisted(() => vi.fn())
const getCatalog = vi.hoisted(() => vi.fn())
const refreshGpuInventory = vi.hoisted(() => vi.fn())
const probeLocalEngineGpuCompatibility = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/events', () => ({ emit, onEmit: () => () => undefined }))
vi.mock('@main/services/mossInfer', () => ({ runMossInferJob, cancelMossInferJob, restartMossInfer, releaseStaleMossInferRuntimes }))
vi.mock('@main/services/cliEngine', () => ({ runCliJob, cancelCliJob, hipDeviceIndex, cliBundleDtypeProblem }))
// localServerPath follows the same per-device record, like the real one: a CUDA GPU's own moss-server, nothing for a CLI GPU.
vi.mock('@main/services/engineInstalls', () => ({
  resolveDeviceEngine,
  currentEngineMachine,
  localServerPath: (uuid?: string) => {
    const engine = uuid ? (resolveDeviceEngine(uuid) as DeviceEngine | null) : null
    return engine?.package.kind === 'cuda' ? engine.binaryPath : null
  },
}))
vi.mock('@main/services/models', () => ({ getCatalog }))
vi.mock('@main/services/remoteEngine', () => ({ runRemoteEngineJob: vi.fn(), cancelRemoteEngineJob: vi.fn() }))
vi.mock('@main/services/trainingHosts', () => ({ getTrainingHost: vi.fn() }))
vi.mock('@main/services/ssh', () => ({ remoteAbsolute: async (_host: unknown, path: string) => path, sshExec: vi.fn() }))
vi.mock('@main/services/modelBundles', () => ({ prepareModelSource }))
vi.mock('@main/services/devices', () => ({ refreshGpuInventory }))
vi.mock('@main/services/engines', () => ({ probeLocalEngineGpuCompatibility }))
vi.mock('@main/services/desktopNotifications', () => ({ pushLocalNotification: vi.fn() }))
vi.mock('@main/services/diagnostics', () => ({ pushDiagnostic: vi.fn() }))
vi.mock('@main/lib/engineActivation', () => ({ waitForEngineActivation: async () => undefined }))

const dataRoot = useTempDataRoot()
let supervisor: typeof import('@main/services/supervisor')

const nvidia: GpuInventoryDevice = { uuid: 'GPU-a', index: 0, name: 'RTX 4090', computeCapability: { major: 8, minor: 9 } }
const arc: GpuInventoryDevice = { uuid: 'vk-8086-56a0-0', index: 1, name: 'Intel Arc A770', vendor: 'intel', vulkanIndex: 2 }
const amdA: GpuInventoryDevice = {
  uuid: 'vk-1002-744c-0',
  index: 2,
  name: 'Radeon RX 7900 XTX',
  vendor: 'amd',
  vulkanIndex: 0,
  gfxTarget: 'gfx1100',
}
const amdB: GpuInventoryDevice = {
  uuid: 'vk-1002-744c-1',
  index: 3,
  name: 'Radeon RX 7900 XTX',
  vendor: 'amd',
  vulkanIndex: 1,
  gfxTarget: 'gfx1100',
}

const deviceEngine = (kind: 'cuda' | 'vulkan' | 'hip', device: GpuInventoryDevice): DeviceEngine => ({
  deviceUuid: device.uuid,
  package: kind === 'cuda' ? { kind, flavour: 'cu13', arch: 'standard', runtime: 'bundled' } : { kind },
  packageId: kind === 'cuda' ? 'cu13' : kind,
  binaryPath: `/engines/stable-v2.2.0-${kind}/bin/${kind === 'cuda' ? 'moss-server' : `moss-infer-${kind}`}`,
  installDir: `/engines/stable-v2.2.0-${kind}`,
  version: 'v2.2.0',
  ...(device.vulkanIndex !== undefined ? { vulkanIndex: device.vulkanIndex } : {}),
  ...(device.gfxTarget ? { gfxTarget: device.gfxTarget } : {}),
  ...(kind === 'hip' ? { env: { LD_LIBRARY_PATH: '/opt/rocm-7.0.1/lib' } } : {}),
})

const part = (id: string, role: ModelEntry['role'], precision = 'bf16'): Partial<ModelEntry> => ({
  id,
  role,
  provider: 'hf',
  format: 'diffusers',
  precision,
})

let sinks: Map<string, MossInferSink>
let cliStarts: Array<{ job: JobRecord; opts: CliJobOptions }>
let engines: Map<string, DeviceEngine>
let bundle: string

beforeEach(async () => {
  vi.resetModules()
  // Job errors read the diagnostic rules from the release folder (none here).
  Object.defineProperty(process, 'resourcesPath', { value: join(dataRoot(), 'resources'), configurable: true })
  emit.mockReset()
  cancelMossInferJob.mockClear()
  restartMossInfer.mockClear()
  releaseStaleMossInferRuntimes.mockReset().mockResolvedValue([])
  sinks = new Map()
  cliStarts = []
  engines = new Map([
    [nvidia.uuid, deviceEngine('cuda', nvidia)],
    [arc.uuid, deviceEngine('vulkan', arc)],
    [amdA.uuid, deviceEngine('hip', amdA)],
    [amdB.uuid, deviceEngine('hip', amdB)],
  ])
  resolveDeviceEngine.mockReset().mockImplementation((uuid: string) => engines.get(uuid) ?? null)
  runCliJob.mockReset().mockImplementation(async (job: JobRecord, _params: unknown, opts: CliJobOptions, sink: MossInferSink) => {
    cliStarts.push({ job, opts })
    sinks.set(job.id, sink)
  })
  cancelCliJob.mockReset().mockImplementation((id: string) => sinks.has(id))
  hipDeviceIndex.mockReset().mockImplementation(async (_binary: string, _gpu: unknown, ordinal: number) => ({ ok: true, index: ordinal }))
  cliBundleDtypeProblem.mockReset().mockResolvedValue(null)
  currentEngineMachine.mockReset().mockReturnValue({ machine: { os: 'linux', gpus: [], systemCuda: [], rocm7: true, vulkanProbed: true } })
  runMossInferJob.mockReset().mockImplementation(async (job: JobRecord, _params: unknown, _opts: unknown, sink: MossInferSink) => {
    sinks.set(job.id, sink)
  })
  bundle = join(dataRoot(), 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'clover_model.json'), JSON.stringify({ bundleId: 'moss-sft' }))
  prepareModelSource.mockReset().mockResolvedValue({ model: bundle })
  getCatalog.mockReset().mockResolvedValue({
    bundles: [
      { id: 'moss-sft', name: 'MOSS-Image SFT', components: { dit: 'sft-dit', textEncoder: 'te', vae: 'vae' }, support: 'cfg' },
      { id: 'moss-sft-fp16', name: 'MOSS-Image SFT FP16', components: { dit: 'fp16-dit', textEncoder: 'te', vae: 'vae' }, support: 'cfg' },
    ],
    models: [part('sft-dit', 'dit'), part('fp16-dit', 'dit', 'fp16'), part('te', 'text_encoder'), part('vae', 'vae', 'fp32')],
    adapters: [],
  })
  refreshGpuInventory.mockReset().mockResolvedValue({ devices: [arc, amdA, amdB] })
  probeLocalEngineGpuCompatibility.mockReset().mockRejectedValue(new Error('未找到 moss-server'))
  supervisor = await import('@main/services/supervisor')
})

const request = (patch: Record<string, unknown> = {}) =>
  ({
    prompt: 'a red apple',
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 4,
    seed: 1,
    modelBinding: { bundleId: 'moss-sft', dit: 'sft-dit', textEncoder: 'te', vae: 'vae' },
    ...patch,
  }) as Parameters<typeof supervisor.startEngineJob>[0]

const updates = (id: string): JobRecord[] =>
  emit.mock.calls.filter(([channel, job]) => channel === Events.job && (job as JobRecord).id === id).map(([, job]) => job as JobRecord)

describe('local jobs on a CLI engine', () => {
  it('runs a Vulkan GPU through moss-infer-vulkan with its Vulkan index, without moss-server', async () => {
    const job = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
    expect(runMossInferJob).not.toHaveBeenCalled()
    expect(probeLocalEngineGpuCompatibility).not.toHaveBeenCalled()
    expect(cliStarts).toHaveLength(1)
    expect(cliStarts[0]!.opts).toEqual({
      kind: 'vulkan',
      binary: '/engines/stable-v2.2.0-vulkan/bin/moss-infer-vulkan',
      version: 'v2.2.0',
      model: bundle,
      output: join(dataRoot(), 'outputs', `${job.id}-1.png`),
      deviceUuid: arc.uuid,
      cliDeviceIndex: 2,
      expectedDevice: { name: 'Intel Arc A770' },
    })
    expect(job).toMatchObject({ deviceUuid: arc.uuid, engine: 'mossinfer', state: 'starting' })

    const sink = sinks.get(job.id)!
    sink.event({ type: 'ready', device: 'vulkan:2' })
    sink.event({ type: 'stage', name: 'denoise' })
    sink.event({ type: 'progress', stage: 'denoise', current: 5, total: 20, percent: 25, eta_ms: 15_000 })
    expect(updates(job.id).at(-1)).toMatchObject({
      state: 'running',
      stage: 'denoise',
      progress: { current: 5, total: 20, percent: 25, etaMs: 15_000 },
    })
    sink.event({ type: 'result', images: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }] })
    sink.done(0)
    expect(updates(job.id).at(-1)).toMatchObject({ state: 'succeeded', outputs: [{ path: '/o.png' }] })
  })

  it('runs an AMD GPU through moss-infer-hip with its HIP index (cards of one gfx target in inventory order) and ROCm env', async () => {
    await supervisor.startEngineJob(request({ deviceUuid: amdB.uuid }))
    await vi.waitFor(() => expect(cliStarts).toHaveLength(1))
    expect(hipDeviceIndex).toHaveBeenCalledWith(
      '/engines/stable-v2.2.0-hip/bin/moss-infer-hip',
      { name: 'Radeon RX 7900 XTX', gfxTarget: 'gfx1100' },
      1,
      { LD_LIBRARY_PATH: '/opt/rocm-7.0.1/lib' },
    )
    expect(cliStarts[0]!.opts).toMatchObject({
      kind: 'hip',
      cliDeviceIndex: 1,
      env: { LD_LIBRARY_PATH: '/opt/rocm-7.0.1/lib' },
      expectedDevice: { name: 'Radeon RX 7900 XTX', gfxTarget: 'gfx1100' },
    })
  })

  it('checks the Vulkan program against the name its own --list-devices gave that index', async () => {
    engines.set(arc.uuid, { ...deviceEngine('vulkan', arc), expectedVulkanName: 'Intel(R) Arc(TM) A770 Graphics (DG2)' })
    await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
    expect(cliStarts[0]!.opts.expectedDevice).toEqual({ name: 'Intel(R) Arc(TM) A770 Graphics (DG2)' })
  })

  it('a CUDA GPU still goes to moss-server', async () => {
    // The GPU's own CUDA install, as resolveDeviceEngine reports it.
    const server = join(dataRoot(), 'stable-v2.2.0-cu13', 'bin', 'moss-server')
    mkdirSync(join(server, '..'), { recursive: true })
    writeFileSync(server, '#!')
    engines.set(nvidia.uuid, { ...deviceEngine('cuda', nvidia), binaryPath: server })
    refreshGpuInventory.mockResolvedValue({ devices: [nvidia, arc] })
    const hello = decodeEngineHello({
      protocol_version: 2,
      probe: { devices: [{ index: 0, name: 'RTX 4090', supported: true, compute_capability: '8.9' }] },
    })
    probeLocalEngineGpuCompatibility.mockResolvedValue({ hello, helloFor: (uuid: string) => (uuid === nvidia.uuid ? hello : null) })
    await supervisor.startEngineJob(request({ deviceUuid: nvidia.uuid }))
    expect(runMossInferJob).toHaveBeenCalledTimes(1)
    expect(runCliJob).not.toHaveBeenCalled()
  })

  it('refuses a bundle that is not bf16 before anything starts, and says why', async () => {
    await expect(
      supervisor.startEngineJob(
        request({
          deviceUuid: arc.uuid,
          modelBinding: { bundleId: 'moss-sft-fp16', dit: 'fp16-dit', textEncoder: 'te', vae: 'vae' },
        }),
      ),
    ).rejects.toThrow('「MOSS-Image SFT FP16」不是 bf16 模型，兼容模式引擎只能用 bf16 的 MOSS-Image，请换一个模型')
    expect(prepareModelSource).not.toHaveBeenCalled()
    expect(runCliJob).not.toHaveBeenCalled()
  })

  it('auto picks a CLI GPU on a machine with no moss-server', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [arc] })
    const job = await supervisor.startEngineJob(request())
    expect(job.deviceUuid).toBe(arc.uuid)
    expect(cliStarts[0]!.opts.kind).toBe('vulkan')
  })

  it('cancel goes to the CLI engine and never restarts a moss-server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const job = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
      await supervisor.cancelJob(job.id)
      expect(cancelCliJob).toHaveBeenCalledWith(job.id)
      expect(cancelMossInferJob).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(restartMossInfer).not.toHaveBeenCalled()
      sinks.get(job.id)!.event({ type: 'canceled', at_stage: 'denoise' })
      sinks.get(job.id)!.done(130)
      expect(updates(job.id).at(-1)).toMatchObject({ state: 'canceled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second job on the same CLI GPU waits in the queue', async () => {
    const first = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
    const second = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid, prompt: 'second' }))
    expect(second).toMatchObject({ state: 'queued', queuePosition: 1 })
    expect(cliStarts).toHaveLength(1)
    sinks.get(first.id)!.event({ type: 'result', images: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }] })
    sinks.get(first.id)!.done(0)
    await vi.waitFor(() => expect(cliStarts.map((start) => start.job.id)).toEqual([first.id, second.id]))
  })
})

describe('CLI jobs: HIP device lookup', () => {
  it('fails the job with the lookup message when moss-infer-hip does not list the card, and never starts it', async () => {
    hipDeviceIndex.mockResolvedValue({
      ok: false,
      message: 'moss-infer-hip 没有找到这张显卡（gfx1100，同型号第 2 张），请到 设置 › 设备 重新检测显卡后再试',
    })
    const job = await supervisor.startEngineJob(request({ deviceUuid: amdB.uuid }))
    await vi.waitFor(() =>
      expect(updates(job.id).at(-1)).toMatchObject({
        state: 'failed',
        error: {
          code: 'E_DEVICE',
          message: 'moss-infer-hip 没有找到这张显卡（gfx1100，同型号第 2 张），请到 设置 › 设备 重新检测显卡后再试',
        },
      }),
    )
    expect(runCliJob).not.toHaveBeenCalled()
  })

  it('a cancel during the lookup ends the job canceled without starting the program or touching moss-server', async () => {
    let release: (value: unknown) => void = () => undefined
    hipDeviceIndex.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const job = await supervisor.startEngineJob(request({ deviceUuid: amdA.uuid }))
    await vi.waitFor(() => expect(hipDeviceIndex).toHaveBeenCalled())
    await supervisor.cancelJob(job.id)
    expect(cancelMossInferJob).not.toHaveBeenCalled()
    release({ ok: true, index: 0 })
    await vi.waitFor(() => expect(updates(job.id).at(-1)).toMatchObject({ state: 'canceled' }))
    expect(runCliJob).not.toHaveBeenCalled()
    expect(restartMossInfer).not.toHaveBeenCalled()
  })

  it('cannot tell identical cards apart when ours is not in the inventory with its gfx target', async () => {
    const stray: GpuInventoryDevice = { ...amdA, uuid: 'vk-1002-744c-9', gfxTarget: undefined }
    engines.set(stray.uuid, { ...deviceEngine('hip', stray), gfxTarget: 'gfx1100' })
    refreshGpuInventory.mockResolvedValue({ devices: [stray, amdA, amdB] })
    const job = await supervisor.startEngineJob(request({ deviceUuid: stray.uuid }))
    await vi.waitFor(() => expect(updates(job.id).at(-1)).toMatchObject({ state: 'failed', error: { code: 'E_DEVICE' } }))
    expect(updates(job.id).at(-1)!.error!.message).toContain('分不清')
    expect(hipDeviceIndex).not.toHaveBeenCalled()
  })
})

describe('CLI jobs: model weights', () => {
  it('refuses weights whose safetensors dtype is not bf16, whatever the catalog says', async () => {
    cliBundleDtypeProblem.mockResolvedValue('这个模型的DiT是 F16，兼容模式引擎只能用 bf16 的 MOSS-Image，请换一个模型')
    await expect(supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))).rejects.toThrow('这个模型的DiT是 F16')
    expect(cliBundleDtypeProblem).toHaveBeenCalledWith('vulkan', bundle)
    expect(runCliJob).not.toHaveBeenCalled()
  })

  it('refuses a bundle whose parts the catalog does not list', async () => {
    await expect(
      supervisor.startEngineJob(
        request({
          deviceUuid: arc.uuid,
          modelBinding: { bundleId: 'moss-sft', dit: 'unknown-dit', textEncoder: 'te', vae: 'vae' },
        }),
      ),
    ).rejects.toThrow('无法确认它是 bf16 模型包')
  })
})

describe('automatic GPU assignment on a mixed machine', () => {
  const hello = decodeEngineHello({
    protocol_version: 2,
    probe: { devices: [{ index: 0, name: 'RTX 4090', supported: true, compute_capability: '8.9' }] },
  })
  beforeEach(() => {
    const server = join(dataRoot(), 'stable-v2.2.0-cu13', 'bin', 'moss-server')
    mkdirSync(join(server, '..'), { recursive: true })
    writeFileSync(server, '#!')
    engines.set(nvidia.uuid, { ...deviceEngine('cuda', nvidia), binaryPath: server })
    probeLocalEngineGpuCompatibility.mockResolvedValue({ hello, helloFor: (uuid: string) => (uuid === nvidia.uuid ? hello : null) })
  })

  it('sends work to the CUDA GPU and never to a CLI GPU, even while the CUDA GPU is busy', async () => {
    // The Arc is listed first and idle; the NVIDIA GPU then has a job running.
    refreshGpuInventory.mockResolvedValue({ devices: [arc, nvidia] })
    const first = await supervisor.startEngineJob(request())
    const second = await supervisor.startEngineJob(request({ prompt: 'second' }))
    expect(first.deviceUuid).toBe(nvidia.uuid)
    expect(second).toMatchObject({ deviceUuid: nvidia.uuid, state: 'queued' })
    expect(runCliJob).not.toHaveBeenCalled()
  })

  it('a job with pictures or LoRA never lands on a CLI GPU; on a CLI-only machine it is refused with the reason', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [arc, nvidia] })
    const job = await supervisor.startEngineJob(
      request({ initImage: { path: '/a/init.png', strength: 0.5 }, adapters: [{ path: '/l.safetensors', strength: 1 }] }),
    )
    expect(job.deviceUuid).toBe(nvidia.uuid)

    refreshGpuInventory.mockResolvedValue({ devices: [arc, amdA] })
    await expect(
      supervisor.startEngineJob(request({ prompt: 'img2img', initImage: { path: '/a/init.png', strength: 0.5 } })),
    ).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎只能文生图，不支持起始图，请移除后再生成（这台电脑上没有能运行完整引擎的显卡）',
    })
  })

  it('on a CLI-only machine prefers a discrete GPU over an integrated one', async () => {
    const igpu: GpuInventoryDevice = {
      uuid: 'vk-8086-a780-0',
      index: 0,
      name: 'Intel(R) UHD Graphics 770',
      vendor: 'intel',
      vulkanIndex: 1,
    }
    engines.set(igpu.uuid, deviceEngine('vulkan', igpu))
    currentEngineMachine.mockReturnValue({
      machine: {
        os: 'linux',
        systemCuda: [],
        rocm7: true,
        vulkanProbed: true,
        gpus: [
          { id: igpu.uuid, name: igpu.name, vendor: 'intel', vulkan: { index: 1, usable: true, discrete: false } },
          { id: arc.uuid, name: arc.name, vendor: 'intel', vulkan: { index: 2, usable: true, discrete: true } },
        ],
      },
    })
    refreshGpuInventory.mockResolvedValue({ devices: [igpu, arc] })
    const job = await supervisor.startEngineJob(request())
    expect(job.deviceUuid).toBe(arc.uuid)
  })

  it('a CLI GPU picked by hand runs plain jobs and refuses what its engine cannot do', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [arc, nvidia] })
    await expect(supervisor.startEngineJob(request({ deviceUuid: arc.uuid, references: { paths: ['/a/ref.png'] } }))).rejects.toMatchObject(
      { code: 'E_NOT_SUPPORTED', message: 'Intel Arc A770：兼容模式引擎只能文生图，不支持参考图，请移除后再生成' },
    )
    await expect(supervisor.startEngineJob(request({ deviceUuid: arc.uuid, sampling: { sampler: 'heun' } }))).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
    })
    const plain = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid, sampling: { sampler: 'euler', scheduler: 'moss' } }))
    expect(plain.deviceUuid).toBe(arc.uuid)
    expect(cliStarts).toHaveLength(1)
  })
})

describe('a GPU that switches engines between jobs', () => {
  it('to Vulkan: the moss-server it ran before is released before the CLI starts', async () => {
    const order: string[] = []
    releaseStaleMossInferRuntimes.mockImplementation(async (uuid?: string) => {
      order.push(`release:${uuid}`)
      return [uuid!]
    })
    runCliJob.mockImplementation(async (job: JobRecord, _params: unknown, opts: CliJobOptions, sink: MossInferSink) => {
      order.push('cli')
      cliStarts.push({ job, opts })
      sinks.set(job.id, sink)
    })
    const job = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
    await vi.waitFor(() => expect(order).toEqual([`release:${arc.uuid}`, 'cli']))
    const logs = await supervisor.getJobLogs(job.id)
    expect(logs.map((line) => line.text)).toContain('已停止这张显卡上之前的 CUDA 引擎，释放显存')
  })

  it('back to CUDA while a job waits behind a CLI job: the waiting job runs on moss-server', async () => {
    const server = join(dataRoot(), 'stable-v2.2.0-cu13', 'bin', 'moss-server')
    mkdirSync(join(server, '..'), { recursive: true })
    writeFileSync(server, '#!')
    const hello = decodeEngineHello({
      protocol_version: 2,
      probe: { devices: [{ index: 1, name: 'Intel Arc A770', supported: true, compute_capability: '8.9' }] },
    })
    probeLocalEngineGpuCompatibility.mockResolvedValue({ hello, helloFor: () => hello })
    const first = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid }))
    const second = await supervisor.startEngineJob(request({ deviceUuid: arc.uuid, prompt: 'second' }))
    expect(second.state).toBe('queued')
    // The GPU is switched to a CUDA package while the CLI job runs.
    engines.set(arc.uuid, { ...deviceEngine('cuda', arc), binaryPath: server })
    sinks.get(first.id)!.event({ type: 'result', images: [{ path: '/o.png', width: 1024, height: 1024, seed: 1 }] })
    sinks.get(first.id)!.done(0)
    await vi.waitFor(() => expect(runMossInferJob).toHaveBeenCalledTimes(1))
    expect(runMossInferJob.mock.calls[0]![0]).toMatchObject({ id: second.id })
    expect(cliStarts.map((start) => start.job.id)).toEqual([first.id])
  })
})

describe('automatic GPU assignment by what the model needs', () => {
  const rtx5090: GpuInventoryDevice = { uuid: 'GPU-5090', index: 1, name: 'RTX 5090', computeCapability: { major: 12, minor: 0 } }
  const hello = decodeEngineHello({
    protocol_version: 2,
    probe: {
      devices: [
        { index: 0, name: 'RTX 4090', supported: true, compute_capability: '8.9' },
        { index: 1, name: 'RTX 5090', supported: true, compute_capability: '12.0' },
      ],
    },
  })
  const nvfp4 = {
    id: 'moss-sft-nvfp4',
    name: 'SFT · NVFP4',
    components: { dit: 'nvfp4-dit', textEncoder: 'te-file', vae: 'vae-file' },
    support: 'cfg',
    tier: 'turbo',
    requires: { computeCapability: { major: 12, minor: 0 }, label: 'RTX 50 系列显卡' },
  }
  beforeEach(() => {
    const server = join(dataRoot(), 'stable-v2.2.0-cu13', 'bin', 'moss-server')
    mkdirSync(join(server, '..'), { recursive: true })
    writeFileSync(server, '#!')
    engines.set(nvidia.uuid, { ...deviceEngine('cuda', nvidia), binaryPath: server })
    engines.set(rtx5090.uuid, { ...deviceEngine('cuda', rtx5090), binaryPath: server })
    probeLocalEngineGpuCompatibility.mockResolvedValue({ hello, helloFor: () => hello })
    getCatalog.mockResolvedValue({
      bundles: [
        { id: 'moss-sft', name: 'MOSS-Image SFT', components: { dit: 'sft-dit', textEncoder: 'te', vae: 'vae' }, support: 'cfg' },
        nvfp4,
      ],
      models: [
        part('sft-dit', 'dit'),
        part('te', 'text_encoder'),
        part('vae', 'vae', 'fp32'),
        { ...part('nvfp4-dit', 'dit', 'nvfp4'), format: 'comfyui' },
        { ...part('te-file', 'text_encoder', 'int8'), format: 'comfyui' },
        { ...part('vae-file', 'vae', 'fp32'), format: 'comfyui' },
      ],
      adapters: [],
    })
  })
  const nvfp4Request = (prompt: string) =>
    request({ prompt, modelBinding: { bundleId: 'moss-sft-nvfp4', dit: 'nvfp4-dit', textEncoder: 'te-file', vae: 'vae-file' } })

  it('queues an NVFP4 job on the busy RTX 50 instead of the idle GPU that cannot run it', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [nvidia, rtx5090] })
    prepareModelSource.mockImplementation(async (binding: { bundleId: string }) =>
      binding.bundleId === nvfp4.id ? { model: bundle, ditFile: '/m/nvfp4.safetensors', bundle: nvfp4 } : { model: bundle },
    )
    const first = await supervisor.startEngineJob(request({ prompt: 'first' }))
    expect(first.deviceUuid).toBe(rtx5090.uuid)
    const second = await supervisor.startEngineJob(nvfp4Request('second'))
    expect(second).toMatchObject({ deviceUuid: rtx5090.uuid, state: 'queued', gpuProfile: { tier: 'turbo', source: 'model-weights' } })
    // A model every GPU runs still goes to the idle one.
    const third = await supervisor.startEngineJob(request({ prompt: 'third' }))
    expect(third.deviceUuid).toBe(nvidia.uuid)
  })

  it('refuses an NVFP4 job when no GPU can run it, and says why', async () => {
    refreshGpuInventory.mockResolvedValue({ devices: [nvidia] })
    await expect(supervisor.startEngineJob(nvfp4Request('nvfp4'))).rejects.toThrow(
      '「SFT · NVFP4」只能在 RTX 50 系列显卡上运行，请换一个模型',
    )
    expect(runMossInferJob).not.toHaveBeenCalled()
  })
})
