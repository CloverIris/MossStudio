import type { ProjectCanvas } from '@shared/types'
import { CARD_HEADER, cardBodyHeight, cardRect, cardWidth } from './boardLayout'
import { linksOf, type LinkRole } from './links'
import { linkSlotKey, type InputSlot } from './ports'

/**
 * Board wires, pure geometry. A wire runs from the source card's output port
 * (right edge of its picture) to one of the consumer's input ports (left edge,
 * one per linked role, stacked around the middle). Everything is in unscaled
 * board pixels, so the wire layer pans and zooms with the cards.
 */

export interface Point {
  x: number
  y: number
}

/** Vertical distance between stacked input ports. */
export const PORT_SPACING = 22
/** Label chips keep their screen size at any zoom (screen pixels). */
export const CHIP_HEIGHT = 20
/** Gap between stacked chips, and between a chip and its port (screen pixels). */
export const CHIP_GAP = 4
/** Below this zoom chips show only for a hovered or selected wire. */
export const CHIP_MIN_ZOOM = 0.4
/** Shortest horizontal handle of a wire's curve, so short or backward wires still read as wires. */
export const MIN_HANDLE = 48

type Placed = Pick<ProjectCanvas, 'x' | 'y' | 'width' | 'height'>

export interface Wire {
  id: string
  /** lineage: a result and the canvas it was generated from; input: a link in `inputs`. */
  kind: 'lineage' | 'input'
  sourceId: string
  targetId: string
  role?: LinkRole
  /** What removes the link: the control kind, or the reference index. */
  at?: number | string
  label?: string
  from: Point
  to: Point
  path: string
  /** The middle of the curve. */
  mid: Point
  /**
   * The label chip, in board pixels: right-aligned just left of the wire's
   * input port, stacked in port order so chips into one card never overlap.
   */
  chip?: ChipRect
}

export interface ChipRect {
  x: number
  y: number
  w: number
  h: number
}

/** Estimated chip width in screen pixels (text-micro: CJK ≈ 11px, digits and latin ≈ 6.5px, padding 16px). */
export function chipWidth(label: string): number {
  let width = 16
  for (const char of label) {
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char)) width += 11
    else if (char === ' ' || char === '·') width += 4
    else width += 6.5
  }
  return Math.ceil(width)
}

/**
 * Chips for the wires into one card, in port order. Each wants to sit
 * centred on its port; any that would touch the one above is pushed down,
 * then the stack is shifted back so it stays centred on the ports.
 */
export function stackChips(ports: readonly Point[], labels: readonly string[], zoom: number): ChipRect[] {
  const scale = 1 / Math.max(0.01, zoom)
  const h = CHIP_HEIGHT * scale
  const gap = CHIP_GAP * scale
  const rects = ports.map((port, index) => {
    const w = chipWidth(labels[index] ?? '') * scale
    return { x: port.x - gap * 2 - w, y: port.y - h / 2, w, h }
  })
  for (let index = 1; index < rects.length; index += 1) {
    const above = rects[index - 1]!
    rects[index]!.y = Math.max(rects[index]!.y, above.y + above.h + gap)
  }
  if (rects.length) {
    const wanted = ports.reduce((sum, port) => sum + port.y, 0) / ports.length
    const actual = rects.reduce((sum, rect) => sum + rect.y + rect.h / 2, 0) / rects.length
    const shift = actual - wanted
    for (const rect of rects) rect.y -= shift
  }
  return rects
}

function bodyMiddle(canvas: Placed): number {
  return canvas.y + CARD_HEADER + cardBodyHeight(canvas) / 2
}

export function outputPort(canvas: Placed): Point {
  return { x: canvas.x + cardWidth(canvas), y: bodyMiddle(canvas) }
}

/**
 * Input port `index` of `count`, centred on the picture and kept inside it.
 * `minSpacing` (board pixels) spreads the ports so their chips fit beside them.
 */
export function inputPort(canvas: Placed, index: number, count: number, minSpacing = 0): Point {
  const total = Math.max(1, count)
  const spacing = Math.min(Math.max(PORT_SPACING, minSpacing), cardBodyHeight(canvas) / (total + 1))
  return { x: canvas.x, y: bodyMiddle(canvas) + (index - (total - 1) / 2) * spacing }
}

function handle(from: Point, to: Point): number {
  return Math.max(MIN_HANDLE, Math.abs(to.x - from.x) / 2)
}

