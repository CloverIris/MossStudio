import { describe, expect, it } from 'vitest'
import { deriveSetup, modelDownloads, setupSpaceLabel, stepsToStart, type SetupInput } from '@renderer/pages/setup/setupState'
import type { OnboardingStatus } from '@shared/types'
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
    hostId: 'local', bundleId: 'moss-sft', bundleName: 'MossDiT SFT', ready: false, checkedAt: FIXTURE_NOW,
    steps: [
      { id: 'device', status: 'ok', title: '推理设备', detail: '', action: 'devices' },
      { id: 'engine', status: 'missing', title: '引擎', detail: '', action: 'engines' },
      { id: 'model', status: model, title: '模型', detail: '', action: 'models', modelIds: [...SFT_BUNDLE_IDS], sizeBytes: model === 'ok' ? 0 : sizeBytes },
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
    const view = deriveSetup(input({ gpu: gpuInventoryFixture([gpuDeviceFixture(), GPU_RTX_3060()]), gpuSelection: { uuid: GPU_RTX_3060().uuid } }))
    expect(view.steps[0]!.detail).toBe('NVIDIA GeForce RTX 3060 · 12 GB · 共 2 块')
  })

  it('is blocked without an NVIDIA GPU', () => {
    const view = deriveSetup(input({ gpu: gpuInventoryFixture([]) }))
    expect(view.phase).toBe('blocked')
    expect(states(view)).toEqual(['blocked', 'blocked', 'blocked'])
    expect(view.steps[0]!.detail).toBe('没有找到 NVIDIA 显卡')
    expect(stepsToStart(view)).toEqual([])
  })

  it('shows engine and model progress while running', () => {
    const view = deriveSetup(input({
      engineDownload: engineDownloadFixture({ bytes: 186 * 1024 ** 2, totalBytes: 290 * 1024 ** 2, percent: 64 }),
      downloads: [
        downloadFixture({ targetId: SFT_BUNDLE_IDS[0], state: 'running', bytes: 2 * GiB, totalBytes: 8 * GiB }),
        downloadFixture({ targetId: SFT_BUNDLE_IDS[1], state: 'done', bytes: 2 * GiB, totalBytes: 2 * GiB }),
      ],
    }))
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
    const view = deriveSetup(input({
      engineDownload: engineDownloadFixture({ phase: 'error', error: '下载中断，请检查网络' }),
      downloads: [downloadFixture({ targetId: SFT_BUNDLE_IDS[0], state: 'error', error: '磁盘空间不足' })],
    }))
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
    expect(setupSpaceLabel(deriveSetup(input({ engine: engineReadyFixture(), onboarding: onboarding('partial', 300 * 1024 ** 2) })))).toBe('约 300 MB')
  })
})
