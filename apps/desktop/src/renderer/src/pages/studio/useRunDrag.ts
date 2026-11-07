import { useRef, useState } from 'react'
import { toBoardPoint, type View } from './boardLayout'
import type { StripItem } from './runs'
import type { Point } from './wires'

/** How far (screen pixels) a thumbnail must move before it counts as dragged out. */
const DRAG_START = 6

export interface RunDrag {
  layoutId: string
  item: StripItem
  /** Pointer position on the board. */
  at: Point
}

/**
 * Pressing a filmstrip thumbnail: a click shows that picture on its 画面's
 * face; dragging it onto the board pins it there as a card of its own.
 */
export function useRunDrag(options: {
  viewport: React.RefObject<HTMLDivElement | null>
  view: { readonly current: View }
  onShow: { readonly current: (layoutId: string, item: StripItem) => void }
  onDrop: { readonly current: (layoutId: string, item: StripItem, at: Point) => void }
}): {
  drag: RunDrag | null
  start: (layoutId: string, item: StripItem, event: React.PointerEvent<HTMLElement>) => void
} {
  const [drag, setDrag] = useState<RunDrag | null>(null)
  const active = useRef<number | null>(null)

  const boardAt = (event: { clientX: number; clientY: number }): Point => {
    const rect = options.viewport.current?.getBoundingClientRect()
    return toBoardPoint(options.view.current, event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0))
  }

  const start = (layoutId: string, item: StripItem, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || active.current !== null) return
    event.stopPropagation()
    const element = event.currentTarget
    const pointerId = event.pointerId
    const origin = { x: event.clientX, y: event.clientY }
    let moved = false
    active.current = pointerId
    try {
      element.setPointerCapture(pointerId)
    } catch {
      // The pointer is already gone.
    }
    // Only a picture can be taken out of the strip.
    const draggable = Boolean(item.path)
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId || !draggable) return
      if (!moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < DRAG_START) return
      moved = true
      setDrag({ layoutId, item, at: boardAt(next) })
    }
    const stop = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      active.current = null
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      setDrag(null)
      if (next.type !== 'pointerup') return
      if (moved) options.onDrop.current(layoutId, item, boardAt(next))
      else options.onShow.current(layoutId, item)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  }

  return { drag, start }
}
