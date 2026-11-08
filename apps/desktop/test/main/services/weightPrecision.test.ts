import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDir } from '@test/helpers/tempDir'

const requestRunningEngine = vi.hoisted(() => vi.fn())
const requestEngineOnce = vi.hoisted(() => vi.fn())
const localServerPath = vi.hoisted(() => vi.fn())
vi.mock('@main/services/mossInfer', () => ({ requestRunningEngine }))
vi.mock('@main/lib/probeEngine', () => ({ requestEngineOnce }))
vi.mock('@main/services/engineInstalls', () => ({ localServerPath }))

const dir = useTempDir('mossstudio-precision-')
let precision: typeof import('@main/services/weightPrecision')

function file(name: string): string {
  const path = join(dir(), name)
  writeFileSync(path, name)
  return path
}

/** The job GPU's running moss-server answers with `report`. */
function running(report: Record<string, unknown>): void {
  requestRunningEngine.mockImplementation(() => Promise.resolve(report))
}

beforeEach(async () => {
  vi.resetModules()
  requestRunningEngine.mockReset().mockReturnValue(null)
  requestEngineOnce.mockReset().mockRejectedValue(new Error('no one-shot answer'))
  localServerPath.mockReset().mockReturnValue('/engine/moss-server')
  precision = await import('@main/services/weightPrecision')
})

describe('jobWeightPrecisions', () => {
  it('reads a bundle folder as bf16 without asking the engine', async () => {
    expect(await precision.jobWeightPrecisions({}, 'GPU-a')).toEqual({ dit: 'bf16', textEncoder: 'bf16' })
    expect(requestRunningEngine).not.toHaveBeenCalled()
    expect(requestEngineOnce).not.toHaveBeenCalled()
  })

  it("asks the job GPU's running engine about a component file, once per file version", async () => {
    const dit = file('moss_image_heal_int8_convrot.safetensors')
    running({ kind: 'dit', loadable: true, precision: 'int8' })
    expect(await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).toEqual({ dit: 'int8', textEncoder: 'bf16' })
    expect(await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).toEqual({ dit: 'int8', textEncoder: 'bf16' })
    expect(requestRunningEngine).toHaveBeenCalledTimes(1)
    expect(requestRunningEngine).toHaveBeenCalledWith('inspect', { path: dit }, 15_000, 'GPU-a')

    writeFileSync(dit, 'a new version of the file')
    await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')
    expect(requestRunningEngine).toHaveBeenCalledTimes(2)
  })

  it("asks again after the GPU's engine changes", async () => {
    const dit = file('dit.safetensors')
    running({ kind: 'dit', loadable: false, precision: null, note: 'must be BF16' })
    expect((await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).dit).toBeNull()
    localServerPath.mockReturnValue('/engine-2.3/moss-server')
    running({ kind: 'dit', loadable: true, precision: 'bf16' })
    expect((await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).dit).toBe('bf16')
  })

  it("uses a short-lived server of the GPU's package when none runs there, or the running one fails", async () => {
    const encoder = file('qwen3.5_9b_int8_convrot.safetensors')
    requestEngineOnce.mockResolvedValue({ hello: {}, result: { kind: 'text_encoder', loadable: true, precision: 'int8' } })
    expect(await precision.jobWeightPrecisions({ textEncoderFile: encoder }, 'GPU-a')).toEqual({ dit: 'bf16', textEncoder: 'int8' })
    expect(localServerPath).toHaveBeenCalledWith('GPU-a')
    expect(requestEngineOnce).toHaveBeenCalledWith('/engine/moss-server', 'inspect', { path: encoder }, { timeoutMs: 30_000 })

    const dit = file('moss_image_sft_int8_convrot.safetensors')
    requestRunningEngine.mockImplementation(() => Promise.reject(new Error('method_not_found: inspect')))
    requestEngineOnce.mockResolvedValue({ hello: {}, result: { kind: 'dit', loadable: true, precision: 'int8' } })
    expect((await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).dit).toBe('int8')
  })

  it('does not know a file of another kind, one the engine cannot load, or an unknown precision', async () => {
    running({ kind: 'lora', loadable: true })
    expect((await precision.jobWeightPrecisions({ ditFile: file('style.safetensors') }, 'GPU-a')).dit).toBeNull()

    running({ kind: 'dit', loadable: false, precision: null, note: 'must be BF16' })
    expect((await precision.jobWeightPrecisions({ ditFile: file('moss_image_heal_fp16.safetensors') }, 'GPU-a')).dit).toBeNull()

    running({ kind: 'dit', loadable: true, precision: 'nvfp4' })
    expect((await precision.jobWeightPrecisions({ ditFile: file('odd.safetensors') }, 'GPU-a')).dit).toBeNull()
  })

  it('does not remember a failed inspect, and knows nothing of a missing file or without an engine', async () => {
    const dit = file('dit.safetensors')
    expect((await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).dit).toBeNull()
    running({ kind: 'dit', loadable: true, precision: 'bf16' })
    expect((await precision.jobWeightPrecisions({ ditFile: dit }, 'GPU-a')).dit).toBe('bf16')

    expect((await precision.jobWeightPrecisions({ ditFile: join(dir(), 'gone.safetensors') }, 'GPU-a')).dit).toBeNull()
    localServerPath.mockReturnValue(null)
    expect((await precision.jobWeightPrecisions({ ditFile: file('no-engine.safetensors') }, 'GPU-a')).dit).toBeNull()
  })
})
