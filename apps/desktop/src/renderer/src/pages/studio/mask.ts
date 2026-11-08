/**
 * Mask painting, pure raster helpers. A mask is one byte per canvas pixel:
 * 255 = repaint (white in the saved PNG), 0 = keep. Strokes are stamped as
 * round brushes along each pointer segment.
 */

import type { EngineFeatures, ImageResizeMode, ProjectCanvas } from '@shared/types'
import { linkSourceCanvas } from './links'
import { engineUnavailableReason, type Blocker } from './readiness'

/**
 * Whether the 遮罩 tool shows for the selected canvas, and why it is off.
 * `blockers` (the readiness of the 生成 footer) words the reason when no engine is usable.
 */
export function maskAvailability(
  canvas: Pick<ProjectCanvas, 'kind' | 'inputs' | 'upscale'> | null,
  features: EngineFeatures | null | undefined,
  blockers: readonly Blocker[] = [],
): { hidden: boolean; enabled: boolean; reason?: string } {
  if (!features) return { hidden: false, enabled: false, reason: engineUnavailableReason(features, blockers, '画遮罩') ?? undefined }
  if (!features.imageInput) return { hidden: true, enabled: false }
  if (!canvas || canvas.kind !== 'layout') return { hidden: false, enabled: false, reason: '先选中一个可编辑的画面' }
  // A 放大 redraws the whole 原图: no mask.
  if (canvas.upscale) return { hidden: true, enabled: false }
  if (!canvas.inputs?.init) return { hidden: false, enabled: false, reason: '先给画面连一张起始图，再画遮罩' }
  return { hidden: false, enabled: true }
}

export interface MaskRaster {
  width: number
  height: number
  data: Uint8Array
}

export interface DirtyRect {
  x: number
  y: number
  w: number
  h: number
}

export const BRUSH_MIN = 4
export const BRUSH_MAX = 400
export const BRUSH_DEFAULT = 64

export function createMask(width: number, height: number): MaskRaster {
  return { width, height, data: new Uint8Array(Math.max(0, width * height)) }
}

export function clampBrush(size: number): number {
  return Math.round(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, size)))
}

/**
 * Stamp a round brush of `diameter` along the segment from → to (canvas
 * pixels), writing `value` (255 paint, 0 erase). Returns the touched area, or
 * null when nothing inside the mask was touched.
 */
export function stampSegment(
  mask: MaskRaster,
  from: [number, number],
  to: [number, number],
  diameter: number,
  value: 0 | 255,
  /** Only pixels inside this area are touched (the start picture, in fit mode). */
  clip?: DirtyRect,
): DirtyRect | null {
  const radius = Math.max(0.5, diameter / 2)
  const area = clip ?? { x: 0, y: 0, w: mask.width, h: mask.height }
  const left = Math.max(0, area.x, Math.floor(Math.min(from[0], to[0]) - radius))
  const top = Math.max(0, area.y, Math.floor(Math.min(from[1], to[1]) - radius))
  const right = Math.min(mask.width - 1, area.x + area.w - 1, Math.ceil(Math.max(from[0], to[0]) + radius))
  const bottom = Math.min(mask.height - 1, area.y + area.h - 1, Math.ceil(Math.max(from[1], to[1]) + radius))
  if (right < left || bottom < top) return null
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length2 = dx * dx + dy * dy
  const r2 = radius * radius
  for (let y = top; y <= bottom; y += 1) {
    const py = y + 0.5
    for (let x = left; x <= right; x += 1) {
      const px = x + 0.5
      // Distance from the pixel centre to the segment.
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - from[0]) * dx + (py - from[1]) * dy) / length2))
      const cx = from[0] + t * dx - px
      const cy = from[1] + t * dy - py
      if (cx * cx + cy * cy <= r2) mask.data[y * mask.width + x] = value
    }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}

export function invertMask(mask: MaskRaster): MaskRaster {
  const data = new Uint8Array(mask.data.length)
  for (let index = 0; index < data.length; index += 1) data[index] = mask.data[index] ? 0 : 255
  return { ...mask, data }
}

export function isEmptyMask(mask: MaskRaster): boolean {
  for (let index = 0; index < mask.data.length; index += 1) if (mask.data[index]) return false
  return true
}

/** Read a mask back from decoded RGBA pixels (a saved PNG): bright = repaint. */
export function maskFromRgba(rgba: ArrayLike<number>, width: number, height: number): MaskRaster {
  const mask = createMask(width, height)
  for (let index = 0; index < mask.data.length; index += 1) {
    const o = index * 4
    const luma = (rgba[o]! * 299 + rgba[o + 1]! * 587 + rgba[o + 2]! * 114) / 1000
    mask.data[index] = luma >= 128 && (rgba[o + 3] ?? 255) >= 128 ? 255 : 0
  }
  return mask
}

