import type { ProjectCanvas } from '@shared/types'

/**
 * Board geometry. One canvas pixel maps to BOARD_UNIT board pixels, so a 512²
 * canvas covers a quarter of a 1024² one. Positions are stored on the canvas in
 * unscaled board pixels; pan and zoom only change how the board is shown.
 */

export const BOARD_UNIT = 0.25
export const BOARD_GAP = 40
/** Title row above the picture. */
export const CARD_HEADER = 28
/** Thumbnails / status row below the picture. */
export const CARD_FOOTER = 44
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3

type Sized = Pick<ProjectCanvas, 'width' | 'height'>
type Placed = Pick<ProjectCanvas, 'x' | 'y' | 'width' | 'height'>

export interface Rect { x: number; y: number; w: number; h: number }
export interface View { zoom: number; pan: { x: number; y: number } }

export function cardWidth(canvas: Sized): number {
  return Math.round(canvas.width * BOARD_UNIT)
}

export function cardBodyHeight(canvas: Sized): number {
  return Math.round(canvas.height * BOARD_UNIT)
}

export function cardHeight(canvas: Sized): number {
  return CARD_HEADER + cardBodyHeight(canvas) + CARD_FOOTER
}

export function cardRect(canvas: Placed): Rect {
  return { x: canvas.x, y: canvas.y, w: cardWidth(canvas), h: cardHeight(canvas) }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** First grid slot, reading left to right, where a card of this size fits. */
export function nextFreeSpot(canvases: readonly Placed[], size: Sized, columns = 4): { x: number; y: number } {
  const taken = canvases.map(cardRect)
  const w = cardWidth(size)
  const h = cardHeight(size)
  const slotW = cardWidth({ width: 1024, height: 1024 }) + BOARD_GAP
  const slotH = cardHeight({ width: 1024, height: 1024 }) + BOARD_GAP
  for (let row = 0; row < 500; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const candidate = { x: column * slotW, y: row * slotH, w, h }
      if (!taken.some((rect) => overlaps(candidate, rect))) return { x: candidate.x, y: candidate.y }
    }
  }
  return { x: 0, y: 0 }
}

/** A re-run lands directly under its source, shifted down while that spot is taken. */
export function resultSpot(source: Placed, canvases: readonly Placed[]): { x: number; y: number } {
  const taken = canvases.map(cardRect)
  const w = cardWidth(source)
  const h = cardHeight(source)
  let y = source.y + h + BOARD_GAP
  for (let guard = 0; guard < 500; guard += 1) {
    if (!taken.some((rect) => overlaps({ x: source.x, y, w, h }, rect))) break
    y += h + BOARD_GAP
  }
  return { x: source.x, y }
}

/** Bounding box of every card plus an optional extra rect (the new-canvas tile). */
export function boardBounds(canvases: readonly Placed[], extra?: Rect): Rect {
  const rects = canvases.map(cardRect)
  if (extra) rects.push(extra)
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 }
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.w))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** Fit a board rect into a viewport, never enlarging past 100%. */
export function fitView(viewport: { width: number; height: number }, bounds: Rect, padding: { top: number; side: number }): View {
  if (bounds.w <= 0 || bounds.h <= 0) return { zoom: 1, pan: { x: padding.side, y: padding.top } }
  const width = Math.max(1, viewport.width - padding.side * 2)
  const height = Math.max(1, viewport.height - padding.top - padding.side)
  const zoom = clampZoom(Math.min(1, width / bounds.w, height / bounds.h))
  return {
    zoom,
    pan: {
      x: padding.side + (width - bounds.w * zoom) / 2 - bounds.x * zoom,
      y: padding.top + (height - bounds.h * zoom) / 2 - bounds.y * zoom,
    },
  }
}

/** Zoom by a factor while keeping the board point under (px, py) in place. */
export function zoomAround(view: View, px: number, py: number, factor: number): View {
  const zoom = clampZoom(view.zoom * factor)
  if (zoom === view.zoom) return view
  const ratio = zoom / view.zoom
  return { zoom, pan: { x: px - (px - view.pan.x) * ratio, y: py - (py - view.pan.y) * ratio } }
}

/** Centre a board rect in the viewport at the given zoom. */
export function centerOn(viewport: { width: number; height: number }, rect: Rect, zoom: number): View {
  const z = clampZoom(zoom)
  return {
    zoom: z,
    pan: { x: viewport.width / 2 - (rect.x + rect.w / 2) * z, y: viewport.height / 2 - (rect.y + rect.h / 2) * z },
  }
}

/** Convert a pointer position inside a card's picture into canvas pixels. */
export function pointInCanvas(
  client: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  canvas: Sized,
): [number, number] {
  const x = ((client.x - rect.left) / Math.max(1, rect.width)) * canvas.width
  const y = ((client.y - rect.top) / Math.max(1, rect.height)) * canvas.height
  return [Math.round(Math.min(canvas.width, Math.max(0, x))), Math.round(Math.min(canvas.height, Math.max(0, y)))]
}
