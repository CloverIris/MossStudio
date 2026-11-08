import { describe, expect, it } from 'vitest'
import { toolDetail, toolLabel, traceHeadline } from '@renderer/pages/studio/assistant/format'

describe('studio/assistant format', () => {
  it('names tools in plain words', () => {
    expect(toolLabel('studio_add_layer')).toBe('添加区域')
    expect(toolLabel('studio_add_text_layer')).toBe('添加文字')
    expect(toolLabel('studio_ask_approval')).toBe('等你确认')
    expect(toolLabel('other_tool')).toBe('other_tool')
  })

  it('summarises tool results in one line', () => {
    expect(toolDetail(JSON.stringify({ error: '先选中一个画面' }))).toBe('先选中一个画面')
    expect(toolDetail(JSON.stringify({ summary: '文字「新年快乐」', problems: [] }))).toBe('文字「新年快乐」')
    expect(toolDetail(JSON.stringify({ summary: '人物「A」', problems: ['先写一句描述'] }))).toBe('人物「A」 · 还差：先写一句描述')
    expect(toolDetail(JSON.stringify({ problems: ['还差这个'] }))).toBe('还差：还差这个')
    expect(toolDetail(JSON.stringify({ a: 1, b: { c: 2 }, d: 'x', e: 'hidden' }))).toBe('a=1 · b={"c":2} · d=x')
    expect(toolDetail('not json')).toBe('not json')
    expect(toolDetail('')).toBe('')
  })

  it('summarises a whole canvas list instead of dumping it', () => {
    const read = { project: { id: 'p' }, canvases: [{ id: 'a' }, { id: 'b' }], selected: { title: '画面 24' } }
    expect(toolDetail(JSON.stringify(read))).toBe('2 个画面 · 当前「画面 24」')
    expect(toolDetail(JSON.stringify({ canvases: [{}, {}] }))).toBe('2 个画面')
    expect(toolDetail(JSON.stringify({ created: [{}, {}, {}] }))).toBe('新建 3 个画面')
    expect(toolDetail(JSON.stringify({ layers: [{}, {}] }))).toBe('2 个区域')
  })

  it('describes a held-back write as a plan step, never as raw arguments', () => {
    const proposed = { proposed: { tool: 'studio_create_scenes', args: {}, label: '新建 6 个画面：01 推门迎春' } }
    expect(toolDetail(JSON.stringify(proposed))).toBe('已加入方案：新建 6 个画面：01 推门迎春')
    expect(toolDetail(JSON.stringify({ proposed: {} }))).toBe('已加入方案，等你确认')
  })

  it('clips what is still too long to read', () => {
    const detail = toolDetail(JSON.stringify({ note: 'x'.repeat(400) }))
    expect(detail.length).toBeLessThanOrEqual(121)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('headlines a trace by tool name, or by count', () => {
    expect(traceHeadline(['studio_read_context'])).toBe('查看画面')
    expect(traceHeadline(['studio_read_context', 'studio_ask_user'])).toBe('执行了 2 步 · 查看画面 等')
    expect(traceHeadline([])).toBe('执行中')
  })
})