/** Colour the painted part of `rect` into an RGBA buffer for display (a tint, transparent elsewhere). */
export function tintRgba(
  mask: MaskRaster,
  rgba: Uint8ClampedArray,
  color: [number, number, number],
  alpha: number,
  rect?: DirtyRect,
): void {
  const area = rect ?? { x: 0, y: 0, w: mask.width, h: mask.height }
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  for (let y = area.y; y < area.y + area.h; y += 1) {
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const index = y * mask.width + x
      const o = index * 4
      const on = mask.data[index] !== 0
      rgba[o] = color[0]
      rgba[o + 1] = color[1]
      rgba[o + 2] = color[2]
      rgba[o + 3] = on ? a : 0
    }
  }
}

/* ------------------------------------------------------------------ */
/* PNG (8-bit greyscale)                                               */
/* ------------------------------------------------------------------ */

let crcTable: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Encode the mask as an 8-bit greyscale PNG of the canvas size (white = repaint). */
export async function encodeMaskPng(mask: MaskRaster): Promise<Uint8Array> {
  const { width, height } = mask
  const raw = new Uint8Array((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // Filter byte 0 (none), then the row.
    raw.set(mask.data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 0 // greyscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Start-picture space                                                 */
/* ------------------------------------------------------------------ */

/**
 * The engine wants the mask at the start picture's own pixel size, and maps
 * it onto the generation exactly like the picture (`resize`): crop = cover
 * and centre-crop, fit = contain and centre, stretch = plain scale. Painting
 * happens in canvas space, so these convert between the two.
 */

export interface Size {
  width: number
  height: number
}
export type ResizeMode = ImageResizeMode

/**
 * The pixel size of a canvas's start picture, when it is known without
 * opening the file: an imported picture's `imageSize`, or a generated output's
 * recorded size. Null when there is no start picture or its size is unknown.
 */
export function startPictureSize(canvas: Pick<ProjectCanvas, 'inputs'>, canvases: readonly ProjectCanvas[]): Size | null {
  const link = canvas.inputs?.init?.link
  const source = link ? linkSourceCanvas(link, canvases) : undefined
  if (!link || !source) return null
  if (source.kind === 'image') return source.imagePath && source.imageSize ? { ...source.imageSize } : null
  const outputs = source.outputs ?? []
  const output = outputs[link.output ?? 0] ?? outputs[0]
  return output && output.width > 0 && output.height > 0 ? { width: output.width, height: output.height } : null
}

/**
 * Where the start picture lands on the canvas, exactly as the engine's
 * `resize_to` (pipeline_image.cpp) puts it: the picture is resized to w × h
 * (integer, floored) and pasted at (ox, oy) = (W/2 − w/2, H/2 − h/2) with
 * integer division. In fit mode the empty bands (`bands`, `fill` pixels thick)
 * repeat the picture's first and last row or column.
 */
export interface Placement {
  w: number
  h: number
  ox: number
  oy: number
  /** Canvas pixels per picture pixel. */
  sx: number
  sy: number
  bands: 'rows' | 'columns' | null
  fill: number
}

const half = (value: number): number => Math.trunc(value / 2)

export function placement(picture: Size, canvas: Size, mode: ResizeMode = 'crop'): Placement {
  const W = canvas.width
  const H = canvas.height
  const iw = Math.max(1, picture.width)
  const ih = Math.max(1, picture.height)
  if (mode === 'stretch') return { w: W, h: H, ox: 0, oy: 0, sx: W / iw, sy: H / ih, bands: null, fill: 0 }
  const ratio = W / H
  const srcRatio = iw / ih
  const crop = mode === 'crop'
  // _resize_and_crop / _resize_and_fill
  const w = (crop ? ratio > srcRatio : ratio < srcRatio) ? W : Math.floor((iw * H) / ih)
  const h = (crop ? ratio <= srcRatio : ratio >= srcRatio) ? H : Math.floor((ih * W) / iw)
  const ox = half(W) - half(w)
  const oy = half(H) - half(h)
  let bands: Placement['bands'] = null
  let fill = 0
  if (!crop && ratio < srcRatio && oy > 0) {
    bands = 'rows'
    fill = oy
  } else if (!crop && ratio > srcRatio && ox > 0) {
    bands = 'columns'
    fill = ox
  }
  return { w, h, ox, oy, sx: w / iw, sy: h / ih, bands, fill }
}

/** The part of the canvas the start picture itself covers (strokes outside it cannot be saved). */
export function pictureArea(place: Placement, canvas: Size): DirtyRect {
  const x = Math.max(0, place.ox)
  const y = Math.max(0, place.oy)
  return {
    x,
    y,
    w: Math.max(0, Math.min(canvas.width, place.ox + place.w) - x),
    h: Math.max(0, Math.min(canvas.height, place.oy + place.h) - y),
  }
}

/**
 * Make a canvas-space mask what the engine will see: nothing outside the
 * picture, and in fit mode each band a copy of the picture's edge row or
 * column (the engine stretches the resized mask's edge the same way). Rows or
 * columns past the bands (an odd leftover pixel) stay 0, as in the engine.
 * Returns the band areas it rewrote.
 */
export function settleBands(mask: MaskRaster, place: Placement): DirtyRect[] {
  const area = pictureArea(place, mask)
  const { width, height, data } = mask
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < area.x || x >= area.x + area.w || y < area.y || y >= area.y + area.h) data[y * width + x] = 0
    }
  }
  if (!place.bands || !area.w || !area.h) return []
  if (place.bands === 'rows') {
    const first = area.y
    const last = area.y + area.h - 1
    const bottom = Math.min(height, last + 1 + place.fill)
    for (let y = 0; y < first; y += 1) data.copyWithin(y * width, first * width, (first + 1) * width)
    for (let y = last + 1; y < bottom; y += 1) data.copyWithin(y * width, last * width, (last + 1) * width)
    return [
      { x: 0, y: 0, w: width, h: first },
      { x: 0, y: last + 1, w: width, h: height - last - 1 },
    ]
  }
  const first = area.x
  const last = area.x + area.w - 1
  const right = Math.min(width, last + 1 + place.fill)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    const lead = data[row + first]!
    const tail = data[row + last]!
    for (let x = 0; x < first; x += 1) data[row + x] = lead
    for (let x = last + 1; x < right; x += 1) data[row + x] = tail
  }
  return [
    { x: 0, y: 0, w: first, h: height },
    { x: last + 1, y: 0, w: width - last - 1, h: height },
  ]
}

