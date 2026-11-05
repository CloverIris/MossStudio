import { useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { toBoardPoint, type View } from './boardLayout'
import { canConnect } from './connect'
import { cardAt, outputPort, type Point } from './wires'

export interface ConnectDraft {
  sourceId: string
  from: Point
  to: Point
  targetId?: string
  ok: boolean
}

export interface ConnectMenu {
  sourceId: string
  targetId: string
  /** Drop point relative to the board viewport. */
  at: { x: number; y: number }
}

/**
 * Dragging a wire out of a card's output port. While dragging, the loose end
 * follows the pointer and the card under it says whether it accepts the
 * wire; dropping on an accepting card opens the role menu.
 */
export function useWireConnect(options: {
  viewport: React.RefObject<HTMLDivElement | null>
  view: { readonly current: View }
  /** Cards in drawing order (topmost last). */
  cards: { readonly current: readonly ProjectCanvas[] }
}): {
  draft: ConnectDraft | null
  menu: ConnectMenu | null
  start: (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>) => void
  closeMenu: () => void
} {
  const [draft, setDraft] = useState<ConnectDraft | null>(null)
  const [menu, setMenu] = useState<ConnectMenu | null>(null)
  const active = useRef<number | null>(null)

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = options.viewport.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const aim = (sourceId: string, from: Point, event: PointerEvent | React.PointerEvent): ConnectDraft => {
    const at = local(event)
    const to = toBoardPoint(options.view.current, at.x, at.y)
    const target = cardAt(options.cards.current, to)
    const check = canConnect(options.cards.current, sourceId, target)
    return { sourceId, from, to, targetId: target && target.id !== sourceId ? target.id : undefined, ok: check.ok }
  }

  const start = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || active.current !== null) return
    event.preventDefault()
    setMenu(null)
    const element = event.currentTarget
    const pointerId = event.pointerId
    active.current = pointerId
    try {
      element.setPointerCapture(pointerId)
    } catch {
      // The pointer is already gone.
    }
    const from = outputPort(canvas)
    setDraft(aim(canvas.id, from, event))
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      setDraft(aim(canvas.id, from, next))
    }
    const stop = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      active.current = null
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      const end = aim(canvas.id, from, next)
      if (next.type === 'pointerup' && end.ok && end.targetId) {
        // Keep the wire drawn to the drop point while the menu is open.
        setDraft(end)
        setMenu({ sourceId: canvas.id, targetId: end.targetId, at: local(next) })
      } else {
        setDraft(null)
      }
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  }

  const closeMenu = (): void => {
    setMenu(null)
    setDraft(null)
  }

  return { draft, menu, start, closeMenu }
}
