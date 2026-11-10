import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@renderer/pages/studio/canvases'
import { canvasDescription } from '@renderer/pages/studio/prompt'
import { regionsCanvasFrom, sizeLike, untouched, withParsedRegions } from '@renderer/pages/studio/pictureRegions'
import { canvas, layer } from './fixtures'

const picture = canvas({
  id: 'p',
  kind: 'image',
  title: 'IMG_0231',
  imagePath: '/pictures/IMG_0231.jpg',
  imageSize: { width: 1200, height: 800 },
  width: 1200,
  height: 800,
})
const parsed = {
  summary: 'a cat asleep on a sunny sill',
  regions: [
    { caption: 'a sleeping cat', bbox: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } },
    { caption: 'a white mug', bbox: { x: 0.8, y: 0.6, w: 0.1, h: 0.1 } },
  ],
}

describe('拆成区域 on the board', () => {
  it('shapes the 画面 like the picture, with the pixels the settings ask for', () => {
    expect(sizeLike({ width: 1200, height: 800 }, { width: 1024, height: 1024 })).toEqual({ width: 1248, height: 832 })
    expect(sizeLike({ width: 800, height: 1200 }, { width: 1024, height: 1024 })).toEqual({ width: 832, height: 1248 })
    expect(sizeLike({ width: 500, height: 500 }, { width: 1024, height: 1024 })).toEqual({ width: 1024, height: 1024 })
  })

  it('puts an empty 画面 to the right of the picture, not wired to it, and names the file to read', () => {
    const made = regionsCanvasFrom([picture], 'p', { fallback: defaultSettings(), id: 'n' })!
    expect(made.path).toBe('/pictures/IMG_0231.jpg')
    expect(made.created).toMatchObject({ id: 'n', kind: 'layout', title: '画面 1', width: 1248, height: 832, layers: [], prompt: '' })
    expect(made.created.inputs).toBeUndefined()
    expect(made.created.x).toBeGreaterThan(picture.x)
    expect(made.canvases.map((item) => item.id)).toEqual(['p', 'n'])
    expect(untouched(made.created)).toBe(true)
  })

  it('reads the picture a result card shows, and takes its settings', () => {
    const result = canvas({ id: 'r', kind: 'result', steps: 8, outputs: [{ path: '/out/r.png', width: 1024, height: 1536, seed: 3 }] })
    const made = regionsCanvasFrom([result], 'r', { fallback: defaultSettings(), id: 'n' })!
    expect(made.path).toBe('/out/r.png')
    expect(made.created).toMatchObject({ steps: 8, width: 832, height: 1248 })
  })

  it('offers nothing for a card without a picture', () => {
    expect(regionsCanvasFrom([canvas({ id: 'empty' })], 'empty', { fallback: defaultSettings() })).toBeNull()
    expect(regionsCanvasFrom([picture], 'missing', { fallback: defaultSettings() })).toBeNull()
  })

  it('fills the 画面 with the regions in its pixels and the picture caption as its description', () => {
    const made = regionsCanvasFrom([picture], 'p', { fallback: defaultSettings(), id: 'n' })!
    const filled = withParsedRegions(made.created, parsed)
    expect(canvasDescription(filled)).toBe('a cat asleep on a sunny sill')
    expect(filled.layers.map((region) => [region.kind, region.caption, region.bbox])).toEqual([
      ['object', 'a sleeping cat', [312, 416, 936, 624]],
      ['object', 'a white mug', [998, 499, 1123, 582]],
    ])
    expect(untouched(filled)).toBe(false)
  })

  it('keeps a description typed while the picture was read, and the boxes drawn meanwhile', () => {
    const typed = canvas({
      id: 'n',
      prompt: '水彩画',
      summary: { caption: '水彩画', meta: [], canvas: 'single' },
      layers: [layer({ id: 'mine' })],
    })
    const filled = withParsedRegions(typed, parsed)
    expect(canvasDescription(filled)).toBe('水彩画')
    expect(filled.layers.map((region) => region.id)[0]).toBe('mine')
    expect(filled.layers).toHaveLength(3)
  })

  it('counts a 画面 as touched once anything was typed, drawn or generated', () => {
    expect(untouched(canvas())).toBe(true)
    expect(untouched(canvas({ prompt: '海边' }))).toBe(false)
    expect(untouched(canvas({ layers: [layer()] }))).toBe(false)
    expect(untouched(canvas({ jobId: 'j1' }))).toBe(false)
    expect(untouched(canvas({ inputs: { init: { link: { canvasId: 'p' }, strength: 0.6 } } }))).toBe(false)
  })
})
