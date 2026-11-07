import { useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { toBoardPoint, type View } from './boardLayout'
import { canConnect } from './connect'
import { dropZones, slotDrop, SOCKET_REACH, socketAt, socketY, styleDrop, type InputSlot, type SlotDrop } from './ports'
import { cardAt, outputPort, type Point } from './wires'

/** Where a dragged wire would land on the card it aims at: one socket on its left edge per input it could fill. */
export interface DropZones {
  slots: InputSlot[]
  drops: SlotDrop[]
  /** The socket nearest the pointer. */
  active: number
}

export interface ConnectDraft {
  sourceId: string
  from: Point
  to: Point
  targetId?: string
  ok: boolean
  zones?: DropZones
  /** Why the card under the pointer refuses the wire. */
  reason?: string
}

export interface ConnectMenu {
  sourceId: string
  /** Drop point relative to the board viewport. */
  at: { x: number; y: number }
  /** Drop point on the board. */
  point: Point
}

/** How far (screen pixels) a wire must be pulled before a drop on the empty board offers a new 画面. */
export const NEW_CANVAS_PULL = 48

/**
 * Dragging a wire out of a card's output port. Aimed at a card that takes it
 * (over it, or just left of it), the card's left edge shows a socket per input
 * it could fill and the wire snaps to the nearest; letting go links into it.
 * A socket that cannot take it says why. Letting go on the empty board offers
 * a new 画面 fed by the picture.
 */
export function useWireConnect(options: {
  viewport: React.RefObject<HTMLDivElement | null>
  view: { readonly current: View }
  /** Cards in drawing order (topmost last). */
  cards: { readonly current: readonly ProjectCanvas[] }
  /** A card's input slots (empty and linked). */
  slotsFor: { readonly current: (canvas: ProjectCanvas) => InputSlot[] }
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
    const zoom = options.view.current.zoom
    const source = options.cards.current.find((canvas) => canvas.id === sourceId)
    // Just left of a card's edge, where its sockets are, still aims at it.
    const target =
      cardAt(options.cards.current, to) ??
      cardAt(
        options.cards.current.filter((canvas) => canvas.id !== sourceId),
        { x: to.x + SOCKET_REACH / Math.max(0.01, zoom), y: to.y },
      )
    const targetId = target && target.id !== sourceId ? target.id : undefined
    const check = canConnect(options.cards.current, sourceId, target)
    if (!target) return { sourceId, from, to, ok: false }
    if (!check.ok) return { sourceId, from, to, targetId, ok: false, reason: check.reason || undefined }
    const slots = dropZones(options.slotsFor.current(target), source?.kind)
    if (!slots.length) {
      // Nothing left to fill: say why (a 风格 that is already there, or every reference taken).
      const reason = source?.kind === 'style' ? (styleDrop(target, sourceId) as { reason?: string }).reason : '这里接不了图片'
      return { sourceId, from, to, targetId, ok: false, reason }
    }
    const index = socketAt(target, slots.length, zoom, to.y)
    const drops = slots.map((slot) => slotDrop(slot, target, sourceId, source?.kind))
    const drop = drops[index]!
    return {
      sourceId,
      from,
      // A socket that takes the wire holds its end.
      to: drop.ok ? { x: target.x, y: socketY(target, index, slots.length, zoom) } : to,
      targetId,
      ok: drop.ok,
      zones: { slots, drops, active: index },
      reason: drop.ok ? undefined : drop.reason,
    }
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
      const drop = end.zones?.drops[end.zones.active]
      if (next.type === 'pointerup' && end.targetId && drop?.ok) {
        options.onSlotDrop(end.targetId, canvas.id, drop)
        setDraft(null)
      } else if (next.type === 'pointerup' && !end.targetId && pulled && canvas.kind !== 'style') {
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
