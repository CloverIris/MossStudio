import { describe, expect, it } from 'vitest'
import type { GalleryDetail } from '@shared/types'
import { buildReuseRequest, canReuse, isStudioReuseRequest } from '@renderer/lib/studioReuse'
import { loadStore } from '../../helpers/renderer'

const now = new Date('2026-11-04T06:00:00.000Z')

function detail(patch: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: 'a', path: '/out/a.png', name: 'a.png', dir: '/out', root: '/out', size: 1, mtime: 0, ext: '.png',
    width: 1024, height: 1024, prompt: '  spring street ', seed: 7, ...patch,
  }
}

describe('buildReuseRequest', () => {
  it('prefers the generation record over loose metadata', () => {
    const request = buildReuseRequest(
      detail({
        negativePrompt: 'blurry',
        projectId: 'from-item',
        generation: {
          width: 768, height: 1024, seed: 42, steps: 20, cfg: 3, modelBundleId: 'moss-sft', modelName: 'MOSS-Image SFT',
          adapters: [{ path: '/l.safetensors', strength: 0.8 }], projectId: 'poster',
        },
      }),
      { id: 'r1', now },
    )
    expect(request).toEqual({
      id: 'r1', createdAt: now.toISOString(), sourcePath: '/out/a.png', prompt: 'spring street', negativePrompt: 'blurry',
      width: 768, height: 1024, seed: 42, steps: 20, cfg: 3, modelBundleId: 'moss-sft', modelName: 'MOSS-Image SFT',
      adapters: [{ path: '/l.safetensors', strength: 0.8 }], projectId: 'poster',
    })
    expect(isStudioReuseRequest(request)).toBe(true)
  })

  it('omits what the image does not record and drops invalid numbers', () => {
    const request = buildReuseRequest(detail({ prompt: undefined, width: 0, height: undefined, seed: null }), { id: 'r2', now })
    expect(request).toEqual({ id: 'r2', createdAt: now.toISOString(), sourcePath: '/out/a.png', prompt: '' })
    expect(Object.keys(request)).not.toContain('width')
  })

  it('reuses the recorded description, not a compiled layout prompt', () => {
    const request = buildReuseRequest(detail({ prompt: '{"summary":{"caption":"x"}}', generation: { description: '春日街景', regions: 2 } }), { id: 'r4', now })
    expect(request.prompt).toBe('春日街景')
  })

  it('uses the file seed and size when no generation record exists', () => {
    expect(buildReuseRequest(detail(), { id: 'r3', now })).toMatchObject({ width: 1024, height: 1024, seed: 7 })
  })

  it('generates a unique id by default', () => {
    expect(buildReuseRequest(detail()).id).not.toBe(buildReuseRequest(detail()).id)
  })
})

describe('canReuse / isStudioReuseRequest', () => {
  it('needs a prompt or a generation record', () => {
    expect(canReuse(null)).toBe(false)
    expect(canReuse(detail({ prompt: '  ' }))).toBe(false)
    expect(canReuse(detail({ prompt: undefined, generation: { steps: 8 } }))).toBe(true)
    expect(canReuse(detail())).toBe(true)
  })

  it('rejects malformed requests', () => {
    const valid = { id: 'x', createdAt: now.toISOString(), sourcePath: '/a.png', prompt: '' }
    expect(isStudioReuseRequest(valid)).toBe(true)
    expect(isStudioReuseRequest(null)).toBe(false)
    expect(isStudioReuseRequest({ ...valid, id: '' })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, prompt: 3 })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, seed: 'x' })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, width: Number.NaN })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, adapters: 'x' })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, adapters: [{ path: '/l', strength: '1' }] })).toBe(false)
    expect(isStudioReuseRequest({ ...valid, adapters: [{ path: '/l', strength: 1 }] })).toBe(true)
  })
})

describe('store handoff', () => {
  it('hands a request to Studio exactly once', async () => {
    const { store } = await loadStore('ready')
    expect(store().studioReuseRequest).toBeNull()
    const request = buildReuseRequest(detail(), { id: 'once', now })
    store().requestStudioReuse(request)
    expect(store().studioReuseRequest).toEqual(request)
    expect(store().takeStudioReuseRequest()).toEqual(request)
    expect(store().studioReuseRequest).toBeNull()
    expect(store().takeStudioReuseRequest()).toBeNull()
  })

  it('clears and ignores a malformed request', async () => {
    const { useApp, store } = await loadStore('ready')
    useApp.setState({ studioReuseRequest: { id: 'bad' } as never })
    expect(store().takeStudioReuseRequest()).toBeNull()
    expect(store().studioReuseRequest).toBeNull()
  })
})
