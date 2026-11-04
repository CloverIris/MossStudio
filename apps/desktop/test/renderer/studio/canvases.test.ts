import { describe, expect, it } from 'vitest'
import type { AdapterEntry, JobRecord } from '@shared/types'
import {
  applyJobs,
  canvasFromReuse,
  copyAsLayout,
  createLayoutCanvas,
  defaultSettings,
  matchAdapterPath,
  moveBox,
  regionFromDrag,
  reorderLayers,
  resizeBox,
  resizeCanvas,
  settingsFrom,
  taskCanvasFor,
} from '@renderer/pages/studio/canvases'
import { canvas, layer } from './fixtures'

describe('studio/canvases creation', () => {
  it('starts a blank canvas with plain defaults: random seed, 标准 quality, 1:1', () => {
    const settings = defaultSettings()
    expect(settings).toMatchObject({ width: 1024, height: 1024, steps: 20, cfg: 3, seedLocked: false, adapters: [] })
    const created = createLayoutCanvas([], settings, 'new')
    expect(created).toMatchObject({ id: 'new', kind: 'layout', title: '画面 1', x: 0, y: 0, prompt: '', layers: [] })
  })

  it('carries the current settings over to the next canvas', () => {
    const current = canvas({ width: 1280, height: 720, steps: 8, cfg: 1, modelBundleId: 'rl', seedLocked: true, seed: 5, adapters: [{ id: 'style', strength: 0.5 }] })
    const next = createLayoutCanvas([current], settingsFrom(current), 'n')
    expect(next).toMatchObject({ title: '画面 2', width: 1280, height: 720, steps: 8, cfg: 1, modelBundleId: 'rl', seedLocked: true, seed: 5 })
    expect(next.adapters).toEqual([{ id: 'style', strength: 0.5 }])
  })

  it('copies any canvas into an editable layout with fresh region ids', () => {
    const source = canvas({ kind: 'result', prompt: 'p', layers: [layer()], backgroundPath: '/bg.png', outputs: [{ path: '/o.png', width: 1, height: 1, seed: 1 }] })
    const copy = copyAsLayout(source, [source], 'copy')
    expect(copy).toMatchObject({ id: 'copy', kind: 'layout', prompt: 'p', backgroundPath: '/bg.png' })
    expect(copy.outputs).toBeUndefined()
    expect(copy.layers[0]!.id).not.toBe('r1')
    expect(copy.layers[0]!.caption).toBe('a red bicycle')
  })
})

describe('studio/canvases taskCanvasFor', () => {
  it('runs a fresh layout canvas in place', () => {
    const source = canvas({ prompt: 'x' })
    const result = taskCanvasFor(source, [source], 'unused')
    expect(result.taskId).toBe('c1')
    expect(result.canvases).toHaveLength(1)
    expect(result.canvases[0]).toMatchObject({ jobState: 'starting', outputs: [] })
  })

  it('keeps earlier pictures: a re-run gets its own result card under the source', () => {
    const source = canvas({ prompt: 'x', outputs: [{ path: '/o.png', width: 1, height: 1, seed: 1 }] })
    const result = taskCanvasFor(source, [source], 'task')
    expect(result.taskId).toBe('task')
    expect(result.canvases).toHaveLength(2)
    expect(result.canvases[0]).toBe(source)
    expect(result.canvases[1]).toMatchObject({ id: 'task', kind: 'result', sourceCanvasId: 'c1', title: '画面 1 · 结果', outputs: [] })
    expect(result.canvases[1]!.y).toBeGreaterThan(source.y)
  })
})

describe('studio/canvases applyJobs', () => {
  it('copies job state and outputs, and returns the same array when nothing changed', () => {
    const tracked = canvas({ jobId: 'j', jobState: 'running' })
    const jobs = [{ id: 'j', state: 'succeeded', outputs: [{ path: '/a.png', width: 1, height: 1, seed: 1 }] } as JobRecord]
    const next = applyJobs([tracked], jobs)
    expect(next[0]).toMatchObject({ jobState: 'succeeded', outputs: [{ path: '/a.png' }] })
    expect(applyJobs(next, jobs)).toBe(next)
  })
})

