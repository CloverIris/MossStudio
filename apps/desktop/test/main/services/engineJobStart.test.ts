import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineFeatures } from '@shared/types'
import { cliEngineFeatures } from '@shared/cliEngine'
import { codedError, errorCode } from '@main/lib/codedError'
import { useTempDataRoot } from '@test/helpers/tempDir'

const startEngineJob = vi.hoisted(() => vi.fn())
const getEngineFeatures = vi.hoisted(() => vi.fn())
const resolveCanvasAdapters = vi.hoisted(() => vi.fn())
vi.mock('@main/services/supervisor', () => ({ startEngineJob }))
vi.mock('@main/services/engineFeatures', () => ({ getEngineFeatures }))
vi.mock('@main/services/adapterResolution', () => ({ resolveCanvasAdapters }))

const dataRoot = useTempDataRoot()
let start: typeof import('@main/services/engineJobStart')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const features: EngineFeatures = {
  preview: true,
  imageInput: true,
  control: true,
  references: true,
  hires: true,
  samplers: true,
  lora: true,
  values: {},
}

function put(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, PNG)
  return path
}

beforeEach(async () => {
  vi.resetModules()
  startEngineJob.mockReset().mockImplementation(async (input: unknown) => ({ id: 'job-1', input }))
  getEngineFeatures.mockReset().mockResolvedValue(features)
  resolveCanvasAdapters.mockReset().mockResolvedValue([{ path: '/m/lora.safetensors', strength: 1 }])
  mkdirSync(join(dataRoot(), 'outputs'), { recursive: true })
  start = await import('@main/services/engineJobStart')
})

const base = {
  prompt: 'a cat',
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 4,
  seed: 1,
  projectId: 'project-1',
  adapters: [{ id: 'lora', strength: 1 }],
}

