import { describe, expect, it } from 'vitest'
import type { EngineFeatures } from '@shared/types'
import {
  clampBrush, createMask, encodeMaskPng, invertMask, isEmptyMask, maskAvailability, maskFromRgba, maskToCanvas, maskToPicture, pictureArea, placement, settleBands,
  resampleMask, stampSegment, startPictureSize, tintRgba, BRUSH_MAX, BRUSH_MIN, type MaskRaster,
} from '@renderer/pages/studio/mask'
import { canvas } from './fixtures'

const at = (mask: ReturnType<typeof createMask>, x: number, y: number) => mask.data[y * mask.width + x]

describe('studio/mask strokes', () => {
  it('stamps a round brush at a point and reports the touched area', () => {
    const mask = createMask(20, 20)
    const rect = stampSegment(mask, [10, 10], [10, 10], 6, 255)
    expect(rect).toEqual({ x: 7, y: 7, w: 7, h: 7 })
    expect(at(mask, 10, 10)).toBe(255)
    expect(at(mask, 12, 10)).toBe(255)
    expect(at(mask, 7, 7)).toBe(0) // corner of the box is outside the circle
    expect(at(mask, 15, 10)).toBe(0)
  })

  it('fills the whole segment between two pointer positions', () => {
    const mask = createMask(40, 10)
    stampSegment(mask, [2, 5], [37, 5], 4, 255)
    for (let x = 2; x < 37; x += 1) expect(at(mask, x, 5)).toBe(255)
    expect(at(mask, 5, 0)).toBe(0)
  })

  it('erases with value 0 and clips at the edges', () => {
    const mask = createMask(10, 10)
    stampSegment(mask, [0, 0], [9, 9], 30, 255)
    expect(isEmptyMask(mask)).toBe(false)
    expect(mask.data.every((value) => value === 255)).toBe(true)
    // A brush partly off the canvas only touches the part inside it.
    const rect = stampSegment(mask, [-1, -1], [-1, -1], 8, 0)
    expect(rect).toMatchObject({ x: 0, y: 0 })
    expect(at(mask, 0, 0)).toBe(0)
    expect(at(mask, 9, 9)).toBe(255)
    expect(stampSegment(mask, [-100, -100], [-90, -90], 4, 0)).toBeNull()
  })

  it('inverts and clears', () => {
    const mask = createMask(4, 1)
    mask.data.set([255, 0, 255, 0])
    expect([...invertMask(mask).data]).toEqual([0, 255, 0, 255])
    expect([...mask.data]).toEqual([255, 0, 255, 0])
    expect(isEmptyMask(createMask(3, 3))).toBe(true)
  })

  it('keeps brush sizes in range', () => {
    expect(clampBrush(1)).toBe(BRUSH_MIN)
    expect(clampBrush(9999)).toBe(BRUSH_MAX)
    expect(clampBrush(33.4)).toBe(33)
  })
})

