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
import { createMockBackend } from '../../mocks/backend'
import { flush } from '../../helpers/renderer'

function snapshot(patch: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return { title: 'Poster', description: 'A poster', width: 1024, height: 768, regions: [], ...patch }
}

function api(patch: Partial<StudioToolApi> = {}): StudioToolApi {
  return {
    readContext: vi.fn(() => ({ prompt: 'p' })),
    snapshot: vi.fn(() => snapshot()),
    setPrompt: vi.fn(),
    setSampler: vi.fn((patch) => ({ applied: patch })),
    addLayer: vi.fn((input) => ({ id: 'layer-1', ...input })),
    generate: vi.fn(async () => ({ jobId: 'j' })),
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

  it('reads context', async () => {
    registerStudioTools(api())
    expect(await run('studio_read_context')).toEqual({ ok: true, content: JSON.stringify({ prompt: 'p' }) })
  })

  it('sets a non-blank prompt and reports its length', async () => {
    const tools = api()
    registerStudioTools(tools)
    expect(parse((await run('studio_set_prompt', { prompt: 'a red fox' })).content)).toEqual({ written: 9 })
    expect(tools.setPrompt).toHaveBeenCalledWith('a red fox')
    for (const args of [{ prompt: '   ' }, { prompt: 42 }, {}]) {
      const result = await run('studio_set_prompt', args)
      expect(result.ok).toBe(false)
    }
    expect(tools.setPrompt).toHaveBeenCalledTimes(1)
  })

  it('passes only finite numeric sampler fields', async () => {
    const tools = api()
    registerStudioTools(tools)
    await run('studio_set_sampler', { width: 768, steps: '20', cfg: Number.NaN, seed: 3 })
    expect(tools.setSampler).toHaveBeenCalledWith({ width: 768, height: undefined, steps: undefined, cfg: undefined, seed: 3 })
    const empty = await run('studio_set_sampler', { steps: 'many' })
    expect(empty.ok).toBe(false)
    expect(parse(empty.content).error).toBe('没有可更新的字段')
  })

  it('validates layer label and caption, and keeps only complete numeric boxes', async () => {
    const tools = api()
    registerStudioTools(tools)
    expect((await run('studio_add_layer', { label: 'banner', caption: 'x' })).ok).toBe(false)
    expect((await run('studio_add_layer', { label: 'text', caption: '  ' })).ok).toBe(false)
    await run('studio_add_layer', { label: 'character', caption: ' hero ', bbox: { x: 1, y: 2, w: 3, h: 4 } })
    await run('studio_add_layer', { label: 'object', caption: 'tree', bbox: { x: 1, y: 2, w: '3', h: 4 } })
    expect(tools.addLayer).toHaveBeenNthCalledWith(1, { label: 'character', caption: 'hero', bbox: { x: 1, y: 2, w: 3, h: 4 } })
    expect(tools.addLayer).toHaveBeenNthCalledWith(2, { label: 'object', caption: 'tree', bbox: undefined })
  })

  it('generates with an optional prompt and defaults the result', async () => {
    const tools = api({ generate: vi.fn(async () => undefined) })
    registerStudioTools(tools)
    expect(parse((await run('studio_generate', { prompt: 'x' })).content)).toEqual({ queued: true })
    await run('studio_generate', { prompt: 7 })
    expect(tools.generate).toHaveBeenNthCalledWith(1, 'x')
    expect(tools.generate).toHaveBeenNthCalledWith(2, undefined)
  })

  it('treats malformed or non-object arguments as empty', async () => {
    const tools = api()
    registerStudioTools(tools)
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
