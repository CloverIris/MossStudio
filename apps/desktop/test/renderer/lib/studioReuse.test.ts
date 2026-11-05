import { describe, expect, it } from 'vitest'
import type { GalleryDetail } from '@shared/types'
import { buildReuseRequest, canReuse, isStudioReuseRequest } from '@renderer/lib/studioReuse'
import { galleryItemFixture } from '../../mocks/backend'

const now = new Date('2026-11-04T00:00:00.000Z')
function detail(patch: Partial<GalleryDetail> = {}): GalleryDetail {
  return { ...galleryItemFixture(3), ...patch }
}

describe('lib/studioReuse buildReuseRequest', () => {
  it('copies loose image metadata when there is no generation record', () => {
    const request = buildReuseRequest(detail({ prompt: '  a cat  ', negativePrompt: 'blurry', seed: 9 }), { id: 'r', now })
    expect(request).toEqual({ id: 'r', createdAt: now.toISOString(), sourcePath: '/fixture/outputs/moss_0003.png', prompt: 'a cat', negativePrompt: 'blurry', width: 1024, height: 1024, seed: 9 })
  })

  it('prefers generation details over loose metadata and copies adapters', () => {
    const adapters = [{ path: '/lora.safetensors', strength: 0.8 }]
    const request = buildReuseRequest(detail({
      seed: 1, width: 512, projectId: 'loose',
      generation: { seed: 77, width: 768, height: 1344, steps: 8, cfg: 1, modelBundleId: 'moss-sft', modelName: 'SFT', adapters, projectId: 'p1' },
    }), { id: 'r', now })
    expect(request).toMatchObject({ seed: 77, width: 768, height: 1344, steps: 8, cfg: 1, modelBundleId: 'moss-sft', modelName: 'SFT', projectId: 'p1', adapters })
    expect(request.adapters![0]).not.toBe(adapters[0])
  })

  it('drops invalid numbers, blank strings and empty adapter lists', () => {
    const request = buildReuseRequest(detail({
      prompt: undefined, negativePrompt: '   ', width: -1, height: 0, seed: null,
      generation: { seed: -3, steps: 2.5, cfg: Number.POSITIVE_INFINITY, modelBundleId: ' ', adapters: [] },
    }), { id: 'r', now })
    expect(request).toEqual({ id: 'r', createdAt: now.toISOString(), sourcePath: '/fixture/outputs/moss_0003.png', prompt: '' })
  })

  it('keeps seed 0 and falls back to the loose project id', () => {
    expect(buildReuseRequest(detail({ seed: 0, projectId: 'p-loose' }), { id: 'r', now })).toMatchObject({ seed: 0, projectId: 'p-loose' })
  })

  it('generates an id and timestamp by default', () => {
    const request = buildReuseRequest(detail())
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(request.createdAt))).toBe(false)
  })

  it('always produces something isStudioReuseRequest accepts', () => {
    expect(isStudioReuseRequest(buildReuseRequest(detail({ generation: { adapters: [{ path: 'x', strength: 1 }] } })))).toBe(true)
  })
})

describe('lib/studioReuse canReuse', () => {
  it('needs a prompt or a generation record', () => {
    expect(canReuse(null)).toBe(false)
    expect(canReuse(detail({ prompt: '  ' }))).toBe(false)
    expect(canReuse(detail({ prompt: undefined }))).toBe(false)
    expect(canReuse(detail({ prompt: 'x' }))).toBe(true)
    expect(canReuse(detail({ prompt: undefined, generation: {} }))).toBe(true)
  })
})

