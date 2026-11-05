import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineFeatures } from '@shared/types'
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
const features: EngineFeatures = { preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true, values: {} }

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

const base = { prompt: 'a cat', width: 1024, height: 1024, steps: 20, cfg: 4, seed: 1, projectId: 'project-1', adapters: [{ id: 'lora', strength: 1 }] }

describe('startRequestedEngineJob', () => {
  it('resolves LoRAs and starts a plain job without asking the engine anything', async () => {
    await start.startRequestedEngineJob(base)
    expect(startEngineJob).toHaveBeenCalledWith({ ...base, adapters: [{ path: '/m/lora.safetensors', strength: 1 }] })
    expect(getEngineFeatures).not.toHaveBeenCalled()
  })

  it('accepts pictures from the project assets and the outputs, checked against the target engine', async () => {
    const init = put(join(dataRoot(), 'projects', 'project-1', 'assets', 'init.png'))
    const ref = put(join(dataRoot(), 'outputs', 'ref.png'))
    await start.startRequestedEngineJob({ ...base, deviceUuid: 'GPU-a', initImage: { path: init, strength: 0.5 }, references: { paths: [ref] }, mask: null })
    expect(getEngineFeatures).toHaveBeenCalledWith({ deviceUuid: 'GPU-a', hostId: undefined })
    const input = startEngineJob.mock.calls[0]![0] as Record<string, unknown>
    expect(input['initImage']).toEqual({ path: init, strength: 0.5 })
    expect(input['references']).toEqual({ paths: [ref] })
    expect(input).not.toHaveProperty('mask')
  })

  it("refuses another project's picture and never queues the job", async () => {
    const other = put(join(dataRoot(), 'projects', 'project-2', 'assets', 'init.png'))
    await expect(start.startRequestedEngineJob({ ...base, initImage: { path: other, strength: 0.5 } })).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
    expect(startEngineJob).not.toHaveBeenCalled()
  })

  it('allows no project assets for a request without a valid project id', async () => {
    const init = put(join(dataRoot(), 'projects', 'project-1', 'assets', 'init.png'))
    await expect(start.startRequestedEngineJob({ ...base, projectId: '../project-1', initImage: { path: init, strength: 0.5 } })).rejects.toMatchObject({ code: 'E_INPUT_PATH' })
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
