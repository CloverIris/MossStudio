import { describe, expect, it } from 'vitest'
import {
  canvasPicture,
  consumersOf,
  controlKindLabel,
  dropLinksTo,
  linkSourceImage,
  linksOf,
  removeLink,
  setLink,
  wouldCycle,
} from '@renderer/pages/studio/links'
import { canvas } from './fixtures'

const out = (path: string) => ({ path, width: 1024, height: 1024, seed: 1 })

describe('studio/links reading', () => {
  it('lists links in port order with chip labels', () => {
    const target = canvas({
      id: 't',
      inputs: {
        init: { link: { canvasId: 'a' }, strength: 0.6 },
        control: {
          adapterId: 'ad',
          images: [
            { kind: 'depth', link: { canvasId: 'b' }, strength: 1, start: 0, end: 1 },
            { kind: 'lineart', link: { canvasId: 'c' }, strength: 1, start: 0, end: 1 },
          ],
        },
        references: { links: [{ canvasId: 'd' }, { canvasId: 'e' }] },
      },
    })
    expect(linksOf(target).map((entry) => entry.label)).toEqual(['起始图 60%', '控制 · 深度', '控制 · lineart', '参考 1', '参考 2'])
    expect(linksOf(target)[4]).toMatchObject({ role: 'reference', index: 1, link: { canvasId: 'e' } })
    expect(linksOf(canvas())).toEqual([])
  })

  it('names known control kinds plainly and keeps others verbatim', () => {
    expect(controlKindLabel('canny')).toBe('边缘')
    expect(controlKindLabel('pose')).toBe('姿态')
    expect(controlKindLabel('scribble')).toBe('scribble')
  })

  it('resolves a link to the source picture, or null while there is none', () => {
    const image = canvas({ id: 'img', kind: 'image', imagePath: '/assets/a.png' })
    const result = canvas({ id: 'res', kind: 'result', outputs: [out('/o/1.png'), out('/o/2.png')] })
    const running = canvas({ id: 'run', kind: 'result', jobState: 'running', outputs: [] })
    const all = [image, result, running]
    expect(linkSourceImage({ canvasId: 'img', output: 3 }, all)).toBe('/assets/a.png')
    expect(linkSourceImage({ canvasId: 'res' }, all)).toBe('/o/1.png')
    expect(linkSourceImage({ canvasId: 'res', output: 1 }, all)).toBe('/o/2.png')
    expect(linkSourceImage({ canvasId: 'res', output: 9 }, all)).toBe('/o/1.png')
    expect(linkSourceImage({ canvasId: 'run' }, all)).toBeNull()
    expect(linkSourceImage({ canvasId: 'gone' }, all)).toBeNull()
    expect(canvasPicture(canvas({ kind: 'image' }))).toBeNull()
  })
})

