import { afterEach, describe, expect, it, vi } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import {
  applyStudioDescription,
  executeStudioTool,
  formatStudioContext,
  installStudioToolBridge,
  readStudioSnapshot,
  registerStudioTools,
  type StudioSnapshot,
  type StudioToolApi,
} from '@renderer/lib/agentTools'
import { addRegion } from '@renderer/pages/studio/canvases'
import { compileCanvasPrompt } from '@renderer/pages/studio/prompt'
import { createMockBackend } from '../../mocks/backend'
import { flush } from '../../helpers/renderer'
import { canvas } from '../studio/fixtures'

function snapshot(patch: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return { title: 'Poster', description: 'A poster', width: 1024, height: 768, regions: [], ...patch }
}

function api(patch: Partial<StudioToolApi> = {}): StudioToolApi {
  return {
    state: () => ({ hasSelection: true, editable: true }),
    readContext: vi.fn(() => ({ prompt: 'p' })),
    snapshot: vi.fn(() => snapshot()),
    setPrompt: vi.fn((prompt: string) => ({ written: prompt.length })),
    setSampler: vi.fn((values) => ({ applied: values })),
    addLayer: vi.fn(() => ({ added: 'layer-1', bbox: [0, 0, 1, 1] as [number, number, number, number], index: 1 })),
    addTextLayer: vi.fn(() => ({ added: 'layer-2', bbox: [0, 0, 1, 1] as [number, number, number, number], index: 2 })),
    updateLayer: vi.fn(() => ({ updated: 'layer-1', index: 1 })),
    removeLayer: vi.fn(() => ({ removed: 'layer-1', index: 1 })),
    generate: vi.fn(async () => ({ queued: true, jobId: 'j' })),
    problems: vi.fn(() => []),
    ...patch,
  }
}

