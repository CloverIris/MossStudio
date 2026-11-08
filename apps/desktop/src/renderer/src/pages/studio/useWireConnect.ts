import { useEffect, useRef, useState } from 'react'
import type { ProjectCanvas } from '@shared/types'
import { toBoardPoint, type View } from './boardLayout'
import { canConnect } from './connect'
import { dropZones, slotDrop, SOCKET_REACH, socketAt, socketY, styleDrop, type InputSlot, type SlotDrop } from './ports'
import { cardAt, outputPort, type Point } from './wires'

/** The sockets a card offers a wire: one per input it could fill. */
export interface DropOffer {
  slots: InputSlot[]
  drops: SlotDrop[]
}

/** The sockets of the card a wire is at, and which one. */
export interface DropZones extends DropOffer {
  active: number
}

export interface ConnectDraft {
  sourceId: string
  from: Point
  to: Point
  /** Every card that can take the picture, by id: their sockets show while the wire is out. */
  offers: ReadonlyMap<string, DropOffer>
  /** The card the wire is at (snapped to one of its sockets, or over it). */
  targetId?: string
  ok: boolean
  zones?: DropZones
  /** Why the socket or card the wire is at refuses it. */
  reason?: string
  /** Started with a click: the wire follows the pointer until the next click. */
  sticky?: boolean
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
/** A wire this close (screen pixels) to a socket snaps to it. */
export const SNAP_RADIUS = 64
/** A press that moves less than this (screen pixels) is a click: the wire then follows the pointer. */
const CLICK_SLOP = 4

/** The cards that can take a wire from `sourceId`, with their sockets. */
export function offersFor(
  cards: readonly ProjectCanvas[],
  sourceId: string,
  slotsFor: (canvas: ProjectCanvas) => InputSlot[],
): Map<string, DropOffer> {
  const source = cards.find((canvas) => canvas.id === sourceId)
  const offers = new Map<string, DropOffer>()
  for (const card of cards) {
    if (card.id === sourceId || !canConnect(cards, sourceId, card).ok) continue
    const slots = dropZones(slotsFor(card), source?.kind)
    if (slots.length) offers.set(card.id, { slots, drops: slots.map((slot) => slotDrop(slot, card, sourceId, source?.kind)) })
  }
  return offers
}

/** The socket nearest `to` within the snap radius, over all offering cards. */
export function nearestSocket(
  cards: readonly ProjectCanvas[],
  offers: ReadonlyMap<string, DropOffer>,
  to: Point,
  zoom: number,
): { card: ProjectCanvas; index: number } | null {
  let best: { card: ProjectCanvas; index: number } | null = null
  let bestDistance = SNAP_RADIUS
  for (const card of cards) {
    const count = offers.get(card.id)?.slots.length ?? 0
    for (let index = 0; index < count; index += 1) {
      const distance = Math.hypot(to.x - card.x, to.y - socketY(card, index, count, zoom)) * zoom
      if (distance <= bestDistance) {
        best = { card, index }
        bestDistance = distance
      }
    }
  }
  return best
}

/**
 * Pulling a wire out of a card's handle. As soon as it is out, every card
 * that can take the picture shows a socket per input on its left edge, and
 * the wire snaps to the nearest one; letting go there links into it. A
 * socket that cannot take it says why. Letting go on the empty board offers
 * a new 画面 fed by the picture. A click on the handle (no drag) leaves the
 * wire following the pointer: the next click places it, Esc cancels.
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
  // Ends a wire that is following the pointer (unmount, or a new wire).
  const cancelSticky = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelSticky.current?.(), [])

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = options.viewport.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const aim = (
    sourceId: string,
    from: Point,
    offers: ReadonlyMap<string, DropOffer>,
    event: { clientX: number; clientY: number },
  ): ConnectDraft => {
    const at = local(event)
    const to = toBoardPoint(options.view.current, at.x, at.y)
    const zoom = options.view.current.zoom
    const cards = options.cards.current
    const base = { sourceId, from, to, offers }
    const near = nearestSocket(cards, offers, to, zoom)
    // Over a card, or just left of its edge where its sockets are.
    const under =
      cardAt(cards, to) ??
      cardAt(
        cards.filter((canvas) => canvas.id !== sourceId),
        { x: to.x + SOCKET_REACH / Math.max(0.01, zoom), y: to.y },
      )
    const target = near?.card ?? (under && offers.has(under.id) ? under : undefined)
    if (!target) {
      if (!under || under.id === sourceId) return { ...base, ok: false }
      // A card that cannot take the wire says why.
      const source = cards.find((canvas) => canvas.id === sourceId)
      const check = canConnect(cards, sourceId, under)
      const reason = !check.ok
        ? check.reason || undefined
        : source?.kind === 'style'
          ? (styleDrop(under, sourceId) as { reason?: string }).reason
          : '这里接不了图片'
      return { ...base, targetId: under.id, ok: false, reason }
    }
    const offer = offers.get(target.id)!
    const index = near ? near.index : socketAt(target, offer.slots.length, zoom, to.y)
    const drop = offer.drops[index]!
    return {
      ...base,
      // A socket that takes the wire holds its end.
      to: drop.ok ? { x: target.x, y: socketY(target, index, offer.slots.length, zoom) } : to,
      targetId: target.id,
      ok: drop.ok,
      zones: { ...offer, active: index },
      reason: drop.ok ? undefined : drop.reason,
    }
  }

  /** Lets go of the wire at `end`: links, offers a new 画面, or (false) leaves it where it is. */
  const place = (canvas: ProjectCanvas, end: ConnectDraft, at: { clientX: number; clientY: number }, pulled: boolean): boolean => {
    const drop = end.zones?.drops[end.zones.active]
    if (end.targetId && drop?.ok) {
      options.onSlotDrop(end.targetId, canvas.id, drop)
      setDraft(null)
      return true
    }
    if (!end.targetId && pulled && canvas.kind !== 'style') {
      // On the empty board: offer a new 画面 fed by this picture.
      setDraft({ ...end, sticky: false, ok: true, reason: undefined })
      setMenu({ sourceId: canvas.id, at: local(at), point: end.to })
      return true
    }
    return false
  }

