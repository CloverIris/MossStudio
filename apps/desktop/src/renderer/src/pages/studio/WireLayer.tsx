import { X } from 'lucide-react'
import { cn } from '../../components/ui'
import { CHIP_MIN_ZOOM, wirePath, type Point, type Wire } from './wires'

export interface WireDraft {
  from: Point
  to: Point
  /** Over a card that accepts the wire. */
  ok: boolean
}

/**
 * Wires between cards, drawn under them inside the board's transformed space.
 * Strokes keep their screen width at any zoom.
 */
export function WireLayer({
  wires,
  zoom,
  selectedWireId,
  selectedCanvasId,
  flowing,
  draft,
  onSelect,
  onHover,
}: {
  wires: readonly Wire[]
  zoom: number
  selectedWireId: string | null
  selectedCanvasId: string | null
  /** Consumers that are generating: their wires flow. */
  flowing: ReadonlySet<string>
  draft: WireDraft | null
  onSelect: (id: string) => void
  onHover: React.Dispatch<React.SetStateAction<string | null>>
}): React.JSX.Element {
  const chipScale = 1 / Math.max(0.01, zoom)
  const setHovered = onHover

  return (
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
      {wires.map((wire) => {
        const selected = wire.id === selectedWireId
        const atSelection = wire.sourceId === selectedCanvasId || wire.targetId === selectedCanvasId
        const flow = flowing.has(wire.targetId)
        const lineage = wire.kind === 'lineage'
        // Lineage (where a picture came from) stays faint even at the selection: only real
        // input wires take the accent, so a selected card never shows two equally strong kinds.
        const accent = !lineage && (selected || atSelection || flow)
        return (
          <g
            key={wire.id}
            data-wire={wire.id}
            data-wire-kind={wire.kind}
            data-wire-state={selected ? 'selected' : flow ? 'flowing' : atSelection ? 'selected-end' : 'rest'}
            data-board-ui={lineage ? undefined : true}
          >
            {lineage ? null : (
              <path
                d={wire.path}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                vectorEffect="non-scaling-stroke"
                className="cursor-pointer"
                style={{ pointerEvents: 'stroke' }}
                onPointerEnter={() => setHovered(wire.id)}
                onPointerLeave={() => setHovered((value) => (value === wire.id ? null : value))}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(wire.id)
                }}
              />
            )}
            <path
              d={wire.path}
              fill="none"
              strokeWidth={selected ? 2.5 : 1.5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className={cn(accent ? 'stroke-accent' : 'stroke-ink-3', lineage && 'opacity-50', flow && !lineage && 'studio-wire-flow')}
            />
            {lineage ? null : (
              <circle cx={wire.to.x} cy={wire.to.y} r={3.5 * chipScale} className={accent ? 'fill-accent' : 'fill-ink-3'} />
            )}
          </g>
        )
      })}
      {draft ? (
        <g data-wire-draft>
          <path
            d={wirePath(draft.from, draft.to)}
            fill="none"
            strokeWidth={2}
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
            className={draft.ok ? 'stroke-accent' : 'stroke-ink-3'}
          />
          <circle cx={draft.to.x} cy={draft.to.y} r={4 * chipScale} className={draft.ok ? 'fill-accent' : 'fill-ink-3'} />
        </g>
      ) : null}
    </svg>
  )
}

/**
 * The label chips, drawn above the cards: counter-scaled so their text stays
 * readable, beside each wire's input port. Below CHIP_MIN_ZOOM the cards are
 * too small for labels; a chip then shows only for a hovered or selected wire.
 */
export function WireChips({
  wires,
  zoom,
  focus,
  selectedWireId,
  hovered,
  onHover,
  onSelect,
  onRemove,
}: {
  wires: readonly Wire[]
  zoom: number
  /** Cards being looked at (selected, under the pointer): their wires show labels. */
  focus: ReadonlySet<string>
  selectedWireId: string | null
  hovered: string | null
  onHover: React.Dispatch<React.SetStateAction<string | null>>
  onSelect: (id: string) => void
  onRemove: (wire: Wire) => void
}): React.JSX.Element {
  const chipScale = 1 / Math.max(0.01, zoom)
  const setHovered = onHover
  return (
    <>
      {wires.map((wire) => {
        if (wire.kind !== 'input' || !wire.label || !wire.chip) return null
        const chip = wire.chip
        const selected = wire.id === selectedWireId
        const showRemove = selected || hovered === wire.id
        // A label shows only for a wire being looked at, or one into or out of a card being looked at.
        const looked = focus.has(wire.targetId) || focus.has(wire.sourceId)
        if (!showRemove && (!looked || zoom < CHIP_MIN_ZOOM)) return null
        return (
          <div
            key={wire.id}
            data-board-ui
            data-wire-chip={wire.id}
            // Right-aligned beside its input port (× opens to the left), at screen size.
            className="absolute left-0 top-0 z-[6] flex origin-top-left flex-row-reverse items-center gap-0.5"
            style={{ transform: `translate(${chip.x + chip.w}px, ${chip.y + chip.h / 2}px) scale(${chipScale}) translate(-100%, -50%)` }}
            onPointerEnter={() => setHovered(wire.id)}
            onPointerLeave={() => setHovered((value) => (value === wire.id ? null : value))}
          >
            <button
              type="button"
              aria-pressed={selected}
              aria-label={`连线：${wire.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(wire.id)
              }}
              className={cn(
                'tabular h-5 whitespace-nowrap rounded-full px-2 text-micro font-medium transition-colors',
                selected ? 'bg-accent text-on-accent' : 'bg-raised text-ink-2 hover:text-ink',
              )}
            >
              {wire.label}
            </button>
            {showRemove ? (
              <button
                type="button"
                aria-label={`断开 ${wire.label}`}
                title="断开这条连线（Delete）"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(wire)
                }}
                className="inline-flex size-5 items-center justify-center rounded-full bg-raised text-ink-2 hover:bg-danger-soft hover:text-danger"
              >
                <X className="size-3" aria-hidden="true" strokeWidth={1.6} />
              </button>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