const run = (name: string, args: unknown = {}) =>
  executeStudioTool({ id: 'c1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const parse = (content: string) => JSON.parse(content) as Record<string, unknown>

afterEach(() => registerStudioTools(null))

describe('lib/agentTools executeStudioTool', () => {
  it('fails every tool before Studio registers', async () => {
    const result = await run('studio_read_context')
    expect(result.ok).toBe(false)
    expect(parse(result.content).error).toMatch(/Studio 尚未就绪/)
  })

  it('reads context without annotating the result', async () => {
    registerStudioTools(api())
    expect(await run('studio_read_context')).toEqual({ ok: true, content: JSON.stringify({ prompt: 'p' }) })
  })

  it('writes a non-blank description and reports what still blocks generation', async () => {
    const tools = api({ problems: vi.fn(() => ['先写一句描述']) })
    registerStudioTools(tools)
    const result = await run('studio_set_prompt', { prompt: '  a red fox  ' })
    expect(result.ok).toBe(true)
    expect(tools.setPrompt).toHaveBeenCalledWith('a red fox')
    expect(parse(result.content)).toEqual({
      written: 9,
      summary: '描述改为「a red fox」',
      problems: ['先写一句描述'],
    })
    for (const args of [{ prompt: '   ' }, { prompt: 42 }, {}]) {
      const failed = await run('studio_set_prompt', args)
      expect(failed.ok).toBe(false)
      expect(parse(failed.content).error).toMatch(/参数不对：prompt/)
    }
    expect(tools.setPrompt).toHaveBeenCalledTimes(1)
  })

  it('passes only the sampler fields that were given, and refuses a bad type', async () => {
    const tools = api()
    registerStudioTools(tools)
    await run('studio_set_sampler', { width: 768, seed: 3, cfg: 4.5 })
    expect(tools.setSampler).toHaveBeenCalledWith({ width: 768, seed: 3, cfg: 4.5 })
    expect((await run('studio_set_sampler', { steps: '20' })).ok).toBe(false)
    const empty = await run('studio_set_sampler', {})
    expect(empty.ok).toBe(false)
    expect(parse(empty.content).error).toBe('没有可更新的字段')
  })

  it('adds object and character regions', async () => {
    const tools = api()
    registerStudioTools(tools)
    expect((await run('studio_add_layer', { label: 'banner', caption: 'x' })).ok).toBe(false)
    expect((await run('studio_add_layer', { label: 'object', caption: '  ' })).ok).toBe(false)
    const partialbox = await run('studio_add_layer', { label: 'object', caption: 'tree', bbox: { x: 1, y: 2, w: 3 } })
    expect(partialbox.ok).toBe(false)
    await run('studio_add_layer', { label: 'character', caption: ' hero ', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
    expect(tools.addLayer).toHaveBeenCalledWith({ label: 'character', caption: 'hero', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
  })

  it('sends a text region to its own tool, with both strings', async () => {
    const tools = api()
    registerStudioTools(tools)
    const legacy = await run('studio_add_layer', { label: 'text', caption: 'large gold title' })
    expect(legacy.ok).toBe(false)
    expect(parse(legacy.content)).toMatchObject({ fix: { tool: 'studio_add_text_layer' } })
    expect(tools.addLayer).not.toHaveBeenCalled()

    const result = await run('studio_add_text_layer', { caption: ' large gold serif title ', text: ' 新年快乐 ' })
    expect(result.ok).toBe(true)
    expect(tools.addTextLayer).toHaveBeenCalledWith({ caption: 'large gold serif title', text: '新年快乐', bbox: undefined })
    expect(parse(result.content)).toMatchObject({ summary: '文字「新年快乐」' })
  })

  it('updates and removes regions by their 1-based index', async () => {
    const tools = api()
    registerStudioTools(tools)
    await run('studio_update_layer', { index: 2, caption: 'a new caption', bbox: { x: 0, y: 0, w: 0.5, h: 0.5 } })
    expect(tools.updateLayer).toHaveBeenCalledWith({
      index: 2,
      patch: { caption: 'a new caption', bbox: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    })
    await run('studio_remove_layer', { index: 3 })
    expect(tools.removeLayer).toHaveBeenCalledWith(3)
    expect((await run('studio_update_layer', { index: 0 })).ok).toBe(false)
  })

  it('refuses to edit when nothing is selected or the selection is a result', async () => {
    registerStudioTools(api({ state: () => ({ hasSelection: false, editable: false }) }))
    const nothing = await run('studio_set_prompt', { prompt: 'x' })
    expect(nothing.ok).toBe(false)
    expect(parse(nothing.content).error).toBe('先在画布上选中一个画面')

    const tools = api({ state: () => ({ hasSelection: true, editable: false }) })
    registerStudioTools(tools)
    const result = await run('studio_generate', {})
    expect(result.ok).toBe(false)
    expect(parse(result.content).error).toMatch(/选中的是生成结果/)
    expect(tools.generate).not.toHaveBeenCalled()
  })

  it('generates with an optional prompt and defaults the result', async () => {
    const tools = api({ generate: vi.fn(async () => undefined) })
    registerStudioTools(tools)
    expect(parse((await run('studio_generate', { prompt: 'x' })).content)).toMatchObject({ queued: true })
    await run('studio_generate', {})
    expect(tools.generate).toHaveBeenNthCalledWith(1, 'x')
    expect(tools.generate).toHaveBeenNthCalledWith(2, undefined)
  })

  it('treats malformed or non-object arguments as empty', async () => {
    registerStudioTools(api())
    expect((await run('studio_set_prompt', '{broken')).ok).toBe(false)
    expect((await run('studio_set_prompt', '"just a string"')).ok).toBe(false)
    expect((await run('studio_read_context', '   ')).ok).toBe(true)
  })

  it('reports unknown tools and converts thrown errors into failures', async () => {
    registerStudioTools(
      api({
        readContext: () => {
          throw new Error('canvas gone')
        },
        generate: async () => {
          throw 'plain'
        },
      }),
    )
    expect(parse((await run('rm_rf')).content).error).toBe('未知工具 rm_rf')
    expect(parse((await run('studio_read_context')).content).error).toBe('canvas gone')
    expect(parse((await run('studio_generate')).content).error).toBe('plain')
  })
})

describe('text regions built by the tools', () => {
  it('compile as soon as the words are there', () => {
    const { canvas: built } = addRegion(canvas({ prompt: 'a new year card' }), {
      kind: 'text',
      caption: 'large gold serif title along the top',
      text: '新年快乐',
      bbox: { x: 0.04, y: 0.04, w: 0.44, h: 0.15 },
    })
    const result = compileCanvasPrompt(built)
    expect(result.ok).toBe(true)
    const payload = JSON.parse(result.prompt) as { items: Array<{ label: string; text?: string }> }
    expect(payload.items[0]).toMatchObject({ label: 'text', text: '新年快乐' })
  })

  it('block generation while the words are missing, and say so', () => {
    const { canvas: built } = addRegion(canvas({ prompt: 'a new year card' }), { kind: 'text', caption: 'large gold serif title' })
    const result = compileCanvasPrompt(built)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['文字区域 1 还没有填写要显示的文字'])
  })
})

describe('lib/agentTools installStudioToolBridge', () => {
  it('runs each requested tool and returns the result to main', async () => {
    const backend = createMockBackend('ready')
    const uninstall = backend.install()
    registerStudioTools(api())
    const off = installStudioToolBridge()
    backend.emit(Events.aiToolCall, { callId: 'call-9', name: 'studio_read_context', arguments: '' })
    await flush()
    expect(backend.callsTo(Ipc.aiToolResult)).toEqual([
      { callId: 'call-9', result: { ok: true, content: JSON.stringify({ prompt: 'p' }) } },
    ])
    off()
    backend.emit(Events.aiToolCall, { callId: 'call-10', name: 'studio_read_context', arguments: '' })
    await flush()
    expect(backend.callsTo(Ipc.aiToolResult)).toHaveLength(1)
    uninstall()
  })

  it('swallows a failure to deliver the result', async () => {
    const backend = createMockBackend('ready')
    const uninstall = backend.install()
    backend.fail(Ipc.aiToolResult)
    const off = installStudioToolBridge()
    backend.emit(Events.aiToolCall, { callId: 'c', name: 'unknown', arguments: '{}' })
    await flush()
    expect(backend.callsTo(Ipc.aiToolResult)).toHaveLength(1)
    off()
    uninstall()
  })
})

describe('lib/agentTools snapshot helpers', () => {
  it('readStudioSnapshot reads live state at call time, or null before registration', () => {
    expect(readStudioSnapshot()).toBeNull()
    let title = 'first'
    registerStudioTools(api({ snapshot: () => snapshot({ title }) }))
    title = 'second'
    expect(readStudioSnapshot()!.title).toBe('second')
  })

  it('applyStudioDescription writes only when a canvas is selected', () => {
    expect(applyStudioDescription('x')).toBe(false)
    const tools = api({ snapshot: vi.fn(() => null) })
    registerStudioTools(tools)
    expect(applyStudioDescription('x')).toBe(false)
    expect(tools.setPrompt).not.toHaveBeenCalled()
    const ready = api()
    registerStudioTools(ready)
    expect(applyStudioDescription('new text')).toBe(true)
    expect(ready.setPrompt).toHaveBeenCalledWith('new text')
  })

  it('formatStudioContext describes the canvas, its description and regions', () => {
    expect(formatStudioContext(null)).toBeUndefined()
    expect(formatStudioContext(snapshot({ description: '  ' }))).toBe(
      ['The user is working on the Studio canvas "Poster" (1024×768).', 'Its description is empty.', 'It has no regions.'].join('\n'),
    )
    const text = formatStudioContext(
      snapshot({
        description: '  A cat poster  ',
        regions: [
          { kind: 'text', caption: 'title', text: 'MEOW', visible: true },
          { kind: 'object', caption: ' ', visible: false },
          { kind: 'text', caption: 'empty text', visible: true },
        ],
      }),
    )!
    expect(text.split('\n')).toEqual([
      'The user is working on the Studio canvas "Poster" (1024×768).',
      'Its description currently reads:',
      'A cat poster',
      'Its regions, in order:',
      '1. text: title [text: MEOW]',
      '2. object: (no caption) (hidden)',
      '3. text: empty text',
    ])
  })
})
