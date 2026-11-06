import { useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'

/**
 * Dragging a card by its title row. Moves are reported in board pixels as
 * they happen (so wires follow the card live); a drag of a few pixels or more
 * swallows the click that ends it.
 */
export function useCardDrag(options: {
  zoom: { readonly current: number }
  onMove: { readonly current: (id: string, x: number, y: number) => void }
}): {
  draggingId: string | null
  /** True while a click is the tail of a drag and must not change the selection. */
  isDragTail: () => boolean
  start: (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>) => void
} {
  const drag = useRef<{ id: string; pointerId: number; x: number; y: number; origin: { x: number; y: number }; moved: boolean } | null>(
    null,
  )
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const suppressClick = useRef(0)

  const start = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    event.stopPropagation()
    drag.current = {
      id: canvas.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: { x: canvas.x, y: canvas.y },
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget
    const move = (next: PointerEvent): void => {
      const current = drag.current
      if (!current || current.pointerId !== next.pointerId) return
      if (next.buttons === 0) {
        stop(next)
        return
      }
      const dx = (next.clientX - current.x) / options.zoom.current
      const dy = (next.clientY - current.y) / options.zoom.current
      if (!current.moved && Math.abs(dx) + Math.abs(dy) < 3) return
      if (!current.moved) setDraggingId(current.id)
      current.moved = true
      options.onMove.current(current.id, Math.round(current.origin.x + dx), Math.round(current.origin.y + dy))
    }
    const stop = (next: PointerEvent): void => {
      const current = drag.current
      if (!current || current.pointerId !== next.pointerId) return
      if (current.moved) suppressClick.current = performance.now() + 300
      drag.current = null
      setDraggingId(null)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
      if (element.hasPointerCapture(next.pointerId)) element.releasePointerCapture(next.pointerId)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  }

  return { draggingId, isDragTail: () => performance.now() <= suppressClick.current, start }
}