describe('studio/canvases regions', () => {
  const size = { width: 100, height: 100 }

  it('turns a big enough drag into a region box in any direction', () => {
    expect(regionFromDrag([80, 90], [20, 10], size)).toEqual([20, 10, 80, 90])
    expect(regionFromDrag([10, 10], [15, 50], size)).toBeNull()
  })

  it('keeps moved and resized boxes inside the picture', () => {
    expect(moveBox([10, 10, 30, 30], 200, -50, size)).toEqual([80, 0, 100, 20])
    expect(resizeBox([10, 10, 30, 30], 500, -500, size)).toEqual([10, 10, 100, 22])
  })

  it('reorders regions by id', () => {
    const items = [layer({ id: 'a' }), layer({ id: 'b' }), layer({ id: 'c' })]
    expect(reorderLayers(items, 'c', 'a').map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(reorderLayers(items, 'a', 'missing').map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('pulls regions back inside when the picture shrinks', () => {
    const resized = resizeCanvas(canvas({ layers: [layer({ bbox: [600, 600, 1000, 1000] })] }), 512, 512)
    expect(resized.layers[0]!.bbox).toEqual([511, 511, 512, 512])
  })
})

describe('studio/canvases reuse from 作品', () => {
  const library: AdapterEntry[] = [{
    id: 'ink-style', name: 'Ink', provider: 'local', repo: '', revision: '', kind: 'lora', license: '', files: ['loras/ink_v2.safetensors'], sizeBytes: 1, tags: [], installed: true, installedBytes: 1,
  }]

  it('matches LoRA files by name, then by id in the path', () => {
    expect(matchAdapterPath('C:\\models\\ink_v2.safetensors', library)?.id).toBe('ink-style')
    expect(matchAdapterPath('/data/adapters/ink-style/weights.safetensors', library)?.id).toBe('ink-style')
    expect(matchAdapterPath('/data/other.safetensors', library)).toBeUndefined()
  })

  it('builds a new canvas with the image parameters and a locked seed', () => {
    const { canvas: created, missingAdapters } = canvasFromReuse({
      id: 'r', createdAt: '', sourcePath: '/o.png', prompt: 'a cat', negativePrompt: 'blurry', width: 1000, height: 760, seed: 77, steps: 8, cfg: 1,
      modelBundleId: 'rl', adapters: [{ path: '/x/ink_v2.safetensors', strength: 0.7 }, { path: '/x/unknown.safetensors', strength: 1 }],
    }, [], defaultSettings(), library, 'reuse')
    expect(created).toMatchObject({ id: 'reuse', kind: 'layout', prompt: 'a cat', negative: 'blurry', width: 1008, height: 768, seed: 77, seedLocked: true, steps: 8, cfg: 1, modelBundleId: 'rl' })
    expect(created.summary.caption).toBe('a cat')
    expect(created.adapters).toEqual([{ id: 'ink-style', strength: 0.7 }])
    expect(missingAdapters).toEqual(['unknown.safetensors'])
  })

  it('keeps defaults for anything the image did not record', () => {
    const { canvas: created } = canvasFromReuse({ id: 'r', createdAt: '', sourcePath: '/o.png', prompt: 'p' }, [], defaultSettings(), [], 'x')
    expect(created).toMatchObject({ width: 1024, height: 1024, steps: 20, seedLocked: false })
  })
})

describe('studio/canvases migrateCanvas', () => {
  it('fills in the seed lock for canvases saved before it existed', async () => {
    const { migrateCanvas } = await import('@renderer/pages/studio/canvases')
    expect(migrateCanvas(canvas({ seed: 99 })).seedLocked).toBe(true)
    expect(migrateCanvas(canvas({ seed: 42 })).seedLocked).toBe(false)
    const current = canvas({ seed: 99, seedLocked: false })
    expect(migrateCanvas(current)).toBe(current)
  })
})
