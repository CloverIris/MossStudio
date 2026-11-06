import { describe, expect, it } from 'vitest'
import { EMPTY_PROMPT_ERROR, canvasDescription, compileCanvasPrompt, withDescription } from '@renderer/pages/studio/prompt'
import { canvas, layer } from './fixtures'

describe('studio/prompt canvasDescription', () => {
  it('reads the description from either field', () => {
    expect(canvasDescription(canvas({ prompt: 'street' }))).toBe('street')
    expect(canvasDescription(canvas({ summary: { caption: 'caption', meta: [], canvas: 'single' } }))).toBe('caption')
  })

  it('reads what an older canvas actually ran with', () => {
    const old = canvas({ prompt: 'hand written', summary: { caption: 'layout caption', meta: [], canvas: 'single' } })
    expect(canvasDescription(old)).toBe('hand written')
    expect(canvasDescription({ ...old, layers: [layer()] })).toBe('layout caption')
    // All regions hidden: back to the plain prompt.
    expect(canvasDescription({ ...old, layers: [layer({ visible: false })] })).toBe('hand written')
  })

  it('writes the description to both fields', () => {
    const next = withDescription(canvas({ prompt: 'a', summary: { caption: 'b', meta: ['poster'], canvas: 'single' } }), 'c')
    expect(next.prompt).toBe('c')
    expect(next.summary).toEqual({ caption: 'c', meta: ['poster'], canvas: 'single' })
  })
})

describe('studio/prompt compileCanvasPrompt', () => {
  it('sends the description as-is when there are no visible regions', () => {
    expect(compileCanvasPrompt(canvas({ prompt: '  spring street  ' }))).toMatchObject({
      ok: true,
      prompt: 'spring street',
      source: 'text',
      regions: 0,
    })
    expect(compileCanvasPrompt(canvas({ prompt: 'x', layers: [layer({ visible: false })] }))).toMatchObject({
      ok: true,
      prompt: 'x',
      source: 'text',
    })
  })

  it('refuses an empty canvas', () => {
    expect(compileCanvasPrompt(canvas())).toMatchObject({ ok: false, errors: [EMPTY_PROMPT_ERROR] })
  })

  it('always compiles the layout when regions are visible, never a stale hand-written prompt', () => {
    const result = compileCanvasPrompt(
      withDescription(canvas({ layers: [layer(), layer({ id: 'hidden', caption: '', visible: false })] }), 'a poster'),
    )
    expect(result.ok).toBe(true)
    expect(result.source).toBe('layout')
    expect(result.regions).toBe(1)
    const payload = JSON.parse(result.prompt) as { summary: { caption: string }; items: Array<{ caption: string }> }
    expect(payload.summary.caption).toBe('a poster')
    expect(payload.items.map((item) => item.caption)).toEqual(['a red bicycle'])
  })

  it('reports what is missing in plain words', () => {
    const result = compileCanvasPrompt(
      canvas({ layers: [layer({ caption: '' }), layer({ id: 't', kind: 'text', caption: 'title', text: '' })] }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['先写一句整体描述', '区域 1 还没有描述', '文字区域 2 还没有填写要显示的文字'])
  })
})