/** A smooth horizontal cubic bézier from an output port to an input port. */
export function wirePath(from: Point, to: Point): string {
  const dx = handle(from, to)
  const r = (value: number): number => Math.round(value * 10) / 10
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x + dx)} ${r(from.y)}, ${r(to.x - dx)} ${r(to.y)}, ${r(to.x)} ${r(to.y)}`
}

/** The point on the wire's curve at `t` (0 = source, 1 = consumer). */
export function wirePoint(from: Point, to: Point, t: number): Point {
  const dx = handle(from, to)
  const p1 = { x: from.x + dx, y: from.y }
  const p2 = { x: to.x - dx, y: to.y }
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * from.x + b * p1.x + c * p2.x + d * to.x, y: a * from.y + b * p1.y + c * p2.y + d * to.y }
}

function wire(partial: Omit<Wire, 'path' | 'mid'>): Wire {
  return { ...partial, path: wirePath(partial.from, partial.to), mid: wirePoint(partial.from, partial.to, 0.5) }
}

/** An input slot with nothing linked yet: its port and its label chip. */
export interface EmptyPort {
  canvasId: string
  slot: InputSlot
  port: Point
  chip: ChipRect
}

/** Where a card's slots are on the board (linked and empty), for hit-testing a dropped wire. */
export interface SlotPort {
  canvasId: string
  slot: InputSlot
  port: Point
}

/**
 * Every wire on the board, and the empty input slots. Layout canvases draw
 * one wire per input link; a result draws only its faint lineage wire (it
 * carries a copy of its source's inputs, which would otherwise be drawn
 * twice). Links whose source is gone are not drawn.
 *
 * With `slotsFor`, a layout canvas's ports are its slots (ports.ts): linked
 * ones end a wire, empty ones get a muted chip, and all of them share one
 * stack of chips so labels never overlap. Without it, only links get ports.
 */
export function boardPorts(
  canvases: readonly ProjectCanvas[],
  zoom = 1,
  slotsFor?: (canvas: ProjectCanvas) => InputSlot[],
): { wires: Wire[]; empties: EmptyPort[]; slots: SlotPort[] } {
  // Ports far enough apart for a chip each at this zoom (when the picture is tall enough).
  const minSpacing = (CHIP_HEIGHT + CHIP_GAP) / Math.max(0.01, zoom)
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  const wires: Wire[] = []
  const empties: EmptyPort[] = []
  const slotPorts: SlotPort[] = []
  for (const canvas of canvases) {
    if (canvas.kind === 'result') {
      const source = canvas.sourceCanvasId ? byId.get(canvas.sourceCanvasId) : undefined
      if (source) {
        wires.push(
          wire({
            id: `lineage:${canvas.id}`,
            kind: 'lineage',
            sourceId: source.id,
            targetId: canvas.id,
            from: outputPort(source),
            to: inputPort(canvas, 0, 1),
          }),
        )
      }
      continue
    }
    if (canvas.kind !== 'layout') continue
    const entries = linksOf(canvas)
    const slots = slotsFor?.(canvas) ?? null
    const keys = slots ? slots.map((slot) => slot.key) : entries.map(linkSlotKey)
    const ports = keys.map((_, index) => inputPort(canvas, index, keys.length, minSpacing))
    const labels = slots ? slots.map((slot) => slot.label) : entries.map((entry) => entry.label)
    const chips = stackChips(ports, labels, zoom)
    slots?.forEach((slot, index) => {
      slotPorts.push({ canvasId: canvas.id, slot, port: ports[index]! })
      if (!slot.linked) empties.push({ canvasId: canvas.id, slot, port: ports[index]!, chip: chips[index]! })
    })
    for (const entry of entries) {
      const source = byId.get(entry.link.canvasId)
      if (!source || source.id === canvas.id) continue
      const index = keys.indexOf(linkSlotKey(entry))
      if (index < 0) continue
      const at = entry.role === 'control' ? entry.kind : entry.index
      wires.push({
        ...wire({
          id: `input:${canvas.id}:${entry.role}:${at ?? ''}`,
          kind: 'input',
          sourceId: source.id,
          targetId: canvas.id,
          role: entry.role,
          at,
          // The socket names the wire (a 放大's start picture is its 原图).
          label: labels[index] ?? entry.label,
          from: outputPort(source),
          to: ports[index]!,
        }),
        chip: chips[index],
      })
    }
  }
  return { wires, empties, slots: slotPorts }
}

/** Every wire on the board (see boardPorts), with ports for links only. */
export function boardWires(canvases: readonly ProjectCanvas[], zoom = 1): Wire[] {
  return boardPorts(canvases, zoom).wires
}

/** The slot port nearest to a point, within `radius` board pixels. */
export function slotAt(slots: readonly SlotPort[], point: Point, radius: number): SlotPort | undefined {
  let best: SlotPort | undefined
  let bestDistance = radius
  for (const item of slots) {
    const distance = Math.hypot(item.port.x - point.x, item.port.y - point.y)
    if (distance <= bestDistance) {
      best = item
      bestDistance = distance
    }
  }
  return best
}

/** The topmost card under a board point (later cards are drawn on top). */
export function cardAt<T extends Placed & { id: string }>(canvases: readonly T[], point: Point): T | undefined {
  for (let index = canvases.length - 1; index >= 0; index -= 1) {
    const canvas = canvases[index]!
    const rect = cardRect(canvas)
    if (point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h) return canvas
  }
  return undefined
}
