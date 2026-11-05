/**
 * Port of tools/test-onboarding.mjs (the old script hand-transpiled TS and broke
 * when onboarding switched to engineReadiness). Every collaborator is mocked;
 * the catalog is the real release/models.json via catalogFixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Catalog, LaunchDevice, TrainingHost } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { SFT_BUNDLE_IDS, catalogFixture, engineMissingFixture, engineReadyFixture, settingsFixture } from '@test/mocks/backend/fixtures'

interface Options {
  installed?: string[]
  partial?: string
  remoteInstalled?: string[]
  engine?: boolean
  legacy?: boolean
  noGpu?: boolean
  offline?: boolean
  amd?: boolean
  /** Engine kinds the local GPUs run (default: CUDA). */
  kinds?: Array<'cuda' | 'vulkan' | 'hip'>
}
const state: { options: Options } = { options: {} }

vi.mock('@main/services/devices', () => ({
  listDevices: (): LaunchDevice[] => state.options.noGpu
    ? [{ id: 'mps', name: 'Apple', kind: 'mps', detail: '', available: true }]
    : [{ id: 'cuda:0', name: 'NVIDIA', kind: 'cuda', detail: '', available: true }],
  cachedGpuInventory: () => state.options.amd
    ? { scannedAt: '', status: 'ok', devices: [{ uuid: 'vk-1002-744c-0', index: 0, name: 'AMD Radeon RX 7900 XTX', vendor: 'amd' }] }
    : null,
}))
vi.mock('@main/services/engineInstalls', () => ({ localEngineKinds: () => state.options.kinds ?? ['cuda'] }))
vi.mock('@main/services/models', () => ({
  getCatalog: async (): Promise<Catalog> => catalogFixture({ installed: state.options.installed, partial: state.options.partial ? [state.options.partial] : [] }),
}))
vi.mock('@main/services/modelReadiness', () => ({ legacyModelReady: async () => state.options.legacy ?? false }))
vi.mock('@main/services/engineReadiness', () => ({
  engineReadiness: async () => (state.options.engine ? engineReadyFixture() : engineMissingFixture()),
}))
vi.mock('@main/services/trainingHosts', () => ({
  getTrainingHost: (_settings: unknown, id: string): TrainingHost | undefined =>
    id === 'ssh-a' ? { id, name: 'Remote', kind: 'ssh', trainerRoot: '~', status: 'ok' } : undefined,
}))
vi.mock('@main/services/remoteEngine', () => ({
  remoteEngineStatus: async () => ({ online: !state.options.offline, available: state.options.engine ?? false, gpu: state.options.noGpu ? '' : 'NVIDIA' }),
}))
vi.mock('@main/services/remoteModels', () => ({
  scanRemoteModels: async (_host: unknown, catalog: Catalog) => ({
    models: catalog.models.map((model) => ({ id: model.id, installed: state.options.remoteInstalled?.includes(model.id) ?? false })),
  }),
}))

useTempDataRoot()
const settings = settingsFixture()
const sft = [...SFT_BUNDLE_IDS]
const originalPlatform = process.platform
const result = (value: Awaited<ReturnType<typeof status>>): string | undefined => value.bundleName

async function status(options: Options = {}, hostId?: string, platform: NodeJS.Platform = 'win32') {
  state.options = options
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    const { getOnboardingStatus } = await import('@main/services/onboarding')
    return await getOnboardingStatus(settings, hostId)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  }
}
const step = (result: Awaited<ReturnType<typeof status>>, id: 'device' | 'engine' | 'model') => result.steps.find((item) => item.id === id)!

beforeEach(() => vi.resetModules())

