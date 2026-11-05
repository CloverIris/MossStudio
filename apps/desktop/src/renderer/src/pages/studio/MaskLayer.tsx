import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { cn } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'
import { pointInCanvas } from './boardLayout'
import {
  createMask, encodeMaskPng, invertMask, isEmptyMask, maskFromRgba, maskToCanvas, maskToPicture, pictureArea, placement, resampleMask, settleBands,
  stampSegment, tintRgba,
  type DirtyRect, type MaskRaster, type ResizeMode, type Size,
} from './mask'

export type MaskMode = 'paint' | 'erase'
export interface MaskBrush { mode: MaskMode; size: number }
/** A one-off command from the toolbar; `n` changes on every press. */
export interface MaskCommand { type: 'clear' | 'invert'; n: number }

const SAVE_DELAY_MS = 600
const TINT_ALPHA = 0.55

/** The accent token as RGB, read through the canvas so any CSS colour syntax works. */
function resolveColor(element: HTMLElement): [number, number, number] {
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (!context) return [0, 0, 0]
  context.fillStyle = getComputedStyle(element).color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [r ?? 0, g ?? 0, b ?? 0]
}

/**
 * Read a saved mask back. The picture comes from the clover: scheme, so it is
 * loaded in CORS mode (an untainted canvas); without the scheme's CORS header
 * it fails to load and the mask starts empty.
 */
async function loadMask(path: string): Promise<MaskRaster | null> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = cloverUrl(path)
  try {
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0)
    return maskFromRgba(context.getImageData(0, 0, width, height).data, width, height)
  } catch {
    return null
  }
}