describe('lib/studioReuse isStudioReuseRequest', () => {
  const valid = { id: 'r', createdAt: '', sourcePath: '/a.png', prompt: '' }
  it('accepts the minimal shape', () => {
    expect(isStudioReuseRequest(valid)).toBe(true)
  })
  it.each([
    ['null', null],
    ['a string', 'r'],
    ['empty id', { ...valid, id: '' }],
    ['numeric createdAt', { ...valid, createdAt: 1 }],
    ['missing sourcePath', { id: 'r', createdAt: '', prompt: '' }],
    ['missing prompt', { id: 'r', createdAt: '', sourcePath: '/a' }],
    ['NaN width', { ...valid, width: Number.NaN }],
    ['string seed', { ...valid, seed: '4' }],
    ['adapters not an array', { ...valid, adapters: {} }],
    ['adapter without path', { ...valid, adapters: [{ strength: 1 }] }],
    ['adapter with infinite strength', { ...valid, adapters: [{ path: 'x', strength: Number.POSITIVE_INFINITY }] }],
    ['null adapter', { ...valid, adapters: [null] }],
  ])('rejects %s', (_name, value) => {
    expect(isStudioReuseRequest(value)).toBe(false)
  })
})

describe('lib/studioReuse 用作起始图', () => {
  it('asks for a start picture, carrying the description and size but not the seed', async () => {
    const { buildStartPictureRequest } = await import('@renderer/lib/studioReuse')
    const request = buildStartPictureRequest(detail({ prompt: 'a cat', seed: 9 }), { id: 's', now })
    expect(request).toEqual({ id: 's', createdAt: now.toISOString(), sourcePath: '/fixture/outputs/moss_0003.png', prompt: 'a cat', width: 1024, height: 1024, useAs: 'start' })
    expect(isStudioReuseRequest(request)).toBe(true)
  })

  it('works for a picture with no recorded parameters', async () => {
    const { buildStartPictureRequest } = await import('@renderer/lib/studioReuse')
    const request = buildStartPictureRequest(detail({ prompt: undefined }), { id: 's', now })
    expect(request).toMatchObject({ sourcePath: '/fixture/outputs/moss_0003.png', prompt: '', useAs: 'start' })
  })

  it('rejects an unknown hand-off mode', () => {
    expect(isStudioReuseRequest({ id: 'r', createdAt: '', sourcePath: '/a.png', prompt: '', useAs: 'edit' })).toBe(false)
  })
})

describe('lib/studioReuse 高清修复 pictures', () => {
  const hires = { width: 2048, height: 2048, strength: 0.35 }
  const generation = { width: 2048, height: 2048, baseWidth: 1024, baseHeight: 1024, seed: 5, sampling: { sampler: 'euler', hires } }

  it('reuses the first-pass size and the sampling, so the same picture comes out', () => {
    const request = buildReuseRequest(detail({ width: 2048, height: 2048, generation: generation as never }), { id: 'r', now })
    expect(request).toMatchObject({ width: 1024, height: 1024, seed: 5, sampling: { sampler: 'euler', hires } })
    expect(request.sampling).not.toBe(generation.sampling)
    expect(isStudioReuseRequest(request)).toBe(true)
  })

  it('falls back to width/height when no first-pass size was recorded', () => {
    const request = buildReuseRequest(detail({ generation: { width: 1280, height: 720 } }), { id: 'r', now })
    expect(request).toMatchObject({ width: 1280, height: 720 })
    expect(request.sampling).toBeUndefined()
  })

  it('a start picture keeps the picture size and drops the 高清修复 pass', async () => {
    const { buildStartPictureRequest } = await import('@renderer/lib/studioReuse')
    const request = buildStartPictureRequest(detail({ width: 2048, height: 2048, generation: generation as never }), { id: 's', now })
    expect(request).toMatchObject({ width: 2048, height: 2048, sampling: { sampler: 'euler' }, useAs: 'start' })
    expect(request.sampling?.hires).toBeUndefined()
    expect(request.seed).toBeUndefined()
  })

  it('rejects a malformed sampling field', () => {
    expect(isStudioReuseRequest({ id: 'r', createdAt: '', sourcePath: '/a.png', prompt: '', sampling: 'euler' })).toBe(false)
  })
})
