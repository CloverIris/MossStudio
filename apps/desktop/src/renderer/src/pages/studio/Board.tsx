import { Plus } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import type { GalleryItem, JobRecord, ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { cn } from '../../components/ui'
import { CARD_HEADER, boardBounds, cardBodyHeight, cardRect, cardWidth, centerOn, fitView, nextFreeSpot, zoomAround, type View } from './boardLayout'
import { CanvasCard } from './CanvasCard'
import { cardJobView } from './jobStatus'
import { rerunEligibility } from './readiness'
import type { BoardTool } from './RegionLayer'
import { Toolbar } from './Toolbar'

const FIT_PADDING = { top: 72, side: 48 }

export interface BoardHandle {
  fit: () => void
  reveal: (canvasId: string) => void
}

export interface BoardProps {
  ref?: Ref<BoardHandle>
  projectKey: string
  canvases: ProjectCanvas[]
  selectedCanvasId: string | null
  jobs: readonly JobRecord[]
  busyIds: ReadonlySet<string>
  submitting: boolean
  tool: BoardTool
  onTool: (tool: BoardTool) => void
  regionKind: ProjectLayerKind
  onRegionKind: (kind: ProjectLayerKind) => void
  selectedRegionId: string | null
  onSelectRegion: (id: string | null) => void
  onOpenRegion: (id: string) => void
  onSelectCanvas: (id: string) => void
  onMoveCanvas: (id: string, x: number, y: number) => void
  onChangeLayers: (canvasId: string, update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
  onUnderlay: (item: GalleryItem | null) => void
  onAddCanvas: () => void
  onOpenViewer: (canvasId: string, index: number) => void
  onRerun: (canvasId: string, seed: 'new' | 'same') => void
  onCancel: (jobId: string) => void
  onShowActivity: (jobId?: string) => void
  onCopy: (canvas: ProjectCanvas) => void
  onDelete: (canvas: ProjectCanvas) => void
}

/** The free-form board: cards placed anywhere, pan and zoom, and the floating toolbar. */
export function Board(props: BoardProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: FIT_PADDING.side, y: FIT_PADDING.top } })
  const viewRef = useRef(view)
  viewRef.current = view
  const [panning, setPanning] = useState(false)
  const pan = useRef<{ pointerId: number; x: number; y: number; origin: View['pan'] } | null>(null)
  const cardDrag = useRef<{ id: string; pointerId: number; x: number; y: number; origin: { x: number; y: number }; moved: boolean } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Until this time a click is the tail of a drag and must not change the selection. */
  const suppressClick = useRef(0)

  const selected = props.canvases.find((canvas) => canvas.id === props.selectedCanvasId) ?? null
  const newSpot = nextFreeSpot(props.canvases, selected ?? { width: 1024, height: 1024 })
  const tileSize = selected ?? { width: 1024, height: 1024 }
  const tileRect = { x: newSpot.x, y: newSpot.y, w: cardWidth(tileSize), h: CARD_HEADER + cardBodyHeight(tileSize) }

  const viewportSize = (): { width: number; height: number } => {
    const rect = viewport.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }
  const latest = useRef(props)
  latest.current = props

  const fit = useCallback(() => {
    const size = viewportSize()
    if (!size.width || !size.height) return
    const list = latest.current.canvases
    const choice = list.find((canvas) => canvas.id === latest.current.selectedCanvasId) ?? { width: 1024, height: 1024 }
    const spot = nextFreeSpot(list, choice)
    const extra = { x: spot.x, y: spot.y, w: cardWidth(choice), h: CARD_HEADER + cardBodyHeight(choice) }
    setView(fitView(size, boardBounds(list, extra), FIT_PADDING))
  }, [])

  const reveal = useCallback((canvasId: string) => {
    const canvas = latest.current.canvases.find((item) => item.id === canvasId)
    const size = viewportSize()
    if (!canvas || !size.width) return
    const rect = cardRect(canvas)
    const current = viewRef.current
    const left = rect.x * current.zoom + current.pan.x
    const top = rect.y * current.zoom + current.pan.y
    const visible = left >= 0 && top >= FIT_PADDING.top - 24 && left + rect.w * current.zoom <= size.width && top + rect.h * current.zoom <= size.height
    if (!visible) setView(centerOn(size, rect, current.zoom))
  }, [])

  useImperativeHandle(props.ref, () => ({ fit, reveal }), [fit, reveal])

  // Fit once per opened project, as soon as its cards are measurable.
  const fitted = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (fitted.current === props.projectKey || props.canvases.length === 0) return
    fitted.current = props.projectKey
    fit()
  }, [props.projectKey, props.canvases.length, fit])

  // Wheel zooms around the pointer.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (pan.current) return
      const rect = element.getBoundingClientRect()
      setView((current) => zoomAround(current, event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015)))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = (factor: number): void => {
    const size = viewportSize()
    setView((current) => zoomAround(current, size.width / 2, size.height / 2, factor))
  }

  const endPan = (): void => {
    const gesture = pan.current
    if (!gesture) return
    pan.current = null
    setPanning(false)
    if (viewport.current?.hasPointerCapture(gesture.pointerId)) viewport.current.releasePointerCapture(gesture.pointerId)
  }
  useEffect(() => {
    window.addEventListener('blur', endPan)
    return () => window.removeEventListener('blur', endPan)
  }, [])

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-board-ui]')) return
    const onCard = Boolean(target.closest('[data-canvas-card], [data-new-canvas]'))
    // Middle button, the 平移 tool, or a drag on the empty board pans.
    const wantsPan = event.button === 1 || (event.button === 0 && (props.tool === 'pan' || !onCard))
    if (!wantsPan || pan.current) return
    event.preventDefault()
    event.stopPropagation()
    if (!onCard && event.button === 0) props.onSelectRegion(null)
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: viewRef.current.pan }
    setPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const gesture = pan.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.buttons === 0) {
      endPan()
      return
    }
    setView((current) => ({ ...current, pan: { x: gesture.origin.x + event.clientX - gesture.x, y: gesture.origin.y + event.clientY - gesture.y } }))
  }

  const startCardDrag = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || props.tool === 'pan') return
    event.stopPropagation()
    cardDrag.current = { id: canvas.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: canvas.x, y: canvas.y }, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget
    const move = (next: PointerEvent): void => {
      const drag = cardDrag.current
      if (!drag || drag.pointerId !== next.pointerId) return
      if (next.buttons === 0) { stop(next); return }
      const dx = (next.clientX - drag.x) / viewRef.current.zoom
      const dy = (next.clientY - drag.y) / viewRef.current.zoom
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
      if (!drag.moved) setDraggingId(drag.id)
      drag.moved = true
      latest.current.onMoveCanvas(drag.id, Math.round(drag.origin.x + dx), Math.round(drag.origin.y + dy))
    }
    const stop = (next: PointerEvent): void => {
      const drag = cardDrag.current
      if (!drag || drag.pointerId !== next.pointerId) return
      if (drag.moved) suppressClick.current = performance.now() + 300
      cardDrag.current = null
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

  const ordered = [...props.canvases].sort((a, b) => a.y - b.y || a.x - b.x)

  return (
    <div
      ref={viewport}
      data-panning={panning || undefined}
      className={cn('relative h-full min-h-0 overflow-hidden bg-board', (panning || props.tool === 'pan') && 'cursor-grab', panning && 'cursor-grabbing')}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onLostPointerCapture={(event) => { if (pan.current?.pointerId === event.pointerId) endPan() }}
      onAuxClick={(event) => { if (event.button === 1) event.preventDefault() }}
    >
      <Toolbar
        tool={props.tool}
        onTool={props.onTool}
        regionKind={props.regionKind}
        onRegionKind={props.onRegionKind}
        canEditLayout={selected?.kind === 'layout'}
        underlay={selected?.kind === 'layout' ? selected.backgroundPath : undefined}
        onUnderlay={props.onUnderlay}
        zoom={view.zoom}
        onZoom={zoomBy}
        onFit={fit}
      />

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
      >
        {ordered.map((canvas) => {
          const job = canvas.jobId ? props.jobs.find((item) => item.id === canvas.jobId) : undefined
          const busy = props.busyIds.has(canvas.id)
          return (
            <CanvasCard
              key={canvas.id}
              canvas={canvas}
              view={cardJobView(canvas, job, props.jobs)}
              selected={canvas.id === props.selectedCanvasId}
              dragging={draggingId === canvas.id}
              tool={props.tool}
              regionKind={props.regionKind}
              selectedRegionId={props.selectedRegionId}
              rerun={rerunEligibility(canvas, { busy, submitting: props.submitting })}
              onSelect={() => { if (performance.now() > suppressClick.current && canvas.id !== props.selectedCanvasId) props.onSelectCanvas(canvas.id) }}
              onSelectRegion={props.onSelectRegion}
              onChangeLayers={(update) => props.onChangeLayers(canvas.id, update)}
              onRegionDrawn={(id) => { props.onSelectRegion(id); props.onTool('select') }}
              onOpenRegion={props.onOpenRegion}
              onDragStart={(event) => startCardDrag(canvas, event)}
              onOpenViewer={(index) => props.onOpenViewer(canvas.id, index)}
              onRerun={(seed) => props.onRerun(canvas.id, seed)}
              onCancel={() => { if (canvas.jobId) props.onCancel(canvas.jobId) }}
              onShowActivity={() => props.onShowActivity(canvas.jobId)}
              onCopy={() => props.onCopy(canvas)}
              onDelete={() => props.onDelete(canvas)}
            />
          )
        })}
        <button
          type="button"
          data-new-canvas
          onClick={props.onAddCanvas}
          className="absolute flex items-center justify-center gap-1.5 rounded-md bg-well text-ui text-ink-2 transition-colors hover:bg-well-strong hover:text-ink"
          style={{ left: tileRect.x, top: tileRect.y + CARD_HEADER, width: tileRect.w, height: tileRect.h - CARD_HEADER }}
        >
          <Plus className="size-4" aria-hidden="true" />
          新建画面
        </button>
      </div>
    </div>
  )
}