describe('studio/links editing', () => {
  it('sets a start picture with the default strength and keeps strength when the source changes', () => {
    const first = setLink(canvas({ id: 't' }), 'init', { canvasId: 'a' })
    expect(first.inputs?.init).toEqual({ link: { canvasId: 'a' }, strength: 0.6 })
    const tuned = {
      ...first,
      inputs: { ...first.inputs, init: { ...first.inputs!.init!, strength: 0.3, resize: 'fit' as const }, mask: { path: '/m.png' } },
    }
    const same = setLink(tuned, 'init', { canvasId: 'a' })
    expect(same.inputs?.mask).toEqual({ path: '/m.png' })
    const moved = setLink(tuned, 'init', { canvasId: 'b' })
    expect(moved.inputs?.init).toEqual({ link: { canvasId: 'b' }, strength: 0.3, resize: 'fit' })
    expect(moved.inputs?.mask).toBeUndefined()
  })

  it('never links a canvas to itself and does not mutate the input', () => {
    const target = canvas({ id: 't' })
    expect(setLink(target, 'init', { canvasId: 't' })).toBe(target)
    setLink(target, 'reference', { canvasId: 'x' })
    expect(target.inputs).toBeUndefined()
  })

  it('sets one control image per kind', () => {
    let target = setLink(canvas({ id: 't' }), 'control', { canvasId: 'a' }, 'depth')
    target = setLink(target, 'control', { canvasId: 'b' }, 'canny')
    target = setLink(target, 'control', { canvasId: 'c' }, 'depth')
    expect(target.inputs?.control).toEqual({
      adapterId: '',
      images: [
        { kind: 'depth', link: { canvasId: 'c' }, strength: 1, start: 0, end: 1 },
        { kind: 'canny', link: { canvasId: 'b' }, strength: 1, start: 0, end: 1 },
      ],
    })
    expect(setLink(target, 'control', { canvasId: 'd' })).toBe(target)
  })

  it('appends references without duplicates', () => {
    let target = setLink(canvas({ id: 't' }), 'reference', { canvasId: 'a' })
    target = setLink(target, 'reference', { canvasId: 'b' })
    expect(setLink(target, 'reference', { canvasId: 'a' })).toBe(target)
    expect(target.inputs?.references?.links).toEqual([{ canvasId: 'a' }, { canvasId: 'b' }])
    const full = setLink(setLink(target, 'reference', { canvasId: 'c' }), 'reference', { canvasId: 'd' })
    expect(setLink(full, 'reference', { canvasId: 'e' })).toBe(full)
  })

  it('removes links by role and kind or index', () => {
    let target = setLink(canvas({ id: 't' }), 'init', { canvasId: 'a' })
    target = { ...target, inputs: { ...target.inputs, mask: { path: '/m.png' } } }
    target = setLink(target, 'control', { canvasId: 'b' }, 'depth')
    target = { ...target, inputs: { ...target.inputs, control: { ...target.inputs!.control!, adapterId: 'ad' } } }
    target = setLink(target, 'reference', { canvasId: 'c' })
    target = setLink(target, 'reference', { canvasId: 'd' })

    const noInit = removeLink(target, 'init')
    expect(noInit.inputs?.init).toBeUndefined()
    expect(noInit.inputs?.mask).toBeUndefined()

    const noDepth = removeLink(target, 'control', 'depth')
    expect(noDepth.inputs?.control).toEqual({ adapterId: 'ad', images: [] })
    expect(removeLink(target, 'control', 0).inputs?.control?.images).toEqual([])

    expect(removeLink(target, 'reference', 0).inputs?.references?.links).toEqual([{ canvasId: 'd' }])
    expect(removeLink(target, 'reference', 7)).toBe(target)

    const bare = removeLink(setLink(canvas({ id: 't' }), 'reference', { canvasId: 'c' }), 'reference', 0)
    expect(bare.inputs).toBeUndefined()
  })

  it('drops every link to a deleted canvas and counts them', () => {
    const a = canvas({
      id: 'a',
      inputs: {
        init: { link: { canvasId: 'gone' }, strength: 0.5 },
        mask: { path: '/m.png' },
        references: { links: [{ canvasId: 'gone' }, { canvasId: 'keep' }, { canvasId: 'gone', output: 1 }] },
      },
    })
    const b = canvas({
      id: 'b',
      inputs: { control: { adapterId: 'ad', images: [{ kind: 'depth', link: { canvasId: 'gone' }, strength: 1, start: 0, end: 1 }] } },
    })
    const c = canvas({ id: 'c' })
    const { canvases, removed } = dropLinksTo([a, b, c], 'gone')
    expect(removed).toBe(4)
    expect(canvases[0].inputs).toEqual({ references: { links: [{ canvasId: 'keep' }] } })
    expect(canvases[1].inputs?.control?.images).toEqual([])
    expect(canvases[2]).toBe(c)
  })

  it('finds consumers and detects cycles', () => {
    const a = canvas({ id: 'a' })
    const b = canvas({ id: 'b', inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    const c = canvas({ id: 'c', inputs: { references: { links: [{ canvasId: 'b' }] } } })
    const all = [a, b, c]
    expect(consumersOf(all, 'a').map((item) => item.id)).toEqual(['b'])
    expect(wouldCycle(a, 'c', all)).toBe(true)
    expect(wouldCycle(c, 'a', all)).toBe(false)
  })
})

describe('studio/links input settings', () => {
  it('edits the start picture, control and references settings', async () => {
    const { patchInit, patchControl, patchControlImage, patchReferences, setControlAdapter } = await import('@renderer/pages/studio/links')
    let target = setLink(canvas({ id: 't' }), 'init', { canvasId: 'a' })
    target = patchInit(target, { strength: 0.25, resize: 'stretch' })
    expect(target.inputs?.init).toEqual({ link: { canvasId: 'a' }, strength: 0.25, resize: 'stretch' })
    expect(patchInit(target, { resize: undefined }).inputs?.init).toEqual({ link: { canvasId: 'a' }, strength: 0.25 })

    target = setControlAdapter(target, 'union')
    expect(target.inputs?.control).toEqual({ adapterId: 'union', images: [] })
    target = setLink(target, 'control', { canvasId: 'b' }, 'depth')
    target = patchControl(target, { loraStrength: 0.7 })
    expect(target.inputs?.control?.loraStrength).toBe(0.7)
    expect('loraStrength' in patchControl(target, { loraStrength: undefined }).inputs!.control!).toBe(false)
    // Moving one end of the range pushes the other.
    const late = patchControlImage(target, 'depth', { start: 0.9, strength: 1.5 })
    expect(late.inputs?.control?.images[0]).toMatchObject({ start: 0.9, end: 1, strength: 1.5 })
    const early = patchControlImage(patchControlImage(target, 'depth', { start: 0.6 }), 'depth', { end: 0.3 })
    expect(early.inputs?.control?.images[0]).toMatchObject({ start: 0.3, end: 0.3 })
    expect(patchControlImage(target, 'pose', { strength: 2 })).toBe(target)
    // No adapter turns control off, images included.
    expect(setControlAdapter(target, '').inputs?.control).toBeUndefined()
    expect(setControlAdapter(target, 'other').inputs?.control).toMatchObject({ adapterId: 'other', images: [{ kind: 'depth' }] })
    expect(setControlAdapter(setControlAdapter(canvas({ id: 'x' }), 'u'), '').inputs).toBeUndefined()

    target = setLink(target, 'reference', { canvasId: 'c' })
    target = patchReferences(target, { maxEdge: 768 })
    expect(target.inputs?.references).toEqual({ links: [{ canvasId: 'c' }], maxEdge: 768 })
  })
})

describe('studio/links frozen cards', () => {
  it('does not walk the recorded inputs of result and picture cards when looking for a loop', () => {
    const a = canvas({ id: 'a' })
    const result = canvas({ id: 'r', kind: 'result', sourceCanvasId: 'a', inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    expect(wouldCycle(a, 'r', [a, result])).toBe(false)
    const layout = canvas({ id: 'b', inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })
    expect(wouldCycle(a, 'b', [a, layout])).toBe(true)
  })

  it('leaves result cards alone when a source is deleted', () => {
    const result = canvas({ id: 'r', kind: 'result', inputs: { references: { links: [{ canvasId: 'gone' }] } } })
    const layout = canvas({ id: 'l', inputs: { references: { links: [{ canvasId: 'gone' }] } } })
    const { canvases, removed } = dropLinksTo([result, layout], 'gone')
    expect(removed).toBe(1)
    expect(canvases[0]).toBe(result)
    expect(canvases[1]!.inputs).toBeUndefined()
  })
})