describe('startRequestedEngineJob', () => {
  it('starts a plain job without LoRAs without asking the engine anything', async () => {
    resolveCanvasAdapters.mockResolvedValue([])
    await start.startRequestedEngineJob({ ...base, adapters: [] })
    expect(startEngineJob).toHaveBeenCalledWith({ ...base, adapters: [] })
    expect(getEngineFeatures).not.toHaveBeenCalled()
  })

  it('resolves LoRAs and checks the target engine takes them', async () => {
    await start.startRequestedEngineJob({ ...base, deviceUuid: 'GPU-a' })
    expect(startEngineJob).toHaveBeenCalledWith({ ...base, deviceUuid: 'GPU-a', adapters: [{ path: '/m/lora.safetensors', strength: 1 }] })
    expect(getEngineFeatures).toHaveBeenCalledWith({ deviceUuid: 'GPU-a', hostId: undefined })
  })

  it('refuses LoRAs on a CLI engine (兼容模式 / AMD 原生) and never queues the job', async () => {
    getEngineFeatures.mockResolvedValue(cliEngineFeatures('vulkan'))
    await expect(start.startRequestedEngineJob({ ...base, deviceUuid: 'vk-1002-744c-0' })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎不支持 LoRA，请移除 LoRA 后再生成',
    })
    getEngineFeatures.mockResolvedValue(cliEngineFeatures('hip'))
    await expect(start.startRequestedEngineJob({ ...base, deviceUuid: 'vk-1002-744c-0' })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: 'AMD 原生引擎不支持 LoRA，请移除 LoRA 后再生成',
    })
    expect(startEngineJob).not.toHaveBeenCalled()
  })

  it('refuses pictures and sampling a CLI engine cannot do, saying an update will not help', async () => {
    resolveCanvasAdapters.mockResolvedValue([])
    getEngineFeatures.mockResolvedValue(cliEngineFeatures('vulkan'))
    const init = put(join(dataRoot(), 'projects', 'project-1', 'assets', 'init.png'))
    await expect(start.startRequestedEngineJob({ ...base, adapters: [], initImage: { path: init, strength: 0.5 } })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎只能文生图，不支持起始图，请移除后再生成',
    })
    await expect(start.startRequestedEngineJob({ ...base, adapters: [], sampling: { cfgTruncation: 0.4 } })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎只能文生图，不支持CFG 截断，请移除后再生成',
    })
    await expect(start.startRequestedEngineJob({ ...base, adapters: [], sampling: { stepCache: 'fbcache' } })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎只能文生图，不支持步缓存，请移除后再生成',
    })
    expect(startEngineJob).not.toHaveBeenCalled()
    await expect(start.startRequestedEngineJob({ ...base, adapters: [], sampling: { sampler: 'heun' } })).rejects.toMatchObject({
      code: 'E_NOT_SUPPORTED',
      message: '兼容模式引擎只能文生图，不支持更换采样器，请移除后再生成',
    })
    expect(startEngineJob).not.toHaveBeenCalled()
    // Shift is a CLI flag, and euler / moss are what the CLI runs: they go through.
    await start.startRequestedEngineJob({ ...base, adapters: [], sampling: { shift: 4 } })
    await start.startRequestedEngineJob({ ...base, adapters: [], sampling: { sampler: 'euler', scheduler: 'moss' } })
    expect(startEngineJob).toHaveBeenCalledTimes(2)
  })

  it('accepts pictures from the project assets and the outputs, checked against the target engine', async () => {
    const init = put(join(dataRoot(), 'projects', 'project-1', 'assets', 'init.png'))
    const ref = put(join(dataRoot(), 'outputs', 'ref.png'))
    await start.startRequestedEngineJob({
      ...base,
      deviceUuid: 'GPU-a',
      initImage: { path: init, strength: 0.5 },
      references: { paths: [ref] },
      mask: null,
    })
    expect(getEngineFeatures).toHaveBeenCalledWith({ deviceUuid: 'GPU-a', hostId: undefined })
    const input = startEngineJob.mock.calls[0]![0] as Record<string, unknown>
    expect(input['initImage']).toEqual({ path: init, strength: 0.5 })
    expect(input['references']).toEqual({ paths: [ref] })
    expect(input).not.toHaveProperty('mask')
  })

  it("refuses another project's picture and never queues the job", async () => {
    const other = put(join(dataRoot(), 'projects', 'project-2', 'assets', 'init.png'))
    await expect(start.startRequestedEngineJob({ ...base, initImage: { path: other, strength: 0.5 } })).rejects.toMatchObject({
      code: 'E_INPUT_PATH',
    })
    expect(startEngineJob).not.toHaveBeenCalled()
  })

  it('allows no project assets for a request without a valid project id', async () => {
    const init = put(join(dataRoot(), 'projects', 'project-1', 'assets', 'init.png'))
    await expect(
      start.startRequestedEngineJob({ ...base, projectId: '../project-1', initImage: { path: init, strength: 0.5 } }),
    ).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
  })

  it('refuses a control adapter that is not registered, and control on an SSH host', async () => {
    const depth = put(join(dataRoot(), 'outputs', 'depth.png'))
    const control = { adapter: '/m/control.safetensors', images: [{ kind: 'depth', path: depth, strength: 1, start: 0, end: 1 }] }
    await expect(start.startRequestedEngineJob({ ...base, control })).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
    getEngineFeatures.mockResolvedValue({ ...features, control: false })
    await expect(start.startRequestedEngineJob({ ...base, hostId: 'h1', control })).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' })
    expect(getEngineFeatures).toHaveBeenLastCalledWith({ deviceUuid: undefined, hostId: 'h1' })
  })
})

describe('codedError / errorCode', () => {
  it('carries our E_* codes and ignores system ones', () => {
    expect(errorCode(codedError('E_INPUT_PATH', 'x'))).toBe('E_INPUT_PATH')
    expect(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined()
    expect(errorCode(new Error('x'))).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
  })
})
