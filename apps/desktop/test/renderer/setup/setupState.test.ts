import { describe, expect, it } from 'vitest'
import {
  deriveSetup,
  modelDownloads,
  setupNeedLine,
  setupSpaceLabel,
  stepsToStart,
  type SetupInput,
} from '@renderer/pages/setup/setupState'
import type { LocalEngineVersion, ModelSpaceDisk, OnboardingStatus } from '@shared/types'
import { RELEASE_220, enginePlanFor, inventoryDevicesFor, machineFixture, type MachineName } from '@test/mocks/backend/machines'
import {
  FIXTURE_NOW,
  GiB,
  GPU_RTX_3060,
  SFT_BUNDLE_IDS,
  downloadFixture,
  engineDownloadFixture,
  engineMissingFixture,
  engineReadyFixture,
  gpuDeviceFixture,
  gpuInventoryFixture,
} from '@test/mocks/backend/fixtures'

function onboarding(model: 'ok' | 'missing' | 'partial', sizeBytes = 12 * GiB): OnboardingStatus {
  return {
    hostId: 'local',
    bundleId: 'moss-sft',
    bundleName: 'MossDiT SFT',
    ready: false,
    checkedAt: FIXTURE_NOW,
    steps: [
      { id: 'device', status: 'ok', title: '推理设备', detail: '', action: 'devices' },
      { id: 'engine', status: 'missing', title: '引擎', detail: '', action: 'engines' },
      {
        id: 'model',
        status: model,
        title: '模型',
        detail: '',
        action: 'models',
        modelIds: [...SFT_BUNDLE_IDS],
        sizeBytes: model === 'ok' ? 0 : sizeBytes,
      },
    ],
  }
}

function input(patch: Partial<SetupInput> = {}): SetupInput {
  return {
    gpu: gpuInventoryFixture(),
    gpuSelection: 'auto',
    engine: engineMissingFixture(),
    engineDownload: null,
    onboarding: onboarding('missing'),
    downloads: [],
    ...patch,
  }
}

const states = (view: ReturnType<typeof deriveSetup>): string[] => view.steps.map((step) => step.state)

describe('deriveSetup', () => {
  it('is checking until it knows what is installed', () => {
    const view = deriveSetup(input({ gpu: null, engine: null, onboarding: null }))
    expect(view.phase).toBe('checking')
    expect(view.steps[0]).toMatchObject({ state: 'running', detail: '正在检测显卡…' })
  })

  it('waits for 开始准备 once the GPU is found', () => {
    const view = deriveSetup(input())
    expect(view.phase).toBe('idle')
    expect(states(view)).toEqual(['done', 'waiting', 'waiting'])
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce RTX 4090 · 24 GB')
    expect(view.steps[2]!.detail).toBe('MossDiT SFT · 12 GB')
    expect(stepsToStart(view)).toEqual(['engine', 'model'])
  })

  it('describes the chosen GPU and mentions the others', () => {
    const view = deriveSetup(
      input({ gpu: gpuInventoryFixture([gpuDeviceFixture(), GPU_RTX_3060()]), gpuSelection: { uuid: GPU_RTX_3060().uuid } }),
    )
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce RTX 3060 · 12 GB · 共 2 块')
  })

  it('is blocked without a usable GPU', () => {
    const view = deriveSetup(input({ gpu: gpuInventoryFixture([]) }))
    expect(view.phase).toBe('blocked')
    expect(states(view)).toEqual(['blocked', 'blocked', 'blocked'])
    expect(view.steps[0]!.detail).toBe('没有找到能用的显卡')
    expect(stepsToStart(view)).toEqual([])
  })

  it('shows engine and model progress while running', () => {
    const view = deriveSetup(
      input({
        engineDownload: engineDownloadFixture({ bytes: 186 * 1024 ** 2, totalBytes: 290 * 1024 ** 2, percent: 64 }),
        downloads: [
          downloadFixture({ targetId: SFT_BUNDLE_IDS[0], state: 'running', bytes: 2 * GiB, totalBytes: 8 * GiB }),
          downloadFixture({ targetId: SFT_BUNDLE_IDS[1], state: 'done', bytes: 2 * GiB, totalBytes: 2 * GiB }),
        ],
      }),
    )
    expect(view.phase).toBe('running')
    expect(view.steps[1]).toMatchObject({ state: 'running', detail: 'MossInfer · 正在下载 186 MB / 290 MB', percent: 64 })
    expect(view.steps[2]).toMatchObject({ state: 'running', detail: 'MossDiT SFT · 正在下载 4.0 GB / 10 GB', percent: 40 })
  })

  it('says queued when downloads have not started', () => {
    const view = deriveSetup(input({ downloads: [downloadFixture({ targetId: SFT_BUNDLE_IDS[0], state: 'queued' })] }))
    expect(view.steps[2]!.detail).toBe('MossDiT SFT · 排队中')
  })

  it('ignores remote downloads and other models', () => {
    const tasks = [
      downloadFixture({ targetId: SFT_BUNDLE_IDS[0], hostId: 'ssh-gpu', state: 'running' }),
      downloadFixture({ targetId: 'other-model', state: 'running' }),
    ]
    expect(modelDownloads(onboarding('missing'), tasks)).toEqual([])
    expect(deriveSetup(input({ downloads: tasks })).steps[2]!.state).toBe('waiting')
  })

  it('shows failures with a way to retry', () => {
    const view = deriveSetup(
      input({
        engineDownload: engineDownloadFixture({ phase: 'error', error: '下载中断，请检查网络' }),
        downloads: [downloadFixture({ targetId: SFT_BUNDLE_IDS[0], state: 'error', error: '磁盘空间不足' })],
      }),
    )
    expect(view.phase).toBe('error')
    expect(view.steps[1]).toMatchObject({ state: 'error', detail: '下载中断，请检查网络' })
    expect(view.steps[2]).toMatchObject({ state: 'error', detail: '磁盘空间不足' })
    expect(stepsToStart(view)).toEqual(['engine', 'model'])
  })

  it('reports a preflight failure such as an old driver', () => {
    const view = deriveSetup(input({ engineError: '显卡驱动版本过旧' }))
    expect(view.steps[1]).toMatchObject({ state: 'error', detail: '显卡驱动版本过旧' })
  })

  it('shows parts that are already installed as done', () => {
    const view = deriveSetup(input({ engine: engineReadyFixture() }))
    expect(states(view)).toEqual(['done', 'done', 'waiting'])
    expect(stepsToStart(view)).toEqual(['model'])
  })

  it('is done when everything is in place', () => {
    const view = deriveSetup(input({ engine: engineReadyFixture(), onboarding: onboarding('ok') }))
    expect(view.phase).toBe('done')
    expect(view.steps[2]!.detail).toBe('MossDiT SFT 已就绪')
    expect(setupSpaceLabel(view)).toBeNull()
  })

  it('keeps a working engine done even if its last update failed', () => {
    const view = deriveSetup(input({ engine: engineReadyFixture(), engineDownload: engineDownloadFixture({ phase: 'error', error: 'x' }) }))
    expect(view.steps[1]!.state).toBe('done')
  })
})