describe('getOnboardingStatus (local)', () => {
  it('lists device, engine and model requirements on first run', async () => {
    const result = await status()
    expect(result.steps.map((item) => item.id)).toEqual(['device', 'engine', 'model'])
    expect(result.ready).toBe(false)
    expect(result.hostId).toBe('local')
    expect(step(result, 'device')).toMatchObject({ status: 'ok', detail: 'NVIDIA' })
    expect(step(result, 'engine')).toMatchObject({ status: 'missing', action: 'engines', detail: engineMissingFixture().reason })
    expect(step(result, 'model').modelIds).toEqual(sft)
    expect(step(result, 'model').detail).toMatch(/0\/4/)
    expect(result.bundleId).toBe('moss-sft')
  })

  it('is ready with an engine and the full recommended bundle', async () => {
    const result = await status({ engine: true, installed: sft })
    expect(result.ready).toBe(true)
    expect(step(result, 'engine').detail).toBe('MossInfer 已就绪')
    expect(step(result, 'model')).toMatchObject({ status: 'ok', sizeBytes: 0, detail: 'MOSS-Image SFT 已就绪' })
  })

  it('does not let partial downloads complete a bundle and only counts missing bytes', async () => {
    const result = await status({ engine: true, installed: sft.slice(1, 3), partial: 'moss-sft-dit' })
    expect(result.ready).toBe(false)
    expect(step(result, 'model').status).toBe('partial')
    expect(step(result, 'model').detail).toMatch(/2\/4/)
    const catalog = catalogFixture()
    const expected = catalog.models.filter((model) => ['moss-sft-dit', 'moss-pipeline'].includes(model.id)).reduce((sum, model) => sum + model.sizeBytes, 0)
    expect(step(result, 'model').sizeBytes).toBe(expected)
  })

  it('accepts an installed Base bundle instead of forcing an SFT download', async () => {
    const result = await status({ engine: true, installed: ['moss-base-dit', ...sft.slice(1)] })
    expect(result.bundleId).toBe('moss-base')
    expect(result.ready).toBe(true)
  })

  it('reuses a partially prepared Base bundle main model', async () => {
    const result = await status({ engine: true, installed: ['moss-base-dit', 'flux2-vae-small'] })
    expect(result.bundleId).toBe('moss-base')
    expect(step(result, 'model').status).toBe('partial')
    expect(step(result, 'model').detail).toMatch(/2\/4/)
    expect(result.ready).toBe(false)
  })

  it('recognises a complete legacy model while macOS still needs an NVIDIA host', async () => {
    const result = await status({ engine: true, legacy: true, noGpu: true }, undefined, 'darwin')
    expect(result.ready).toBe(false)
    expect(step(result, 'device').status).toBe('missing')
    expect(step(result, 'device').detail).toMatch(/SSH/)
    expect(step(result, 'model').status).toBe('ok')
  })

  it('explains the missing GPU differently off macOS', async () => {
    const result = await status({ noGpu: true }, undefined, 'linux')
    expect(step(result, 'device').detail).toBe('需要一块能运行引擎的显卡（NVIDIA、AMD 或 Intel）；也可以添加 Linux NVIDIA SSH 主机')
  })

  it('an AMD or Intel GPU found by the engine probe counts as a local device', async () => {
    const result = await status({ noGpu: true, amd: true }, undefined, 'linux')
    expect(step(result, 'device')).toMatchObject({ status: 'ok', detail: 'AMD Radeon RX 7900 XTX' })
  })

  it('counts single-file ComfyUI weights with the runtime config instead of asking for BF16 diffusers', async () => {
    const installed = ['moss-sft-comfy-int8_convrot', 'qwen35-comfy-w4a8_gptq', 'flux2-vae-small', 'moss-runtime-config']
    const result = await status({ engine: true, installed })
    expect(result.bundleName).toBe('MossInfer 单文件组合')
    expect(step(result, 'model').modelIds).toEqual(installed)
    expect(result.ready).toBe(true)
  })

  it('a Vulkan / HIP-only machine needs the bf16 bundle: no fp16 DiT, no single-file combination', async () => {
    const fp16 = ['moss-sft-fp16-fixed', 'qwen35-encoder', 'flux2-vae-small', 'moss-pipeline']
    const cuda = await status({ engine: true, installed: fp16 })
    expect(result(cuda)).toBe('SFT · FP16-fixed')
    const vulkan = await status({ engine: true, installed: fp16, kinds: ['vulkan'] })
    expect(step(vulkan, 'model').modelIds).toEqual(sft)
    expect(vulkan.ready).toBe(false)
    const single = ['moss-sft-comfy-int8_convrot', 'qwen35-comfy-w4a8_gptq', 'flux2-vae-small', 'moss-runtime-config']
    expect((await status({ engine: true, installed: single, kinds: ['hip'] })).bundleName).not.toBe('MossInfer 单文件组合')
    // A machine with a CUDA GPU next to a Vulkan one keeps every bundle.
    expect(result(await status({ engine: true, installed: fp16, kinds: ['cuda', 'vulkan'] }))).toBe('SFT · FP16-fixed')
  })

  it('keeps the regular bundle when single-file weights would not cover more components', async () => {
    const result = await status({ engine: true, installed: ['moss-sft-comfy-int8_convrot', ...sft.slice(1)] })
    expect(result.bundleName).toBe('MOSS-Image SFT')
    expect(step(result, 'model').detail).toMatch(/3\/4/)
  })
})

describe('getOnboardingStatus (remote)', () => {
  it('never combines local models with a remote engine', async () => {
    const result = await status({ engine: true, installed: sft }, 'ssh-a')
    expect(result.hostId).toBe('ssh-a')
    expect(result.ready).toBe(false)
    expect(step(result, 'model').status).toBe('missing')
  })

  it('lets the selected remote host complete its own checklist', async () => {
    const result = await status({ engine: true, remoteInstalled: sft }, 'ssh-a')
    expect(result.ready).toBe(true)
    expect(step(result, 'engine').detail).toBe('Remote · MossInfer 已安装')
  })

  it('is not ready when the remote host is offline or lacks a GPU', async () => {
    const offline = await status({ engine: true, installed: sft, offline: true }, 'ssh-a')
    expect(offline.ready).toBe(false)
    expect(step(offline, 'device').detail).toBe('SSH 未连接，请在设备页检查连接')
    expect(step(offline, 'engine').status).toBe('missing')
    const noGpu = await status({ engine: true, remoteInstalled: sft, noGpu: true }, 'ssh-a')
    expect(step(noGpu, 'device')).toMatchObject({ status: 'missing', detail: '远端未检测到 NVIDIA GPU' })
  })

  it('rejects a host that has been removed', async () => {
    await expect(status({}, 'removed-host')).rejects.toThrow(/重新选择/)
  })
})