  /** After a click on the handle: the wire follows the pointer; a click places it, Esc or a right click cancels. */
  const follow = (canvas: ProjectCanvas, from: Point, offers: ReadonlyMap<string, DropOffer>): void => {
    const move = (next: PointerEvent): void => setDraft({ ...aim(canvas.id, from, offers, next), sticky: true })
    const end = (): void => {
      cancelSticky.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('keydown', key, true)
    }
    const cancel = (): void => {
      end()
      setDraft(null)
    }
    const press = (next: PointerEvent): void => {
      // The press belongs to the wire, not to what is under it.
      next.stopPropagation()
      next.preventDefault()
      const swallow = (click: MouseEvent): void => {
        click.stopPropagation()
        click.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 400)
      if (next.button !== 0) return cancel()
      const target = aim(canvas.id, from, offers, next)
      // A socket or card that refuses keeps the wire out, to try another.
      if (target.targetId && !target.ok) return
      end()
      if (!place(canvas, target, next, true)) setDraft(null)
    }
    const key = (next: KeyboardEvent): void => {
      if (next.key !== 'Escape') return
      next.stopPropagation()
      next.preventDefault()
      cancel()
    }
    cancelSticky.current = cancel
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('keydown', key, true)
  }

  const start = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || active.current !== null) return
    event.preventDefault()
    cancelSticky.current?.()
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
    const offers = offersFor(options.cards.current, canvas.id, options.slotsFor.current)
    const startX = event.clientX
    const startY = event.clientY
    setDraft(aim(canvas.id, from, offers, event))
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      setDraft(aim(canvas.id, from, offers, next))
    }
    const stop = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) return
      active.current = null
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      const pull = Math.hypot(next.clientX - startX, next.clientY - startY)
      if (next.type === 'pointerup' && pull < CLICK_SLOP) {
        follow(canvas, from, offers)
        setDraft({ ...aim(canvas.id, from, offers, next), sticky: true })
        return
      }
      const end = aim(canvas.id, from, offers, next)
      if (next.type !== 'pointerup' || !place(canvas, end, next, pull >= NEW_CANVAS_PULL)) setDraft(null)
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