describe('setupSpaceLabel', () => {
  it('adds the engine to what the model still needs', () => {
    expect(setupSpaceLabel(deriveSetup(input()))).toBe('约 13 GB')
    expect(setupSpaceLabel(deriveSetup(input({ engine: engineReadyFixture(), onboarding: onboarding('partial', 300 * 1024 ** 2) })))).toBe(
      '约 300 MB',
    )
  })
})

describe('deriveSetup with the engine plan', () => {
  const planFor = (name: MachineName, versions: LocalEngineVersion[] = []) =>
    enginePlanFor(machineFixture(name), RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, versions)
  const managed = (name: string): LocalEngineVersion => ({ id: name, name, path: `/e/${name}`, current: true, source: 'managed' })

  it('keeps checking while the GPUs are being probed', () => {
    const view = deriveSetup(input({ plan: null }))
    expect(view.phase).toBe('checking')
    expect(view.steps[0]).toMatchObject({ state: 'running', detail: '正在检测显卡…' })
  })

  it('lists what each GPU gets and what the download costs', () => {
    const view = deriveSetup(input({ plan: planFor('nvidia') }))
    expect(view.phase).toBe('idle')
    expect(view.lines.map((line) => line.detail)).toEqual(['CUDA 13 引擎 · 352 MB'])
    expect(view.steps[1]!.detail).toBe('MossInfer · 352 MB')
    expect(view.engineBytes).toBe(368693986)
  })

  it('several GPUs: several packages in one install', () => {
    const view = deriveSetup(input({ plan: planFor('multiGpu') }))
    expect(view.steps[1]!.detail).toMatch(/^MossInfer · 3 个引擎包，共 /)
    expect(view.lines).toHaveLength(3)
  })

  it('an AMD GPU without ROCm still prepares, with the ROCm tip as a quiet note', () => {
    const view = deriveSetup(input({ plan: planFor('amd') }))
    expect(view.phase).toBe('idle')
    expect(view.lines[0]).toMatchObject({
      detail: '兼容模式 · 1.2 MB',
      tip: expect.stringContaining('ROCm 7'),
      note: expect.stringContaining('只能文生图'),
    })
  })

  it('is blocked on macOS and says why', () => {
    const view = deriveSetup(input({ gpu: gpuInventoryFixture([]), plan: planFor('macos') }))
    expect(view.phase).toBe('blocked')
    expect(view.os).toBe('macos')
    expect(view.steps[0]!.detail).toContain('macOS')
    expect(view.lines).toEqual([])
    expect(stepsToStart(view)).toEqual([])
  })

  it('an engine for one GPU is not done while another GPU still misses its package', () => {
    const view = deriveSetup(input({ engine: engineReadyFixture(), plan: planFor('multiGpu', [managed('stable-v2.2.0-cu13')]) }))
    expect(view.steps[1]).toMatchObject({ state: 'waiting', detail: expect.stringContaining('还需为其他显卡下载 2 个引擎包') })
    expect(stepsToStart(view)).toContain('engine')
    const all = deriveSetup(
      input({
        engine: engineReadyFixture(),
        plan: planFor('multiGpu', ['stable-v2.2.0-cu13', 'stable-v2.2.0-cu12-sm70', 'stable-v2.2.0-vulkan'].map(managed)),
      }),
    )
    expect(all.steps[1]!.state).toBe('done')
  })

  it("uses the plan's size for the space sentence", () => {
    expect(setupSpaceLabel(deriveSetup(input({ plan: planFor('intel'), onboarding: onboarding('partial', 300 * 1024 ** 2) })))).toBe(
      '约 301 MB',
    )
  })
})