describe('studio/mask pixels', () => {
  it('reads a saved mask back: bright and opaque is repaint', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 200, 200, 200, 0, 140, 140, 140, 255])
    expect([...maskFromRgba(rgba, 4, 1).data]).toEqual([255, 0, 0, 255])
  })

  it('tints only the painted pixels of the dirty area', () => {
    const mask = createMask(2, 2)
    mask.data.set([255, 0, 0, 255])
    const rgba = new Uint8ClampedArray(16)
    tintRgba(mask, rgba, [10, 20, 30], 0.5, { x: 0, y: 0, w: 2, h: 1 })
    expect([...rgba.slice(0, 8)]).toEqual([10, 20, 30, 128, 10, 20, 30, 0])
    expect([...rgba.slice(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('encodes a canvas-sized 8-bit greyscale PNG, white = repaint', async () => {
    const mask = createMask(3, 2)
    mask.data.set([255, 0, 0, 0, 255, 255])
    const png = await encodeMaskPng(mask)
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    const text = (start: number, end: number) => String.fromCharCode(...png.subarray(start, end))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(text(12, 16)).toBe('IHDR')
    expect(view.getUint32(16)).toBe(3)
    expect(view.getUint32(20)).toBe(2)
    expect(png[24]).toBe(8) // bit depth
    expect(png[25]).toBe(0) // greyscale
    const idatLength = view.getUint32(33)
    expect(text(37, 41)).toBe('IDAT')
    const inflated = new Blob([png.slice(41, 41 + idatLength)]).stream().pipeThrough(new DecompressionStream('deflate'))
    const raw = new Uint8Array(await new Response(inflated).arrayBuffer())
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 0, 255, 255])
    expect(text(png.length - 8, png.length - 4)).toBe('IEND')
  })
})

describe('studio/mask availability', () => {
  const features = (patch: Partial<EngineFeatures> = {}): EngineFeatures => ({
    preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true, lora: true, values: {}, ...patch,
  })
  const withInit = canvas({ inputs: { init: { link: { canvasId: 'a' }, strength: 0.6 } } })

  it('is on for a layout canvas with a start picture', () => {
    expect(maskAvailability(withInit, features())).toEqual({ hidden: false, enabled: true })
  })

  it('is hidden when the engine cannot take pictures, and off with a reason otherwise', () => {
    expect(maskAvailability(withInit, features({ imageInput: false }))).toMatchObject({ hidden: true, enabled: false })
    expect(maskAvailability(withInit, null)).toMatchObject({ hidden: false, enabled: false, reason: '没有可用的引擎，暂时不能画遮罩' })
    expect(maskAvailability(canvas(), features())).toMatchObject({ enabled: false, reason: '先给画面连一张起始图，再画遮罩' })
    expect(maskAvailability(canvas({ kind: 'image' }), features())).toMatchObject({ enabled: false, reason: '先选中一个可编辑的画面' })
    expect(maskAvailability(null, features())).toMatchObject({ enabled: false })
    expect(maskAvailability(withInit, undefined)).toMatchObject({ enabled: false })
  })
})

describe('studio/mask start-picture space', () => {
  const filled = (width: number, height: number, paint: (x: number, y: number) => boolean): MaskRaster => {
    const mask = createMask(width, height)
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (paint(x, y)) mask.data[y * width + x] = 255
    return mask
  }
  const px = (mask: MaskRaster, x: number, y: number) => mask.data[y * mask.width + x]
  const wide = { width: 400, height: 200 }
  const square = { width: 100, height: 100 }

  it('places the picture like the engine: cover, contain or plain scale', () => {
    expect(placement(wide, square, 'crop')).toMatchObject({ sx: 0.5, sy: 0.5, ox: -50, oy: 0, bands: null })
    expect(placement(wide, square, 'fit')).toMatchObject({ sx: 0.25, sy: 0.25, ox: 0, oy: 25, bands: 'rows', fill: 25 })
    expect(placement(wide, square, 'stretch')).toMatchObject({ sx: 0.25, sy: 0.5, ox: 0, oy: 0, bands: null })
  })

  it('crop: saves at the picture size; what the crop hides keeps the earlier mask or is kept', () => {
    const out = maskToPicture(filled(100, 100, () => true), wide, 'crop')
    expect([out.width, out.height]).toEqual([400, 200])
    expect([px(out, 0, 0), px(out, 99, 100), px(out, 100, 0), px(out, 299, 199), px(out, 300, 50), px(out, 399, 199)]).toEqual([0, 0, 255, 255, 0, 0])
    const earlier = filled(400, 200, (x) => x < 20)
    const merged = maskToPicture(filled(100, 100, () => false), wide, 'crop', earlier)
    expect([px(merged, 10, 10), px(merged, 30, 10), px(merged, 150, 10)]).toEqual([255, 0, 0])
  })

  it('fit: every picture pixel is on the canvas; painted bands count for nothing', () => {
    const all = maskToPicture(filled(100, 100, () => true), wide, 'fit')
    expect(isEmptyMask(invertMask(all))).toBe(true)
    // Only the band above the picture is painted: nothing of the picture is.
    expect(isEmptyMask(maskToPicture(filled(100, 100, (_x, y) => y < 25), wide, 'fit'))).toBe(true)
    const top = maskToPicture(filled(100, 100, (_x, y) => y < 50), wide, 'fit')
    expect([px(top, 200, 0), px(top, 200, 99), px(top, 200, 100), px(top, 200, 199)]).toEqual([255, 255, 0, 0])
  })

  it('stretch: a plain scale on each axis', () => {
    const left = maskToPicture(filled(100, 100, (x) => x < 50), wide, 'stretch')
    expect([px(left, 0, 0), px(left, 199, 199), px(left, 200, 0), px(left, 399, 199)]).toEqual([255, 255, 0, 0])
  })

  for (const mode of ['crop', 'fit', 'stretch'] as const) {
    it(`${mode}: canvas → picture → canvas gives back the strokes over the picture (non-square, larger picture)`, () => {
      const canvas = { width: 120, height: 90 }
      const picture = { width: 300, height: 640 }
      const strokes = filled(120, 90, (x, y) => (x * 7 + y * 3) % 11 < 4)
      const back = maskToCanvas(maskToPicture(strokes, picture, mode), canvas, mode)
      const area = pictureArea(placement(picture, canvas, mode), canvas)
      for (let y = area.y; y < area.y + area.h; y += 1) {
        for (let x = area.x; x < area.x + area.w; x += 1) expect(px(back, x, y), `${x},${y}`).toBe(px(strokes, x, y))
      }
    })
  }

  it('crop with a very different aspect ratio only touches the visible strip', () => {
    const picture = { width: 1600, height: 100 }
    const out = maskToPicture(filled(512, 512, () => true), picture, 'crop')
    // Cover scale 5.12: 8192 × 512, centred, so picture columns 750–849 are visible.
    expect([px(out, 749, 50), px(out, 750, 50), px(out, 849, 50), px(out, 850, 50)]).toEqual([0, 255, 255, 0])
  })

  it('rescales a saved mask when the start picture changes size', () => {
    const mask = filled(4, 2, (x) => x < 2)
    expect(resampleMask(mask, 4, 2)).toBe(mask)
    const bigger = resampleMask(mask, 8, 4)
    expect([bigger.width, bigger.height, px(bigger, 3, 3), px(bigger, 4, 0)]).toEqual([8, 4, 255, 0])
  })

  it('knows the start picture size from an imported picture or a recorded output', () => {
    const image = canvas({ id: 'img', kind: 'image', imagePath: '/p.png', imageSize: { width: 1600, height: 1200 } })
    const result = canvas({ id: 'res', kind: 'result', outputs: [{ path: '/o/0.png', width: 832, height: 1216, seed: 1 }, { path: '/o/1.png', width: 640, height: 640, seed: 2 }] })
    const target = (link: { canvasId: string; output?: number }) => canvas({ id: 't', inputs: { init: { link, strength: 0.6 } } })
    const all = [image, result]
    expect(startPictureSize(target({ canvasId: 'img' }), all)).toEqual({ width: 1600, height: 1200 })
    expect(startPictureSize(target({ canvasId: 'res', output: 1 }), all)).toEqual({ width: 640, height: 640 })
    expect(startPictureSize(target({ canvasId: 'res' }), all)).toEqual({ width: 832, height: 1216 })
    expect(startPictureSize(target({ canvasId: 'gone' }), all)).toBeNull()
    expect(startPictureSize(canvas(), all)).toBeNull()
    expect(startPictureSize(target({ canvasId: 'img' }), [{ ...image, imageSize: undefined }])).toBeNull()
  })
})

describe('studio/mask matches the engine resize_to', () => {
  /** pipeline_image.cpp resize_to, transcribed with integer (BigInt) arithmetic. */
  function engine(iw: number, ih: number, W: number, H: number, mode: 'crop' | 'fit') {
    const ratio = W / H
    const srcRatio = iw / ih
    const floordiv = (a: number, b: number) => Number(BigInt(a) / BigInt(b))
    const intHalf = (v: number) => Number(BigInt(v) / 2n)
    const w = mode === 'crop' ? (ratio > srcRatio ? W : floordiv(iw * H, ih)) : (ratio < srcRatio ? W : floordiv(iw * H, ih))
    const h = mode === 'crop' ? (ratio <= srcRatio ? H : floordiv(ih * W, iw)) : (ratio >= srcRatio ? H : floordiv(ih * W, iw))
    const ox = intHalf(W) - intHalf(w)
    const oy = intHalf(H) - intHalf(h)
    const rowsFill = mode === 'fit' && ratio < srcRatio ? intHalf(H) - intHalf(h) : 0
    const columnsFill = mode === 'fit' && ratio > srcRatio ? intHalf(W) - intHalf(w) : 0
    return { w, h, ox, oy, rowsFill, columnsFill }
  }

  const cases: Array<[number, number, number, number]> = [
    [333, 517, 1000, 768], [1001, 999, 512, 513], [7, 3, 5, 9], [3, 7, 10, 10], [1920, 1080, 1023, 1025],
    [640, 480, 1024, 768], [1, 1000, 999, 1], [4097, 15, 64, 2048], [517, 333, 9, 1001],
  ]
  for (const [iw, ih, W, H] of cases) {
    for (const mode of ['crop', 'fit'] as const) {
      it(`${mode} ${iw}×${ih} → ${W}×${H}: same size, offset and bands as the engine`, () => {
        const want = engine(iw, ih, W, H, mode)
        const got = placement({ width: iw, height: ih }, { width: W, height: H }, mode)
        expect({ w: got.w, h: got.h, ox: got.ox, oy: got.oy }).toEqual({ w: want.w, h: want.h, ox: want.ox, oy: want.oy })
        expect(got.sx).toBeCloseTo(want.w / iw, 12)
        expect(got.sy).toBeCloseTo(want.h / ih, 12)
        const fill = want.rowsFill > 0 ? { bands: 'rows', fill: want.rowsFill } : want.columnsFill > 0 ? { bands: 'columns', fill: want.columnsFill } : { bands: null, fill: 0 }
        expect({ bands: got.bands, fill: got.fill }).toEqual(fill)
      })
    }
  }

  it('fit with rows: bands repeat the picture\'s first and last row; an odd leftover row stays 0', () => {
    // 4×2 into 9×9: picture 9×4 at y 2–5, bands rows 0–1 and 6–7, row 8 is left blank by the engine.
    const place = placement({ width: 4, height: 2 }, { width: 9, height: 9 }, 'fit')
    expect(place).toMatchObject({ w: 9, h: 4, ox: 0, oy: 2, bands: 'rows', fill: 2 })
    const picture = createMask(4, 2)
    picture.data.set([255, 0, 0, 255, 0, 255, 255, 0])
    const shown = maskToCanvas(picture, { width: 9, height: 9 }, 'fit')
    const row = (y: number) => [...shown.data.subarray(y * 9, y * 9 + 9)]
    expect(row(0)).toEqual(row(2))
    expect(row(1)).toEqual(row(2))
    expect(row(6)).toEqual(row(5))
    expect(row(7)).toEqual(row(5))
    expect(row(8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(row(2)).not.toEqual(row(5))
  })

  it('fit with columns: bands repeat the first and last column', () => {
    // 2×5 into 11×6: picture 2×6 at x 4–5 (11/2 − 2/2 = 4), bands columns 0–3 and 6–9, column 10 blank.
    const place = placement({ width: 2, height: 5 }, { width: 11, height: 6 }, 'fit')
    expect(place).toMatchObject({ w: 2, h: 6, ox: 4, oy: 0, bands: 'columns', fill: 4 })
    const mask = createMask(11, 6)
    for (let y = 0; y < 6; y += 1) { mask.data[y * 11 + 4] = y % 2 ? 255 : 0; mask.data[y * 11 + 5] = 255; mask.data[y * 11 + 10] = 255 }
    settleBands(mask, place)
    for (let y = 0; y < 6; y += 1) {
      const line = [...mask.data.subarray(y * 11, y * 11 + 11)]
      const lead = y % 2 ? 255 : 0
      expect(line).toEqual([lead, lead, lead, lead, lead, 255, 255, 255, 255, 255, 0])
    }
  })

  it('clips strokes to the picture in fit mode', () => {
    const canvas = { width: 100, height: 100 }
    const place = placement({ width: 400, height: 200 }, canvas, 'fit')
    const area = pictureArea(place, canvas)
    expect(area).toEqual({ x: 0, y: 25, w: 100, h: 50 })
    const mask = createMask(100, 100)
    expect(stampSegment(mask, [50, 5], [60, 5], 10, 255, area)).toBeNull()
    expect(stampSegment(mask, [50, 24], [50, 24], 10, 255, area)).toMatchObject({ y: 25 })
    expect(mask.data[20 * 100 + 50]).toBe(0)
    expect(mask.data[26 * 100 + 50]).toBe(255)
  })
})
