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
    const current = canvas({
      width: 1280,
      height: 720,
      steps: 8,
      cfg: 1,
      modelBundleId: 'rl',
      seedLocked: true,
      seed: 5,
      adapters: [{ id: 'style', strength: 0.5 }],
    })
    const next = createLayoutCanvas([current], settingsFrom(current), 'n')
    expect(next).toMatchObject({
      title: '画面 2',
      width: 1280,
      height: 720,
      steps: 8,
      cfg: 1,
      modelBundleId: 'rl',
      seedLocked: true,
      seed: 5,
    })
    expect(next.adapters).toEqual([{ id: 'style', strength: 0.5 }])
  })

  it('copies any canvas into an editable layout with fresh region ids', () => {
    const source = canvas({
      kind: 'result',
      prompt: 'p',
      layers: [layer()],
      backgroundPath: '/bg.png',
      outputs: [{ path: '/o.png', width: 1, height: 1, seed: 1 }],
    })
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
  const library: AdapterEntry[] = [
    {
      id: 'ink-style',
      name: 'Ink',
      provider: 'local',
      repo: '',
      revision: '',
      kind: 'lora',
      license: '',
      files: ['loras/ink_v2.safetensors'],
      sizeBytes: 1,
      tags: [],
      installed: true,
      installedBytes: 1,
    },
  ]

  it('matches LoRA files by name, then by id in the path', () => {
    expect(matchAdapterPath('C:\\models\\ink_v2.safetensors', library)?.id).toBe('ink-style')
    expect(matchAdapterPath('/data/adapters/ink-style/weights.safetensors', library)?.id).toBe('ink-style')
    expect(matchAdapterPath('/data/other.safetensors', library)).toBeUndefined()
  })

  it('builds a new canvas with the image parameters and a locked seed', () => {
    const { canvas: created, missingAdapters } = canvasFromReuse(
      {
        id: 'r',
        createdAt: '',
        sourcePath: '/o.png',
        prompt: 'a cat',
        negativePrompt: 'blurry',
        width: 1000,
        height: 760,
        seed: 77,
        steps: 8,
        cfg: 1,
        modelBundleId: 'rl',
        adapters: [
          { path: '/x/ink_v2.safetensors', strength: 0.7 },
          { path: '/x/unknown.safetensors', strength: 1 },
        ],
      },
      [],
      defaultSettings(),
      library,
      'reuse',
    )
    expect(created).toMatchObject({
      id: 'reuse',
      kind: 'layout',
      prompt: 'a cat',
      negative: 'blurry',
      width: 1008,
      height: 768,
      seed: 77,
      seedLocked: true,
      steps: 8,
      cfg: 1,
      modelBundleId: 'rl',
    })
    expect(created.summary.caption).toBe('a cat')
    expect(created.adapters).toEqual([{ id: 'ink-style', strength: 0.7 }])
    expect(missingAdapters).toEqual(['unknown.safetensors'])
  })

  it('keeps defaults for anything the image did not record', () => {
    const { canvas: created } = canvasFromReuse(
      { id: 'r', createdAt: '', sourcePath: '/o.png', prompt: 'p' },
      [],
      defaultSettings(),
      [],
      'x',
    )
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

describe('studio/canvases inputs and pictures', () => {
  const out = (path: string, size = 1024) => ({ path, width: size, height: size, seed: 1 })

  it('migrates saved inputs: numbers pulled into range, a mask without a start picture and dangling links dropped', async () => {
    const { migrateCanvases } = await import('@renderer/pages/studio/canvases')
    const source = canvas({ id: 'src', kind: 'image', imagePath: '/a.png', seedLocked: false })
    const list = migrateCanvases([
      source,
      canvas({
        id: 'a',
        seedLocked: false,
        inputs: { init: { link: { canvasId: 'src' }, strength: 3 }, references: { links: [{ canvasId: 'gone' }, { canvasId: 'src' }] } },
        sampling: { sampler: '' },
      }),
      canvas({
        id: 'b',
        seedLocked: false,
        inputs: {
          mask: { path: '/m.png' },
          control: { adapterId: 'x', images: [{ kind: 'depth', link: { canvasId: 'src' }, strength: 99, start: 0.7, end: 0.2 }] },
        },
      }),
    ])
    expect(list[1]!.inputs).toEqual({ init: { link: { canvasId: 'src' }, strength: 1 }, references: { links: [{ canvasId: 'src' }] } })
    expect('sampling' in list[1]!).toBe(false)
    expect(list[2]!.inputs).toEqual({
      control: { adapterId: 'x', images: [{ kind: 'depth', link: { canvasId: 'src' }, strength: 10, start: 0.7, end: 0.7 }] },
    })
    // Old canvases without inputs come through untouched.
    const plain = canvas({ seedLocked: true })
    expect(migrateCanvases([plain])[0]).toBe(plain)
  })

  it('copies keep their inputs and sampling; the links still point at the same sources', () => {
    const source = canvas({
      id: 's',
      inputs: { init: { link: { canvasId: 'img' }, strength: 0.4 }, mask: { path: '/m.png' } },
      sampling: { sampler: 'euler', hires: { width: 2048, height: 2048 } },
    })
    const copy = copyAsLayout(source, [source], 'copy')
    expect(copy.inputs).toEqual(source.inputs)
    expect(copy.inputs).not.toBe(source.inputs)
    expect(copy.sampling).toEqual(source.sampling)
  })

  it('a copy of a 高清修复 result starts again at the first-pass size', () => {
    const result = canvas({
      id: 'r',
      kind: 'result',
      width: 2048,
      height: 2048,
      baseSize: { width: 1024, height: 1024 },
      sampling: { hires: { width: 2048, height: 2048 } },
    })
    expect(copyAsLayout(result, [result], 'c')).toMatchObject({
      width: 1024,
      height: 1024,
      sampling: { hires: { width: 2048, height: 2048 } },
    })
    expect(settingsFrom(result)).toMatchObject({ width: 1024, height: 1024 })
    // New canvases inherit sampler choices, not the costly second pass.
    expect(settingsFrom(canvas({ sampling: { sampler: 'heun', hires: { width: 2048, height: 2048 } } })).sampling).toEqual({
      sampler: 'heun',
    })
  })

  it('a picture card copies as another picture card and gives no settings to new canvases', async () => {
    const { createImageCanvas } = await import('@renderer/pages/studio/canvases')
    const card = createImageCanvas([], { path: '/assets/photo.final.jpg', width: 3000, height: 2000 }, undefined, 'img')
    expect(card).toMatchObject({
      id: 'img',
      kind: 'image',
      imagePath: '/assets/photo.final.jpg',
      title: 'photo.final',
      width: 1024,
      height: 683,
      imageSize: { width: 3000, height: 2000 },
    })
    // The copy keeps the real pixel size, not the card size.
    expect(copyAsLayout(card, [card], 'img2')).toMatchObject({
      id: 'img2',
      kind: 'image',
      imagePath: '/assets/photo.final.jpg',
      width: 1024,
      height: 683,
      imageSize: { width: 3000, height: 2000 },
    })
    expect(settingsFrom(card)).toEqual(defaultSettings())
  })

  it('places a picture card left of the canvas it feeds, below anything already there', async () => {
    const { createImageCanvas } = await import('@renderer/pages/studio/canvases')
    const near = canvas({ id: 'n', x: 600, y: 100 })
    const first = createImageCanvas([near], { path: '/a.png', width: 1024, height: 1024 }, near, 'a')
    expect(first.x + 256).toBeLessThan(600)
    expect(first.y).toBe(100)
    const second = createImageCanvas([near, first], { path: '/b.png', width: 1024, height: 1024 }, near, 'b')
    expect(second.x).toBe(first.x)
    expect(second.y).toBeGreaterThan(first.y)
  })

  it('a 高清修复 run gets a result card at the output size that remembers the first pass', () => {
    const source = canvas({ id: 's', outputs: [out('/o.png')], sampling: { hires: { width: 1536, height: 1536 } } })
    const { canvases, taskId } = taskCanvasFor(source, [source], 'task')
    const task = canvases.find((item) => item.id === taskId)!
    expect(task).toMatchObject({ width: 1536, height: 1536, baseSize: { width: 1024, height: 1024 }, kind: 'result' })
    // Running that result again repeats it at the same sizes.
    const again = taskCanvasFor(task, canvases, 'again').canvases.find((item) => item.id === 'again')!
    expect(again).toMatchObject({ width: 1536, height: 1536, baseSize: { width: 1024, height: 1024 } })
    // Without hires nothing changes.
    const plain = canvas({ id: 'p', outputs: [out('/o.png')] })
    const plainTask = taskCanvasFor(plain, [plain], 'pt').canvases.find((item) => item.id === 'pt')!
    expect(plainTask).toMatchObject({ width: 1024, height: 1024 })
    expect('baseSize' in plainTask).toBe(false)
  })

  it('resizing keeps a hires target in proportion', () => {
    const resized = resizeCanvas(canvas({ sampling: { hires: { width: 2048, height: 2048 } } }), 1280, 720)
    expect(resized.sampling?.hires).toEqual({ width: 2560, height: 1440 })
  })

  it('deleting a canvas drops the links that pointed at it and counts them', async () => {
    const { removeCanvasFrom } = await import('@renderer/pages/studio/canvases')
    const list = [
      canvas({ id: 'img', kind: 'image', imagePath: '/a.png' }),
      canvas({
        id: 'a',
        inputs: { init: { link: { canvasId: 'img' }, strength: 0.6 }, references: { links: [{ canvasId: 'img', output: 1 }] } },
      }),
      canvas({ id: 'b' }),
    ]
    const { canvases, removedLinks } = removeCanvasFrom(list, 'img')
    expect(canvases.map((item) => item.id)).toEqual(['a', 'b'])
    expect(removedLinks).toBe(2)
    expect(canvases[0]!.inputs).toBeUndefined()
  })
})

describe('studio/canvases review fixes', () => {
  it('reuse carries the image sampling (高清修复 included) onto the new canvas', () => {
    const { canvas: created } = canvasFromReuse(
      {
        id: 'r',
        createdAt: '',
        sourcePath: '/o.png',
        prompt: 'p',
        width: 1024,
        height: 1024,
        seed: 5,
        sampling: { sampler: 'euler', hires: { width: 2048, height: 2048, strength: 0.35 } },
      },
      [],
      { ...defaultSettings(), sampling: { scheduler: 'karras' } },
      [],
      'x',
    )
    expect(created).toMatchObject({
      width: 1024,
      height: 1024,
      sampling: { sampler: 'euler', hires: { width: 2048, height: 2048, strength: 0.35 } },
    })
    const { canvas: plain } = canvasFromReuse(
      { id: 'r', createdAt: '', sourcePath: '/o.png', prompt: 'p' },
      [],
      { ...defaultSettings(), sampling: { scheduler: 'karras' } },
      [],
      'y',
    )
    expect(plain.sampling).toEqual({ scheduler: 'karras' })
  })

  it('result cards keep their recorded inputs when a source is deleted or missing', async () => {
    const { migrateCanvases, removeCanvasFrom } = await import('@renderer/pages/studio/canvases')
    const frozen = { init: { link: { canvasId: 'img' }, strength: 0.6 } }
    const list = [
      canvas({ id: 'img', kind: 'image', imagePath: '/a.png', seedLocked: false }),
      canvas({ id: 'a', seedLocked: false, inputs: frozen }),
      canvas({ id: 'r', kind: 'result', seedLocked: false, inputs: frozen, sourceCanvasId: 'a' }),
    ]
    const { canvases, removedLinks } = removeCanvasFrom(list, 'img')
    expect(removedLinks).toBe(1)
    expect(canvases.find((item) => item.id === 'r')!.inputs).toEqual(frozen)
    expect(canvases.find((item) => item.id === 'a')!.inputs).toBeUndefined()
    const loaded = migrateCanvases(list.slice(1))
    expect(loaded.find((item) => item.id === 'r')!.inputs).toEqual(frozen)
    expect(loaded.find((item) => item.id === 'a')!.inputs).toBeUndefined()
  })
})
