import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'

const resolveAdapterFile = vi.hoisted(() => vi.fn<(settings: Settings, id: string) => Promise<string | null>>())
const findAdapterName = vi.hoisted(() => vi.fn<(settings: Settings, id: string) => Promise<string>>())
vi.mock('@main/services/models', () => ({ resolveAdapterFile, findAdapterName }))

import { AdapterResolutionError, resolveCanvasAdapters } from '@main/services/adapterResolution'

const settings = { modelsRoot: '/models' } as Settings

beforeEach(() => {
  resolveAdapterFile.mockReset().mockImplementation(async (_s, id) => (id.startsWith('missing') ? null : `/models/adapters/${id}/w.safetensors`))
  findAdapterName.mockReset().mockImplementation(async (_s, id) => `Name of ${id}`)
})

describe('resolveCanvasAdapters', () => {
  it('returns nothing for empty or malformed input without touching the library', async () => {
    for (const input of [undefined, null, 'x', [], [{ id: '../escape' }, { id: '' }, 3]]) {
      expect(await resolveCanvasAdapters(settings, input)).toEqual([])
    }
    expect(resolveAdapterFile).not.toHaveBeenCalled()
  })

  it('resolves ids to weight files with normalised strengths, dropping duplicates', async () => {
    const result = await resolveCanvasAdapters(settings, [
      { id: 'style', strength: 0.856 },
      { id: 'style', strength: 2 },
      { id: 'detail', strength: 9 },
      { id: 'soft', strength: 'abc' },
    ])
    expect(result).toEqual([
      { path: '/models/adapters/style/w.safetensors', strength: 0.86 },
      { path: '/models/adapters/detail/w.safetensors', strength: 2 },
      { path: '/models/adapters/soft/w.safetensors', strength: 1 },
    ])
    expect(resolveAdapterFile).toHaveBeenCalledWith(settings, 'style')
  })

  it('fails loudly, naming every missing adapter', async () => {
    const error = await resolveCanvasAdapters(settings, [{ id: 'missing-a' }, { id: 'ok' }, { id: 'missing-b' }]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AdapterResolutionError)
    expect((error as Error).message).toContain('「Name of missing-a」「Name of missing-b」')
  })

  it('treats a resolver exception as missing and falls back to the id for the name', async () => {
    resolveAdapterFile.mockRejectedValue(new Error('disk gone'))
    findAdapterName.mockRejectedValue(new Error('index gone'))
    await expect(resolveCanvasAdapters(settings, [{ id: 'style' }])).rejects.toThrow('「style」')
  })

  it('refuses LoRA on a remote engine host before resolving anything', async () => {
    await expect(resolveCanvasAdapters(settings, [{ id: 'style' }], { hostId: 'gpu-box' })).rejects.toThrow(AdapterResolutionError)
    expect(resolveAdapterFile).not.toHaveBeenCalled()
    // No adapters means nothing to refuse, even remotely.
    expect(await resolveCanvasAdapters(settings, [], { hostId: 'gpu-box' })).toEqual([])
  })
})
