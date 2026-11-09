import { describe, expect, it } from 'vitest'
import type { ControlAdapterEntry, EngineFeatures, ProjectCanvas } from '@shared/types'
import { cardRect, overlaps } from '@renderer/pages/studio/boardLayout'
import { canvasFromPicture, defaultSettings, migrateCanvas, removeCanvasFrom, removedWith } from '@renderer/pages/studio/canvases'
import { newCanvasMenu } from '@renderer/pages/studio/connect'
import { recipes } from '@renderer/pages/studio/recipes'
import {
  boardCanvases,
  canDropRun,
  canUnpin,
  dropRun,
  filmstripOf,
  foldedRunIds,
  givesPicture,
  isActiveRun,
  keepCardsShown,
  pictureLink,
  pinRun,
  shownRun,
  spotBeside,
  staleRunIds,
  unpinRun,
  withRunSettings,
} from '@renderer/pages/studio/runs'
import { canvas, layer } from './fixtures'

const out = (name: string, seed = 1) => ({ path: `/out/${name}.png`, width: 1024, height: 1024, seed })
const run = (id: string, patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  canvas({ id, kind: 'result', sourceCanvasId: 'l', title: '画面 1 · 结果', jobState: 'succeeded', outputs: [out(id)], ...patch })
const layout = (patch: Partial<ProjectCanvas> = {}): ProjectCanvas => canvas({ id: 'l', prompt: '春天', ...patch })

describe('studio/runs foldedRunIds', () => {
  it('folds the runs of a 画面 into its filmstrip, but not pinned ones, ones feeding a canvas, or orphans', () => {
    const other = canvas({ id: 'm', x: 600, inputs: { init: { link: { canvasId: 'fed' }, strength: 0.6 } } })
    const list = [
      layout(),
      run('a'),
      run('pinned', { pinned: true }),
      run('fed'),
      run('orphan', { sourceCanvasId: 'gone' }),
      // A run of a result card is a card of its own, as before.
      run('again', { sourceCanvasId: 'pinned' }),
      other,
    ]
    expect([...foldedRunIds(list)]).toEqual(['a'])
    expect(boardCanvases(list).map((item) => item.id)).toEqual(['l', 'pinned', 'fed', 'orphan', 'again', 'm'])
  })

  it("does not count a result card's frozen inputs as feeding", () => {
    const frozen = run('b', { inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    expect([...foldedRunIds([layout(), run('a'), frozen])]).toEqual(['a', 'b'])
  })
})

describe('studio/runs filmstrip', () => {
  it("lists every picture oldest first, the 画面's own first run included, and shows the newest", () => {
    // An older project: the first run rendered on the 画面 itself.
    const own = layout({ jobId: 'j0', jobState: 'succeeded', outputs: [out('own')] })
    const list = [own, run('a', { outputs: [out('a0'), out('a1')] }), run('b', { jobState: 'running', outputs: [] })]
    const strip = filmstripOf(own, list)
    expect(strip.items.map((item) => [item.runId, item.output, item.path ?? null, item.number])).toEqual([
      ['l', 0, '/out/own.png', 1],
      ['a', 0, '/out/a0.png', 2],
      ['a', 1, '/out/a1.png', 3],
      ['b', 0, null, 4],
    ])
    expect(strip.shown).toBe(3)
  })

  it("drops older runs without pictures, and shows the newest run's first picture", () => {
    const list = [layout(), run('failed', { jobState: 'failed', outputs: [] }), run('a', { outputs: [out('a0'), out('a1')] })]
    const strip = filmstripOf(list[0]!, list)
    expect(strip.items.map((item) => [item.runId, item.output])).toEqual([
      ['a', 0],
      ['a', 1],
    ])
    expect(strip.shown).toBe(0)
  })

  it('shows the picture picked in the strip, and the newest when the pick is gone', () => {
    const picked = layout({ shownOutput: { canvasId: 'a', output: 1 } })
    const list = [picked, run('a', { outputs: [out('a0'), out('a1')] }), run('b')]
    expect(shownRun(picked, list)).toMatchObject({ run: { id: 'a' }, item: { output: 1, path: '/out/a1.png' } })
    const stale = layout({ shownOutput: { canvasId: 'deleted' } })
    expect(shownRun(stale, [stale, run('a'), run('b')])?.run.id).toBe('b')
    expect(shownRun(layout(), [layout()])).toBeNull()
  })

  it('gives wires the picture on the face', () => {
    const picked = layout({ shownOutput: { canvasId: 'a', output: 1 } })
    const list = [picked, run('a', { outputs: [out('a0'), out('a1')] }), run('b')]
    expect(pictureLink(list, { canvasId: 'l' })).toEqual({ canvasId: 'a', output: 1 })
    expect(pictureLink([layout(), run('b')], { canvasId: 'l' })).toEqual({ canvasId: 'b' })
    // Nothing to give yet, or not a 画面: the link stays as it is.
    expect(pictureLink([layout(), run('b', { outputs: [], jobState: 'running' })], { canvasId: 'l' })).toEqual({ canvasId: 'l' })
    expect(pictureLink(list, { canvasId: 'a', output: 0 })).toEqual({ canvasId: 'a', output: 0 })
    expect(givesPicture(layout(), [layout(), run('b')])).toBe(true)
    expect(givesPicture(layout(), [layout()])).toBe(false)
  })
})

describe('studio/runs pin, unpin and drop', () => {
  it('pins a run under its 画面, clear of other cards; it stays in the strip and on the face', () => {
    const blocker = canvas({ id: 'x', y: 400 })
    const list = [layout({ shownOutput: { canvasId: 'a' } }), run('a', { y: 5000 }), run('b', { y: 9000 }), blocker]
    const pinned = pinRun(list, 'a')
    const card = pinned.find((item) => item.id === 'a')!
    expect(card.pinned).toBe(true)
    expect(card.y).toBeLessThan(5000)
    for (const other of boardCanvases(pinned).filter((item) => item.id !== 'a'))
      expect(overlaps(cardRect(card), cardRect(other))).toBe(false)
    expect(pinned.find((item) => item.id === 'l')!.shownOutput).toEqual({ canvasId: 'a' })
    expect(foldedRunIds(pinned).has('a')).toBe(false)
    expect(filmstripOf(pinned[0]!, pinned).items.map((item) => item.runId)).toEqual(['a', 'b'])
    expect(shownRun(pinned[0]!, pinned)?.run.id).toBe('a')
  })

  it('keeps a card that would fold after an edit (an older run losing its wire)', () => {
    const feeds = canvas({ id: 'm', x: 600, inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    const before = [layout(), run('a'), feeds]
    const after = [layout(), run('a'), canvas({ id: 'm', x: 600 })]
    expect(foldedRunIds(after).has('a')).toBe(true)
    const kept = keepCardsShown(before, after)
    expect(kept.find((item) => item.id === 'a')!.pinned).toBe(true)
    expect(keepCardsShown(after, after)).toBe(after)
  })

  it('pins where the thumbnail was dropped, and leaves the 画面 and cards alone', () => {
    const pinned = pinRun([layout(), run('a')], 'a', { x: 812.4, y: -40.6 })
    expect(pinned.find((item) => item.id === 'a')).toMatchObject({ pinned: true, x: 812, y: -41 })
    expect(pinRun([layout()], 'l')).toEqual([layout()])
  })

  it('puts a pinned run back, unless its 画面 is gone', () => {
    const list = [layout(), run('a', { pinned: true })]
    expect(canUnpin(list[1]!, list)).toBe(true)
    expect(foldedRunIds(unpinRun(list, 'a')).has('a')).toBe(true)
    expect(canUnpin(run('a', { pinned: true, sourceCanvasId: 'gone' }), list)).toBe(false)
  })

  it('only drops a run nothing depends on: a card is deleted from its card, a fed first run stays', () => {
    const own = layout({ jobId: 'j0', jobState: 'succeeded', outputs: [out('own')] })
    const feeds = canvas({ id: 'm', x: 600, inputs: { init: { link: { canvasId: 'l' }, strength: 0.6 } } })
    expect(canDropRun([own, feeds], 'l')).toBe(false)
    expect(dropRun([own, feeds], 'l')[0]).toBe(own)
    expect(canDropRun([own, run('p', { pinned: true })], 'p')).toBe(false)
    expect(canDropRun([own, run('a')], 'a')).toBe(true)
  })

  it("drops a run: a result goes, the 画面's own first run only loses its pictures", () => {
    const list = [layout({ jobId: 'j0', jobState: 'succeeded', outputs: [out('own')], shownOutput: { canvasId: 'a' } }), run('a')]
    const withoutA = dropRun(list, 'a')
    expect(withoutA.map((item) => item.id)).toEqual(['l'])
    expect(withoutA[0]!.shownOutput).toBeUndefined()
    const withoutOwn = dropRun(list, 'l')
    expect(withoutOwn[0]).toMatchObject({ id: 'l', prompt: '春天' })
    expect(withoutOwn[0]!.outputs).toBeUndefined()
    expect(withoutOwn[0]!.jobId).toBeUndefined()
  })

  it('deletes a 画面 together with its filmstrip, but keeps pinned runs and their links', () => {
    const feeds = canvas({ id: 'm', x: 600, inputs: { references: { links: [{ canvasId: 'l' }] } } })
    const list = [layout(), run('a'), run('b'), run('pinned', { pinned: true }), feeds]
    expect(removedWith(list, 'l')).toEqual(['l', 'a', 'b'])
    const { canvases, removedLinks } = removeCanvasFrom(list, 'l')
    expect(canvases.map((item) => item.id)).toEqual(['pinned', 'm'])
    expect(removedLinks).toBe(1)
  })
})

describe('studio/runs liveness and clean-up', () => {
  it('a run is going while its job is, or while it is being submitted; a lost job is not', () => {
    expect(isActiveRun({ jobId: 'j', jobState: 'succeeded' }, [{ id: 'j', state: 'running' }])).toBe(true)
    expect(isActiveRun({ jobId: 'gone', jobState: 'running' }, [])).toBe(false)
    expect(isActiveRun({ jobState: 'starting' }, [])).toBe(true)
    expect(isActiveRun({ jobId: 'j', jobState: 'running' }, [{ id: 'j', state: 'failed' }])).toBe(false)
  })

  it('a result that another result was made from stays a card, so its lineage wire does', () => {
    const list = [layout(), run('a', { pinned: true }), run('b', { sourceCanvasId: 'a' }), run('c')]
    expect([...foldedRunIds(unpinRun(list, 'a'))]).toEqual(['c'])
    expect(removedWith(unpinRun(list, 'a'), 'l')).toEqual(['l', 'c'])
  })

  it('finds the old runs without pictures that only take room', () => {
    const list = [
      layout(),
      run('failed', { jobState: 'failed', outputs: [] }),
      run('going', { jobId: 'j', jobState: 'running', outputs: [] }),
      run('ok'),
      run('pinned', { pinned: true, jobState: 'failed', outputs: [] }),
    ]
    expect(staleRunIds('l', list, [{ id: 'j', state: 'running' }])).toEqual(['failed'])
  })

  it('opens a run saved mid-submit (no job id) as not submitted', () => {
    const stuck = migrateCanvas(run('a', { jobState: 'starting', outputs: [] }))
    expect(stuck).toMatchObject({ jobState: 'failed', error: { code: 'E_SUBMIT' } })
    expect(migrateCanvas(run('b', { jobId: 'j', jobState: 'running' })).jobState).toBe('running')
  })
})

describe('studio/runs withRunSettings', () => {
  it('takes back what a run was made with, seed locked, and keeps the pictures linked now', () => {
    const now = layout({ prompt: '夏天', steps: 8, inputs: { init: { link: { canvasId: 'p' }, strength: 0.6 } } })
    const made = run('a', {
      prompt: '春天',
      layers: [layer()],
      steps: 50,
      cfg: 4,
      width: 1536,
      height: 1536,
      baseSize: { width: 1024, height: 1024 },
      sampling: { sampler: 'euler' } as never,
      outputs: [out('a', 4242)],
      modelBundleId: 'moss-sft',
    })
    const next = withRunSettings(now, made)
    expect(next).toMatchObject({ id: 'l', kind: 'layout', prompt: '春天', steps: 50, cfg: 4, width: 1024, height: 1024, seed: 4242 })
    expect(next).toMatchObject({ seedLocked: true, modelBundleId: 'moss-sft', layers: [layer()], sampling: { sampler: 'euler' } })
    expect(next.inputs).toEqual(now.inputs)
    expect(withRunSettings(now, now)).toBe(now)
  })
})

describe('studio/canvases canvasFromPicture', () => {
  it('用作起始图: a 画面 to the right, with the description, fed by the picked run (now pinned)', () => {
    const source = layout({ layers: [layer()], steps: 50 })
    const list = [source, run('a')]
    const made = canvasFromPicture(list, 'l', { role: 'init', fallback: defaultSettings(), id: 'n' })!
    expect(made.created).toMatchObject({ id: 'n', kind: 'layout', prompt: '春天', steps: 50 })
    expect(made.created.x).toBeGreaterThan(source.x)
    expect(made.created.inputs?.init).toEqual({ link: { canvasId: 'a' }, strength: 0.6 })
    expect(made.created.layers[0]!.id).not.toBe(layer().id)
    expect(made.canvases.find((item) => item.id === 'a')!.pinned).toBe(true)
    for (const other of made.canvases.filter((item) => item.id !== 'n'))
      expect(overlaps(cardRect(made.created), cardRect(other))).toBe(false)
  })

  it('as a reference, or from a picture card: settings only, at the drop point', () => {
    const picture = canvas({ id: 'p', kind: 'image', imagePath: '/p.png', prompt: '' })
    const made = canvasFromPicture([picture], 'p', { role: 'reference', fallback: defaultSettings(), at: { x: 900.2, y: 40 }, id: 'n' })!
    expect(made.created).toMatchObject({ x: 900, y: 40, prompt: '' })
    expect(made.created.inputs?.references?.links).toEqual([{ canvasId: 'p' }])
    expect(canvasFromPicture([layout()], 'l', { role: 'init', fallback: defaultSettings() })).toBeNull()
  })

  it('spotBeside steps down past cards in the way', () => {
    const near = layout()
    const right = canvas({ id: 'r', x: cardRect(near).w + 80, y: 0 })
    const spot = spotBeside(near, near, [near, right])
    expect(spot.x).toBe(right.x)
    expect(spot.y).toBeGreaterThan(cardRect(right).h)
  })
})

describe('studio/recipes', () => {
  const features = (patch: Partial<EngineFeatures> = {}): EngineFeatures => ({
    preview: true,
    imageInput: true,
    control: true,
    references: true,
    hires: true,
    samplers: true,
    lora: true,
    values: {},
    ...patch,
  })
  const adapter: ControlAdapterEntry = {
    id: 'ctl',
    name: 'union',
    path: '/m/ctl.safetensors',
    sizeBytes: 1,
    controlKinds: ['depth'],
    addedAt: '2026-11-05T00:00:00Z',
  }
  const brief = (list: ReturnType<typeof recipes>) => list.map((recipe) => [recipe.id, recipe.role ?? null, recipe.disabled ?? null])

  it('offers every recipe the engine can do, and says why the others are off', () => {
    expect(brief(recipes(features(), [adapter]))).toEqual([
      ['edit', 'init', null],
      ['inpaint', 'init', null],
      ['compose', 'control', null],
      ['style', 'reference', null],
      ['upscale', 'init', null],
      ['series', null, null],
    ])
    expect(recipes(features(), [])[2]!.disabled).toBe('需要先在模型页添加控制适配器')
    expect(recipes(features({ references: false }), [adapter])[3]!.disabled).toBe('现在的引擎不支持这个做法')
    const noEngine = recipes(null, [], [{ id: 'engine', message: '引擎还没装好' }])
    expect(noEngine[0]!.disabled).toBe('引擎还没装好，就绪后才能使用')
    // A 风格 and three 画面 are only laid out: no engine needed.
    expect(noEngine.find((recipe) => recipe.id === 'series')!.disabled).toBeUndefined()
    // Still reading what the engine can do: offered.
    expect(recipes(undefined, [adapter]).every((recipe) => !recipe.disabled)).toBe(true)
  })

  it('a wire dropped on the empty board offers a new 画面 the engine can feed', () => {
    expect(newCanvasMenu(features())).toEqual([
      { type: 'item', role: 'init', label: '新画面 · 起始图' },
      { type: 'item', role: 'reference', label: '新画面 · 参考图' },
      { type: 'item', role: 'init', kind: 'upscale', label: '放大' },
    ])
    expect(newCanvasMenu(features({ imageInput: false, references: false }))).toEqual([
      { type: 'note', label: '现在的引擎不能把图片接进新画面' },
    ])
  })
})