/**
 * A mask painted on the canvas, as the start picture's pixels. Picture pixels
 * the canvas does not show (cropped away) keep their value in `base` (a mask
 * saved earlier) or are kept (0). Band pixels never count: they are derived.
 */
export function maskToPicture(mask: MaskRaster, picture: Size, mode: ResizeMode = 'crop', base?: MaskRaster | null): MaskRaster {
  const out = createMask(picture.width, picture.height)
  const { sx, sy, ox, oy } = placement(picture, mask, mode)
  const keep = base && base.width === picture.width && base.height === picture.height ? base.data : null
  const columns = new Int32Array(picture.width)
  for (let x = 0; x < picture.width; x += 1) {
    const cx = Math.floor((x + 0.5) * sx + ox)
    columns[x] = cx >= 0 && cx < mask.width ? cx : -1
  }
  for (let y = 0; y < picture.height; y += 1) {
    const cy = Math.floor((y + 0.5) * sy + oy)
    const row = y * picture.width
    for (let x = 0; x < picture.width; x += 1) {
      const cx = columns[x]!
      out.data[row + x] = cy >= 0 && cy < mask.height && cx >= 0 ? mask.data[cy * mask.width + cx]! : keep ? keep[row + x]! : 0
    }
  }
  return out
}

/** A mask saved at the start picture's size, as canvas pixels, bands included. */
export function maskToCanvas(mask: MaskRaster, canvas: Size, mode: ResizeMode = 'crop'): MaskRaster {
  const out = createMask(canvas.width, canvas.height)
  const place = placement(mask, canvas, mode)
  const area = pictureArea(place, canvas)
  for (let y = area.y; y < area.y + area.h; y += 1) {
    const py = Math.min(mask.height - 1, Math.max(0, Math.floor((y + 0.5 - place.oy) / place.sy)))
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const px = Math.min(mask.width - 1, Math.max(0, Math.floor((x + 0.5 - place.ox) / place.sx)))
      out.data[y * canvas.width + x] = mask.data[py * mask.width + px]!
    }
  }
  settleBands(out, place)
  return out
}

/** Nearest-neighbour rescale, for a saved mask whose start picture changed size. */
export function resampleMask(mask: MaskRaster, width: number, height: number): MaskRaster {
  if (mask.width === width && mask.height === height) return mask
  return maskToPicture(mask, { width, height }, 'stretch')
}
