import { describe, expect, it } from 'vitest'
import { toolDetail, toolLabel } from '@renderer/pages/studio/assistant/format'

describe('studio/assistant format', () => {
  it('names tools in plain words', () => {
    expect(toolLabel('studio_add_layer')).toBe('添加区域')
    expect(toolLabel('other_tool')).toBe('other_tool')
  })

  it('summarises tool results in one line', () => {
    expect(toolDetail(JSON.stringify({ error: '先选中一个画面' }))).toBe('先选中一个画面')
    expect(toolDetail(JSON.stringify({ a: 1, b: { c: 2 }, d: 'x', e: 'hidden' }))).toBe('a=1 · b={"c":2} · d=x')
    expect(toolDetail('not json')).toBe('not json')
    expect(toolDetail('')).toBe('')
  })
})