describe('deriveSetup: can this computer run it, and how fast', () => {
  /** A first run on one of the mock machines: its plan and the GPU inventory that goes with it. */
  const on = (name: MachineName, patch: Partial<SetupInput> = {}): ReturnType<typeof deriveSetup> => {
    const machine = machineFixture(name)
    return deriveSetup(
      input({
        gpu: gpuInventoryFixture(inventoryDevicesFor(machine)),
        plan: enginePlanFor(machine, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, []),
        systemMemoryBytes: 32 * GiB,
        ...patch,
      }),
    )
  }

  it('a GPU the engine cannot use: blocked, with the card and the reason', () => {
    const view = on('unusableGpu')
    expect(view.phase).toBe('blocked')
    expect(view.steps[0]!.detail).toBe('Intel(R) UHD Graphics 620 不支持 Vulkan 1.2，引擎没法在它上面运行。')
    expect(stepsToStart(view)).toEqual([])
  })

  it('a GPU with 2 GB: blocked, with how much it has and how much it needs', () => {
    const view = on('tinyGpu')
    expect(view.phase).toBe('blocked')
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce GT 1030 只有 2 GB 显存，至少需要 4 GB。')
    expect(stepsToStart(view)).toEqual([])
  })

  it('a GPU whose memory is not known is never blocked on memory', () => {
    const machine = machineFixture('tinyGpu')
    const unknown = { ...machine, gpus: [{ ...machine.gpus[0]!, memoryBytes: undefined }] }
    const view = deriveSetup(
      input({
        gpu: gpuInventoryFixture(inventoryDevicesFor(unknown)),
        plan: enginePlanFor(unknown, RELEASE_220, { engineDeviceOverrides: {}, mossInferChannel: 'stable' }, []),
      }),
    )
    expect(view.phase).toBe('idle')
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce GT 1030 · 显存未知 · 兼容模式')
  })

  it('a fast computer: no slow line', () => {
    const view = on('nvidia')
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce RTX 4090 · 24 GB')
    expect(view.slow).toBeUndefined()
  })

  it('兼容模式: the GPU line says so, and that it will be very slow', () => {
    const view = on('intel', { systemMemoryBytes: 8 * GiB })
    expect(view.phase).toBe('idle')
    // Vulkan reports no memory size for a non-NVIDIA card.
    expect(view.steps[0]!.detail).toBe('Intel(R) Arc(TM) A770 Graphics · 显存未知 · 兼容模式')
    // 兼容模式 comes before memory.
    expect(view.slow).toBe('能用，但会很慢：一张图可能要几分钟甚至更久。')
  })

  it('a 6 GB card: slower, says how much memory it has', () => {
    expect(on('smallGpu', { systemMemoryBytes: 8 * GiB }).slow).toBe('显存 6 GB，能用，生成会慢一些。')
  })

  it('under 16 GB of system memory: slower, and still not blocked', () => {
    const view = on('nvidia', { systemMemoryBytes: 7.7 * GiB })
    expect(view.phase).toBe('idle')
    expect(view.slow).toBe('内存 8 GB，能用，生成会慢一些。')
    expect(on('nvidia', { systemMemoryBytes: 15.6 * GiB }).slow).toBeUndefined()
  })

  it('a 16 GB laptop whose integrated GPU reserves memory (13.5 GiB reported) is not warned; 13.4 GiB is', () => {
    expect(on('nvidia', { systemMemoryBytes: 13.5 * GiB }).slow).toBeUndefined()
    expect(on('nvidia', { systemMemoryBytes: 13.4 * GiB }).slow).toBe('内存 13 GB，能用，生成会慢一些。')
  })

  it('without the machine probe, an NVIDIA card is still judged on its own memory', () => {
    const view = deriveSetup(input({ gpu: gpuInventoryFixture([gpuDeviceFixture({ memoryTotalBytes: 6 * GiB })]), plan: undefined }))
    expect(view.slow).toBe('显存 6 GB，能用，生成会慢一些。')
  })

  it('a laptop whose 2 GB card is too small still runs on its integrated GPU: not blocked, slow', () => {
    const machine = machineFixture('laptopSmallGpu')
    const inventory = gpuInventoryFixture(inventoryDevicesFor(machine))
    // Main recommends the GPU that can run the model (recommendedGpu).
    const view = on('laptopSmallGpu', { gpu: { ...inventory, recommendedGpuUuid: machine.gpus[1]!.id } })
    expect(view.phase).toBe('idle')
    expect(view.steps[0]!.detail).toBe('Intel(R) UHD Graphics 620 · 显存未知 · 兼容模式 · 共 2 块')
    expect(view.slow).toBe('能用，但会很慢：一张图可能要几分钟甚至更久。')
  })

  it('the line under a block says what is needed, naming memory when memory is the reason', () => {
    expect(setupNeedLine(on('unusableGpu'))).toBe('需要 NVIDIA RTX 30 及更新的显卡，或支持 Vulkan 1.2 的显卡。')
    expect(setupNeedLine(on('tinyGpu'))).toBe('需要显存至少 4 GB 的显卡：NVIDIA RTX 30 及更新，或支持 Vulkan 1.2 的显卡。')
    expect(setupNeedLine(on('macos'))).toBeNull()
  })

  it('says nothing about speed while blocked', () => {
    expect(on('tinyGpu', { systemMemoryBytes: 8 * GiB }).slow).toBeUndefined()
  })
})

