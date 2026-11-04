import { describe, expect, it, vi } from 'vitest'
import { clampBox, compileLayout, createDraft, draftJson, exampleDraft, parseDraft, type LayoutDraft } from '@renderer/lib/layout'

function draft(patch: Partial<LayoutDraft> = {}): LayoutDraft {
  return { ...exampleDraft(), ...patch }
}

describe('lib/layout', () => {
  it('createDraft builds an empty single-canvas draft', () => {
    expect(createDraft()).toEqual({ width: 1024, height: 1024, summary: { caption: '', meta: [], canvas: 'single' }, items: [] })
    expect(createDraft(768, 1344)).toMatchObject({ width: 768, height: 1344 })
  })

  describe('clampBox', () => {
    it('normalises reversed corners and clamps to the canvas', () => {
      expect(clampBox([900, 800, -10, -20], 512, 512)).toEqual([0, 0, 512, 512])
    })
    it('keeps at least a 1px box even for degenerate input', () => {
      expect(clampBox([10, 10, 10, 10], 100, 100)).toEqual([10, 10, 11, 11])
      expect(clampBox([200, 200, 300, 300], 100, 100)).toEqual([99, 99, 100, 100])
    })
    it('rounds fractional coordinates', () => {
      expect(clampBox([1.4, 2.6, 50.5, 60.49], 100, 100)).toEqual([1, 3, 51, 60])
    })
  })

  describe('compileLayout', () => {
    it('compiles the example into a centred yxyx prompt', () => {
      const result = compileLayout(exampleDraft())
      expect(result.ok).toBe(true)
      expect(result.errors).toEqual([])
      const payload = JSON.parse(result.prompt)
      expect(payload.bbox_coord_space).toBe('abs_centralized')
      expect(payload.bbox_format).toBe('yxyx')
      expect(payload.summary).toEqual({ caption: exampleDraft().summary.caption, meta: ['poster'], canvas: 'single' })
      // [x1,y1,x2,y2] = [128,96,896,224] on 1024² -> [y1-512, x1-512, y2-512, x2-512]
      expect(payload.items[0]).toEqual({ label: 'text', caption: 'Large dark-blue uppercase title centered at the top.', bbox: [-416, -384, -288, 384], text: 'EXPLORE' })
      expect(payload.items[1].text).toBeUndefined()
      expect(JSON.parse(result.preview)).toEqual(payload)
    })

    it('trims captions and meta, dropping empty meta and the key entirely when all are blank', () => {
      const compiled = compileLayout(draft({ summary: { caption: '  hi  ', meta: [' a ', '', '  '], canvas: 'collage' } }))
      const payload = JSON.parse(compiled.prompt)
      expect(payload.summary).toEqual({ caption: 'hi', meta: ['a'], canvas: 'collage' })
      const none = JSON.parse(compileLayout(draft({ summary: { caption: 'x', meta: [''], canvas: 'single' } })).prompt)
      expect('meta' in none.summary).toBe(false)
    })

    it('excludes hidden items from both validation and output', () => {
      const base = exampleDraft()
      const items = [...base.items, { id: 'hidden', label: 'text' as const, caption: '', bbox: [-5, -5, 9999, 9999] as [number, number, number, number], visible: false }]
      const result = compileLayout({ ...base, items })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.prompt).items).toHaveLength(2)
    })

    it('rounds centred boxes for fractional coordinates', () => {
      const result = compileLayout(draft({ items: [{ id: 'o', label: 'object', caption: 'c', bbox: [10.4, 20.6, 30.5, 40.4] }] }))
      expect(JSON.parse(result.prompt).items[0].bbox).toEqual([21 - 512, 10 - 512, 40 - 512, 31 - 512])
    })

    it.each([
      ['width not a multiple of 16', { width: 1000 }, '画面宽度需要是 16 的倍数'],
      ['zero height', { height: 0 }, '画面高度需要是 16 的倍数'],
      ['fractional width', { width: 1024.5 }, '画面宽度需要是 16 的倍数'],
      ['blank caption', { summary: { caption: '  ', meta: [], canvas: 'single' as const } }, '先写一句整体描述'],
      ['no items', { items: [] }, '至少需要一个区域'],
    ])('rejects %s', (_name, patch, message) => {
      const result = compileLayout(draft(patch))
      expect(result).toMatchObject({ ok: false, prompt: '', preview: '' })
      expect(result.errors).toContain(message)
    })

    it('reports item problems with 1-based indices', () => {
      const result = compileLayout(draft({
        items: [
          { id: 'a', label: 'object', caption: 'fine', bbox: [0, 0, 10, 10] },
          { id: 'b', label: 'text', caption: ' ', bbox: [0, 0, 10, 10] },
          { id: 'c', label: 'object', caption: 'c', bbox: [10, 10, 10, 20] },
          { id: 'd', label: 'object', caption: 'd', bbox: [0, 0, 1025, 10] },
        ],
      }))
      expect(result.errors).toEqual(['区域 2 还没有描述', '文字区域 2 还没有填写要显示的文字', '区域 3 超出了画面', '区域 4 超出了画面'])
    })

    it('collects every error at once', () => {
      const result = compileLayout({ width: 10, height: 10, summary: { caption: '', meta: [], canvas: 'single' }, items: [] })
      expect(result.errors).toHaveLength(4)
    })
  })

  describe('draftJson / parseDraft', () => {
    it('round-trips a draft, dropping ids and assigning fresh import ids', () => {
      const original = exampleDraft()
      const text = draftJson(original)
      const json = JSON.parse(text)
      expect(json).toMatchObject({ width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy' })
      expect(json.items.every((item: Record<string, unknown>) => !('id' in item))).toBe(true)
      const parsed = parseDraft(text)!
      expect(parsed.summary).toEqual(original.summary)
      expect(parsed.items.map(({ id: _id, ...item }) => item)).toEqual(original.items.map(({ id: _id, ...item }) => item))
      expect(parsed.items.map((item) => item.id)).toEqual([expect.stringMatching(/^import-0-/), expect.stringMatching(/^import-1-/)])
    })

    it('clamps imported boxes to the canvas', () => {
      const parsed = parseDraft(JSON.stringify({ width: 100, height: 100, items: [{ label: 'object', caption: 'c', bbox: [-5, 90, 200, 50] }] }))!
      expect(parsed.items[0]!.bbox).toEqual([0, 50, 100, 90])
    })

    it('fills summary defaults when missing or malformed', () => {
      expect(parseDraft(JSON.stringify({ width: 64, height: 64, items: [] }))!.summary).toEqual({ caption: '', meta: [], canvas: 'single' })
      expect(parseDraft(JSON.stringify({ width: 64, height: 64, items: [], summary: { caption: 'x', meta: 'oops' } }))!.summary.meta).toEqual([])
    })

    it.each([
      ['invalid JSON', '{nope'],
      ['missing width', JSON.stringify({ height: 10, items: [] })],
      ['zero height', JSON.stringify({ width: 10, height: 0, items: [] })],
      ['items not an array', JSON.stringify({ width: 10, height: 10, items: {} })],
      ['item without bbox', JSON.stringify({ width: 10, height: 10, items: [{ label: 'object', caption: 'c' }] })],
      ['JSON null', 'null'],
    ])('returns null for %s', (_name, text) => {
      expect(parseDraft(text)).toBeNull()
    })

    it('uses Math.random for import ids so repeated imports do not collide', () => {
      const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2)
      const text = JSON.stringify({ width: 10, height: 10, items: [{ label: 'object', caption: 'a', bbox: [0, 0, 5, 5] }] })
      const first = parseDraft(text)!.items[0]!.id
      const second = parseDraft(text)!.items[0]!.id
      expect(random).toHaveBeenCalledTimes(2)
      expect(first).not.toBe(second)
    })
  })
})
