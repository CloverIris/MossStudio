import { useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { toBoardPoint, type View } from './boardLayout'
import { canConnect } from './connect'
import { slotDrop, styleDrop, type SlotDrop } from './ports'
import { cardAt, outputPort, slotAt, type Point, type SlotPort } from './wires'

/** How close (screen pixels) the pointer must be to an input port to drop straight into it. */
export const SLOT_SNAP = 18

export interface ConnectDraft {
  sourceId: string
  from: Point
  to: Point
  targetId?: string
  ok: boolean
  /** The input slot under the pointer (`canvasId/slotKey`), and what dropping there does. */
  slot?: { id: string; drop: SlotDrop }
  /** Why the card or slot under the pointer refuses the wire. */
  reason?: string
}

export interface ConnectMenu {
  sourceId: string
  /** The card the wire was dropped on; absent when it was dropped on the empty board (a new 画面 is offered). */
  targetId?: string
  /** Drop point relative to the board viewport. */
  at: { x: number; y: number }
  /** Drop point on the board. */
  point: Point
}

/** How far (screen pixels) a wire must be pulled before a drop on the empty board offers a new 画面. */
export const NEW_CANVAS_PULL = 48

/**
 * Dragging a wire out of a card's output port. While dragging, the loose end
 * follows the pointer and the card under it says whether it accepts the
 * wire (and why not). Dropping on an input port links straight into it;
 * dropping anywhere else on an accepting card opens the role menu, and
 * dropping on the empty board offers a new 画面 fed by the picture.
 */
export function useWireConnect(options: {
  viewport: React.RefObject<HTMLDivElement | null>
  view: { readonly current: View }
  /** Cards in drawing order (topmost last). */
  cards: { readonly current: readonly ProjectCanvas[] }
  /** Input slot ports on the board: a drop on one links straight into it. */
  slots: { readonly current: readonly SlotPort[] }
  onSlotDrop: (targetId: string, sourceId: string, drop: Extract<SlotDrop, { ok: true }>) => void
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
    // A port sits on the card's left edge, half outside it: look for one first.
    const radius = SLOT_SNAP / Math.max(0.01, options.view.current.zoom)
    const sourceKind = options.cards.current.find((canvas) => canvas.id === sourceId)?.kind
    // A 风格 wire snaps only to 风格 sockets; near a picture socket it still links as a 风格.
    const hit = slotAt(
      options.slots.current.filter((item) => item.canvasId !== sourceId && (sourceKind !== 'style' || item.slot.role === 'style')),
      to,
      radius,
    )
    const target = hit ? options.cards.current.find((canvas) => canvas.id === hit.canvasId) : cardAt(options.cards.current, to)
    const check = canConnect(options.cards.current, sourceId, target)
    const targetId = target && target.id !== sourceId ? target.id : undefined
    if (!check.ok) return { sourceId, from, to, targetId, ok: false, reason: check.reason || undefined }
    if (hit && target) {
      const drop = slotDrop(hit.slot, target, sourceId, sourceKind)
      return {
        sourceId,
        from,
        to: hit.port,
        targetId,
        ok: drop.ok,
        slot: { id: `${hit.canvasId}/${hit.slot.key}`, drop },
        reason: drop.ok ? undefined : drop.reason,
      }
    }
    // A 风格 has one way in: anywhere on a 画面 links it.
    if (sourceKind === 'style' && target) {
      const drop = styleDrop(target, sourceId)
      return { sourceId, from, to, targetId, ok: drop.ok, reason: drop.ok ? undefined : drop.reason }
    }
    return { sourceId, from, to, targetId, ok: true }
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
    const startX = event.clientX
    const startY = event.clientY
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
      const pulled = Math.hypot(next.clientX - startX, next.clientY - startY) >= NEW_CANVAS_PULL
      const style = canvas.kind === 'style'
      if (next.type === 'pointerup' && end.ok && end.targetId && end.slot?.drop.ok) {
        options.onSlotDrop(end.targetId, canvas.id, end.slot.drop)
        setDraft(null)
      } else if (next.type === 'pointerup' && end.ok && end.targetId && style) {
        options.onSlotDrop(end.targetId, canvas.id, { ok: true, role: 'style' })
        setDraft(null)
      } else if (next.type === 'pointerup' && end.ok && end.targetId) {
        // Keep the wire drawn to the drop point while the menu is open.
        setDraft(end)
        setMenu({ sourceId: canvas.id, targetId: end.targetId, at: local(next), point: end.to })
      } else if (next.type === 'pointerup' && !end.targetId && pulled && !style) {
        // Dropped on the empty board: offer a new 画面 fed by this picture.
        setDraft({ ...end, ok: true, reason: undefined })
        setMenu({ sourceId: canvas.id, at: local(next), point: end.to })
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