/** The natural pixel size of a picture, read once per path; `known` skips the read. */
export function usePictureSize(path: string | undefined, known: Size | null): Size | null {
  const [read, setRead] = useState<{ path: string; size: Size } | null>(null)
  useEffect(() => {
    if (!path || known) return
    let alive = true
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = cloverUrl(path)
    image.decode()
      .then(() => { if (alive && image.naturalWidth && image.naturalHeight) setRead({ path, size: { width: image.naturalWidth, height: image.naturalHeight } }) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [path, known])
  if (known) return known
  return read && read.path === path ? read.size : null
}

interface Basis { canvas: Size; picture: Size; mode: ResizeMode }

/**
 * The repaint mask of a layout canvas, shown as an accent tint over its start
 * picture. While `interactive` (the 遮罩 tool), strokes paint or erase; the
 * mask is saved shortly after each stroke and when painting ends.
 */
export function MaskLayer({
  canvas,
  interactive,
  picture,
  mode = 'crop',
  brush,
  command,
  onSave,
}: {
  canvas: Pick<ProjectCanvas, 'id' | 'width' | 'height' | 'inputs'>
  /** The start picture's pixel size: the size the mask is saved at. */
  picture: Size
  /** How the start picture fits the canvas (its `resize`). */
  mode?: ResizeMode
  interactive: boolean
  brush: MaskBrush
  command?: MaskCommand
  /** A PNG to store as the mask, or null when nothing is painted. */
  onSave: (png: Uint8Array | null) => void
}): React.JSX.Element {
  const element = useRef<HTMLCanvasElement>(null)
  /** What is painted, in canvas pixels (what the strokes draw into). */
  const raster = useRef<MaskRaster>(createMask(canvas.width, canvas.height))
  /** The canvas geometry and start picture `raster` was made for. */
  const basis = useRef<Basis>({ canvas: { width: canvas.width, height: canvas.height }, picture, mode })
  /** The mask as last saved or loaded, at the start picture's size: keeps what the canvas crops away. */
  const saved = useRef<MaskRaster | null>(null)
  const pixels = useRef<ImageData | null>(null)
  const color = useRef<[number, number, number]>([0, 0, 0])
  const stroke = useRef<{ pointerId: number; last: [number, number] } | null>(null)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bumped when the mask is cleared from outside, so a save still being encoded is dropped. */
  const generation = useRef(0)
  const [cursor, setCursor] = useState<{ x: number; y: number; d: number } | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const draw = useCallback((rect?: DirtyRect) => {
    const context = element.current?.getContext('2d')
    if (!context) return
    const mask = raster.current
    if (!pixels.current || pixels.current.width !== mask.width || pixels.current.height !== mask.height) {
      pixels.current = context.createImageData(mask.width, mask.height)
      rect = undefined
    }
    tintRgba(mask, pixels.current.data, color.current, TINT_ALPHA, rect)
    if (rect) context.putImageData(pixels.current, 0, 0, rect.x, rect.y, rect.w, rect.h)
    else context.putImageData(pixels.current, 0, 0)
  }, [])

  /** The painted raster as start-picture pixels, for the basis it was painted on. */
  const toPicture = useCallback((): MaskRaster => {
    const { picture: size, mode: fit } = basis.current
    return maskToPicture(raster.current, size, fit, saved.current)
  }, [])

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current) return
    dirty.current = false
    const mask = toPicture()
    saved.current = mask
    if (isEmptyMask(mask)) {
      onSaveRef.current(null)
      return
    }
    const sentIn = generation.current
    void encodeMaskPng(mask).then((png) => { if (generation.current === sentIn) onSaveRef.current(png) })
  }, [toPicture])

  const changed = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }, [flush])

  // Keep the raster in step with the canvas size, the start picture, its fit
  // and the saved mask. Unsaved strokes are carried over through picture space.
  const maskPath = canvas.inputs?.mask?.path
  const previousPath = useRef(maskPath)
  useEffect(() => {
    if (element.current) color.current = resolveColor(element.current)
    const next: Basis = { canvas: { width: canvas.width, height: canvas.height }, picture, mode }
    const cleared = previousPath.current !== undefined && maskPath === undefined
    previousPath.current = maskPath
    if (cleared) {
      // 清除 in the inspector, or the start picture was replaced: nothing painted any more.
      generation.current += 1
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      dirty.current = false
      saved.current = null
    } else if (dirty.current) {
      saved.current = toPicture()
    }
    basis.current = next
    raster.current = saved.current && !cleared ? maskToCanvas(resampleMask(saved.current, picture.width, picture.height), next.canvas, mode) : createMask(canvas.width, canvas.height)
    draw()
    // Read the saved file only when this layer has no mask of its own yet: after
    // its own saves, what it holds is already what the file says.
    if (!maskPath || dirty.current || saved.current) return
    let alive = true
    void loadMask(maskPath).then((loaded) => {
      if (!alive || !loaded || dirty.current) return
      // A start picture that changed size gets its mask rescaled and saved again.
      const fitted = resampleMask(loaded, picture.width, picture.height)
      saved.current = fitted
      raster.current = maskToCanvas(fitted, next.canvas, mode)
      draw()
      if (fitted !== loaded) changed()
    })
    return () => { alive = false }
  }, [canvas.id, canvas.width, canvas.height, picture.width, picture.height, mode, maskPath, draw, toPicture, changed])

  // Save right away when painting ends or the card goes away.
  useEffect(() => {
    if (!interactive) flush()
  }, [interactive, flush])
  useEffect(() => () => flush(), [flush])

  // Toolbar commands.
  const lastCommand = useRef(command?.n)
  useEffect(() => {
    if (!command || command.n === lastCommand.current) return
    lastCommand.current = command.n
    if (!interactive) return
    if (command.type === 'clear') {
      raster.current = createMask(canvas.width, canvas.height)
      saved.current = null
    } else {
      raster.current = invertMask(raster.current)
      // Only the picture inverts; the bands follow its edges.
      const { picture: size, mode: fit, canvas: area } = basis.current
      settleBands(raster.current, placement(size, area, fit))
    }
    draw()
    changed()
  }, [command, interactive, canvas.width, canvas.height, draw, changed])

  const at = (event: React.PointerEvent): [number, number] => {
    const rect = element.current!.getBoundingClientRect()
    const [x, y] = pointInCanvas({ x: event.clientX, y: event.clientY }, rect, canvas)
    return [x, y]
  }

  const paint = (from: [number, number], to: [number, number]): void => {
    const { picture: size, mode: fit, canvas: area } = basis.current
    const place = placement(size, area, fit)
    const inside = pictureArea(place, area)
    // Strokes stay on the picture: the bands of fit mode are not the picture's own pixels.
    const rect = stampSegment(raster.current, from, to, brush.size, brush.mode === 'paint' ? 255 : 0, inside)
    if (!rect) return
    draw(rect)
    // A stroke along the picture's edge changes the band stretched from it.
    const edge = place.bands === 'rows'
      ? rect.y === inside.y || rect.y + rect.h === inside.y + inside.h
      : place.bands === 'columns' ? rect.x === inside.x || rect.x + rect.w === inside.x + inside.w : false
    if (edge) for (const band of settleBands(raster.current, place)) if (band.w > 0 && band.h > 0) draw(band)
  }

  const showCursor = (event: React.PointerEvent): void => {
    const rect = element.current!.getBoundingClientRect()
    const scale = rect.width / Math.max(1, canvas.width)
    // Screen size of the brush, in the card's own (unzoomed) pixels.
    const local = element.current!.offsetWidth / Math.max(1, rect.width)
    setCursor({ x: (event.clientX - rect.left) * local, y: (event.clientY - rect.top) * local, d: brush.size * scale * local })
  }

  return (
    <div
      data-mask-layer
      className={cn('absolute inset-0', interactive ? 'z-[3] cursor-none touch-none' : 'pointer-events-none')}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return
        event.stopPropagation()
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        // The theme may have changed since the tint was drawn.
        const tint = resolveColor(element.current!)
        if (tint.some((value, index) => value !== color.current[index])) {
          color.current = tint
          draw()
        }
        const point = at(event)
        stroke.current = { pointerId: event.pointerId, last: point }
        paint(point, point)
      }}
      onPointerMove={(event) => {
        if (!interactive) return
        showCursor(event)
        const current = stroke.current
        if (!current || current.pointerId !== event.pointerId) return
        const point = at(event)
        paint(current.last, point)
        current.last = point
      }}
      onPointerUp={(event) => {
        const current = stroke.current
        if (!current || current.pointerId !== event.pointerId) return
        stroke.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        changed()
      }}
      onPointerCancel={() => { if (stroke.current) { stroke.current = null; changed() } }}
      onPointerLeave={() => setCursor(null)}
      onClick={(event) => { if (interactive) event.stopPropagation() }}
    >
      <canvas
        ref={element}
        width={canvas.width}
        height={canvas.height}
        aria-label={interactive ? '遮罩：涂抹要重画的部分' : undefined}
        role={interactive ? 'img' : undefined}
        className="absolute inset-0 size-full text-accent"
      />
      {interactive && cursor ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full outline-[1.5px] outline-ink"
          style={{ left: cursor.x - cursor.d / 2, top: cursor.y - cursor.d / 2, width: cursor.d, height: cursor.d }}
        />
      ) : null}
    </div>
  )
}