describe('deriveSetup: room for the download', () => {
  const disk = (freeBytes: number | null, missingBytes: number[], patch: Partial<ModelSpaceDisk> = {}): ModelSpaceDisk => ({
    path: '/fixture/data/models',
    modelsFolder: true,
    freeBytes,
    missingBytes,
    ...patch,
  })
  const short = (...disks: ModelSpaceDisk[]): string | undefined => deriveSetup(input({ disks })).diskShort

  it('a models folder with too little room says what it has and what to look for', () => {
    // (12 GiB + 1 GiB headroom) × 1.1 = 14.3 GiB, as the check on start asks.
    expect(short(disk(10 * GiB, [12 * GiB]))).toBe('这个位置只剩 10 GB，换一个有 15 GB 空闲的位置。')
  })

  it('rounds what is left down and what is needed up, so the two never read the same', () => {
    expect(short(disk(14.2 * GiB, [12 * GiB]))).toBe('这个位置只剩 14 GB，换一个有 15 GB 空闲的位置。')
  })

  it('a full disk reads 0 GB', () => {
    expect(short(disk(0, [12 * GiB]))).toBe('这个位置只剩 0 GB，换一个有 15 GB 空闲的位置。')
  })

  it('parts on one disk add up, each with its own headroom', () => {
    // (8 + 1) × 1.1 + (4 + 1) × 1.1 = 15.4 GiB: each part alone would fit in 14.9 GiB.
    expect(short(disk(14.9 * GiB, [8 * GiB, 4 * GiB]))).toBe('这个位置只剩 14 GB，换一个有 16 GB 空闲的位置。')
  })

  it('a part with its own folder names that folder and where to change it: 更改 would not move it', () => {
    expect(short(disk(900 * GiB, [1 * GiB]), disk(5 * GiB, [12 * GiB], { path: 'D:\\moss\\dit', modelsFolder: false }))).toBe(
      'D:\\moss\\dit 只剩 5 GB，需要 15 GB 空闲：到「设置 › 存储」给它换个位置。',
    )
  })

  it('when both are short, the models folder comes first: 更改 fixes it right here', () => {
    expect(short(disk(5 * GiB, [12 * GiB], { path: 'D:\\dit', modelsFolder: false }), disk(1 * GiB, [4 * GiB]))).toBe(
      '这个位置只剩 1 GB，换一个有 6 GB 空闲的位置。',
    )
  })

  it('a folder with room enough, or whose free space is not known, says nothing', () => {
    expect(short(disk(15 * GiB, [12 * GiB]))).toBeUndefined()
    expect(short(disk(null, [12 * GiB]))).toBeUndefined()
    expect(deriveSetup(input()).diskShort).toBeUndefined()
  })

  it('counts only what is still missing: a partial download with 300 MB left fits in 2 GB', () => {
    expect(short(disk(2 * GiB, [300 * 1024 ** 2]))).toBeUndefined()
    expect(short(disk(0, []))).toBeUndefined()
  })
})
