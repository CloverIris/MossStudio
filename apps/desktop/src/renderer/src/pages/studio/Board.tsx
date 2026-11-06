import { Plus } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import type {
  CanvasImageLink,
  ControlAdapterEntry,
  EngineFeatures,
  GalleryItem,
  JobRecord,
  ProjectCanvas,
  ProjectLayer,
  ProjectLayerKind,
} from '@shared/types'
import { cn } from '../../components/ui'
import {
  CARD_HEADER,
  boardBounds,
  cardBodyHeight,
  cardRect,
  cardWidth,
  centerOn,
  fitView,
  nextFreeSpot,
  toBoardPoint,
  zoomAround,
  type View,
} from './boardLayout'
import { CanvasCard } from './CanvasCard'
import { canConnect, hasPicture, linkMenu } from './connect'
import { isImageFile } from './imageNodes'
import { cardJobView } from './jobStatus'
import { LinkMenu } from './LinkMenu'
import { controlKindLabel, linkSourceImage, roleLabel, type LinkRole, type PickTarget } from './links'
import { BRUSH_DEFAULT, maskAvailability, startPictureSize } from './mask'
import type { MaskBrush, MaskCommand } from './MaskLayer'
import { rerunEligibility, type ReadinessInput } from './readiness'
import type { BoardTool } from './RegionLayer'
import { MaskBar, Toolbar } from './Toolbar'
import { useCardDrag } from './useCardDrag'
import { useWireConnect } from './useWireConnect'
import { useWireSelection } from './useWireSelection'
import { WireChips, WireLayer } from './WireLayer'
import { boardWires } from './wires'

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
  /** The app update state: a required update blocks reruns (see readiness.ts). */
  update?: ReadinessInput['update']
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
  /** What the engine can do (undefined while loading, null when none is usable). */
  engineFeatures: EngineFeatures | null | undefined
  controlAdapters: readonly ControlAdapterEntry[]
  onLink: (targetId: string, role: LinkRole, link: CanvasImageLink, kind?: string) => void
  onRemoveLink: (canvasId: string, role: LinkRole, at?: number | string) => void
  /** Picture files dropped or pasted onto the board, at a board point. */
  onImportImages: (files: File[], at: { x: number; y: number }) => void
  /** A painted mask to store for a canvas (null: nothing painted any more). */
  onSaveMask: (canvasId: string, png: Uint8Array | null) => void
  /** Pick mode (from the inspector): the next card with a picture clicked fills this input. */
  pickTarget?: PickTarget | null
  onPick?: (sourceCanvasId: string) => void
}

function isTyping(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]'))
}

/** The free-form board: cards placed anywhere and wired together, pan and zoom, and the floating toolbar. */
export function Board(props: BoardProps): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: FIT_PADDING.side, y: FIT_PADDING.top } })
  const viewRef = useRef(view)
  viewRef.current = view
  const [panning, setPanning] = useState(false)
  const pan = useRef<{ pointerId: number; x: number; y: number; origin: View['pan'] } | null>(null)
  const [brush, setBrush] = useState<MaskBrush>({ mode: 'paint', size: BRUSH_DEFAULT })
  const [maskCommand, setMaskCommand] = useState<MaskCommand | undefined>(undefined)
  /** Last pointer position over the board, where a pasted picture lands. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const selected = props.canvases.find((canvas) => canvas.id === props.selectedCanvasId) ?? null
  const tileSize = selected && selected.kind !== 'image' ? selected : { width: 1024, height: 1024 }
  const newSpot = nextFreeSpot(props.canvases, tileSize)
  const tileRect = { x: newSpot.x, y: newSpot.y, w: cardWidth(tileSize), h: CARD_HEADER + cardBodyHeight(tileSize) }

  const [hoveredWire, setHoveredWire] = useState<string | null>(null)
  const wires = useMemo(() => boardWires(props.canvases, view.zoom), [props.canvases, view.zoom])
  const mask = maskAvailability(selected, props.engineFeatures)

  const viewportSize = (): { width: number; height: number } => {
    const rect = viewport.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }
  const latest = useRef(props)
  latest.current = props
  const zoomRef = useRef(view.zoom)
  zoomRef.current = view.zoom
  const moveRef = useRef(props.onMoveCanvas)
  moveRef.current = props.onMoveCanvas
  const cardDrag = useCardDrag({ zoom: zoomRef, onMove: moveRef })
  // Reading order on the board; frozen while a card is dragged, because moving
  // its element in the DOM would end the drag (pointer capture is lost).
  const order = useRef<string[]>([])
  const ordered = useMemo(() => {
    const byPosition = [...props.canvases].sort((a, b) => a.y - b.y || a.x - b.x)
    if (!cardDrag.draggingId) {
      order.current = byPosition.map((canvas) => canvas.id)
      return byPosition
    }
    const rank = new Map(order.current.map((id, index) => [id, index]))
    return [...props.canvases].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }, [props.canvases, cardDrag.draggingId])
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const connect = useWireConnect({ viewport, view: viewRef, cards: orderedRef })
  const wireSelection = useWireSelection(wires, (wire) => latest.current.onRemoveLink(wire.targetId, wire.role!, wire.at))
  const selectedWireId = wireSelection.selectedWireId
  const setSelectedWireId = wireSelection.select

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
    const visible =
      left >= 0 && top >= FIT_PADDING.top - 24 && left + rect.w * current.zoom <= size.width && top + rect.h * current.zoom <= size.height
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

  // The 遮罩 tool only works on a canvas with a start picture.
  useEffect(() => {
    if (props.tool === 'mask' && !mask.enabled) props.onTool('select')
  }, [props.tool, mask.enabled, props.onTool])

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

  const boardPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = viewport.current?.getBoundingClientRect()
    return toBoardPoint(viewRef.current, clientX - (rect?.left ?? 0), clientY - (rect?.top ?? 0))
  }

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    // Pasting needs the board focused; a press anywhere that is not a control focuses it.
    if (!target.closest('button, input, textarea, select, a, [contenteditable="true"]')) viewport.current?.focus({ preventScroll: true })
    if (!target.closest('[data-wire], [data-wire-chip]')) setSelectedWireId(null)
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
    pointer.current = boardPoint(event.clientX, event.clientY)
    const gesture = pan.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.buttons === 0) {
      endPan()
      return
    }
    setView((current) => ({
      ...current,
      pan: { x: gesture.origin.x + event.clientX - gesture.x, y: gesture.origin.y + event.clientY - gesture.y },
    }))
  }

  const startCardDrag = (canvas: ProjectCanvas, event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || props.tool === 'pan') return
    cardDrag.start(canvas, event)
  }

  const importFiles = (list: FileList | null | undefined, at: { x: number; y: number }): boolean => {
    const files = [...(list ?? [])].filter(isImageFile)
    if (!files.length) return false
    props.onImportImages(files, at)
    return true
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (isTyping(event.target)) return
    const size = viewportSize()
    const at = pointer.current ?? toBoardPoint(viewRef.current, size.width / 2, size.height / 2)
    if (importFiles(event.clipboardData?.files, at)) event.preventDefault()
  }

  const pickFor = props.pickTarget ? props.canvases.find((canvas) => canvas.id === props.pickTarget!.canvasId) : undefined
  const pickState = (canvas: ProjectCanvas): 'ok' | 'inert' | undefined => {
    if (!props.pickTarget) return undefined
    return pickFor && hasPicture(canvas) && canConnect(props.canvases, canvas.id, pickFor).ok ? 'ok' : 'inert'
  }
  const pickRole = props.pickTarget
    ? props.pickTarget.role === 'control'
      ? `控制图 · ${controlKindLabel(props.pickTarget.kind ?? '')}`
      : roleLabel(props.pickTarget.role)
    : ''

  const menuTarget = connect.menu ? props.canvases.find((canvas) => canvas.id === connect.menu!.targetId) : undefined
  const menuSource = connect.menu ? props.canvases.find((canvas) => canvas.id === connect.menu!.sourceId) : undefined

  return (
    <div
      ref={viewport}
      tabIndex={-1}
      data-board
      data-panning={panning || undefined}
      className={cn(
        'relative h-full min-h-0 overflow-hidden bg-board outline-none',
        (panning || props.tool === 'pan') && 'cursor-grab',
        panning && 'cursor-grabbing',
      )}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onLostPointerCapture={(event) => {
        if (pan.current?.pointerId === event.pointerId) endPan()
      }}
      onAuxClick={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (importFiles(event.dataTransfer.files, boardPoint(event.clientX, event.clientY))) event.preventDefault()
      }}
      onPaste={onPaste}
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
        mask={mask}
      />
      {props.tool === 'mask' && mask.enabled ? (
        <MaskBar
          brush={brush}
          onBrush={setBrush}
          onClear={() => setMaskCommand((value) => ({ type: 'clear', n: (value?.n ?? 0) + 1 }))}
          onInvert={() => setMaskCommand((value) => ({ type: 'invert', n: (value?.n ?? 0) + 1 }))}
          onDone={() => props.onTool('select')}
        />
      ) : null}

      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
      >
        <WireLayer
          wires={wires}
          zoom={view.zoom}
          selectedWireId={selectedWireId}
          selectedCanvasId={props.selectedCanvasId}
          flowing={props.busyIds}
          draft={connect.draft}
          onSelect={(id) => {
            setSelectedWireId(id)
            props.onSelectRegion(null)
          }}
          onHover={setHoveredWire}
        />
        {ordered.map((canvas) => {
          const job = canvas.jobId ? props.jobs.find((item) => item.id === canvas.jobId) : undefined
          const busy = props.busyIds.has(canvas.id)
          const isSelected = canvas.id === props.selectedCanvasId
          const init = canvas.kind === 'layout' ? canvas.inputs?.init : undefined
          const initPath = init ? linkSourceImage(init.link, props.canvases) : null
          const showMask = Boolean(init && isSelected && (props.tool === 'mask' || canvas.inputs?.mask))
          const draft = connect.draft
          const pick = pickState(canvas)
          return (
            <CanvasCard
              key={canvas.id}
              canvas={canvas}
              view={cardJobView(canvas, job, props.jobs)}
              selected={isSelected}
              dragging={cardDrag.draggingId === canvas.id}
              tool={props.tool}
              regionKind={props.regionKind}
              selectedRegionId={props.selectedRegionId}
              rerun={rerunEligibility(canvas, { busy, submitting: props.submitting, update: props.update })}
              initPicture={initPath ? { path: initPath, resize: init?.resize, size: startPictureSize(canvas, props.canvases) } : null}
              mask={
                showMask
                  ? {
                      interactive: props.tool === 'mask' && mask.enabled,
                      brush,
                      command: maskCommand,
                      onSave: (png) => props.onSaveMask(canvas.id, png),
                    }
                  : null
              }
              hasOutput={hasPicture(canvas)}
              dropTarget={draft?.targetId === canvas.id ? (draft.ok ? 'ok' : 'no') : undefined}
              onPortDown={(event) => connect.start(canvas, event)}
              pick={pick}
              onSelect={() => {
                if (cardDrag.isDragTail()) return
                if (pick) {
                  if (pick === 'ok') props.onPick?.(canvas.id)
                  return
                }
                if (canvas.id !== props.selectedCanvasId) props.onSelectCanvas(canvas.id)
              }}
              onSelectRegion={props.onSelectRegion}
              onChangeLayers={(update) => props.onChangeLayers(canvas.id, update)}
              onRegionDrawn={(id) => {
                props.onSelectRegion(id)
                props.onTool('select')
              }}
              onOpenRegion={props.onOpenRegion}
              onDragStart={(event) => startCardDrag(canvas, event)}
              onOpenViewer={(index) => props.onOpenViewer(canvas.id, index)}
              onRerun={(seed) => props.onRerun(canvas.id, seed)}
              onCancel={() => {
                if (canvas.jobId) props.onCancel(canvas.jobId)
              }}
              onShowActivity={() => props.onShowActivity(canvas.jobId)}
              onCopy={() => props.onCopy(canvas)}
              onDelete={() => props.onDelete(canvas)}
            />
          )
        })}
        <WireChips
          wires={wires}
          zoom={view.zoom}
          selectedWireId={selectedWireId}
          hovered={hoveredWire}
          onHover={setHoveredWire}
          onSelect={(id) => {
            setSelectedWireId(id)
            props.onSelectRegion(null)
          }}
          onRemove={wireSelection.remove}
        />
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

      {props.pickTarget ? (
        <div
          role="status"
          data-board-ui
          data-pick-hint
          className="absolute left-1/2 top-[64px] z-20 -translate-x-1/2 rounded-full bg-raised px-3 py-1.5 text-caption text-ink shadow-float"
        >
          点一张有图片的卡片作为{pickRole} · Esc 取消
        </div>
      ) : null}
      {connect.menu && menuTarget ? (
        <LinkMenu
          title={`把「${menuSource?.title ?? '图片'}」接到「${menuTarget.title}」`}
          entries={linkMenu(menuTarget, connect.menu.sourceId, props.engineFeatures, props.controlAdapters)}
          at={connect.menu.at}
          bounds={viewportSize()}
          onClose={connect.closeMenu}
          onPick={(role, kind) => {
            const menu = connect.menu!
            props.onLink(menu.targetId, role, { canvasId: menu.sourceId }, kind)
            connect.closeMenu()
          }}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {selectedWireId ? `已选中连线 ${wires.find((wire) => wire.id === selectedWireId)?.label ?? ''}，按 Delete 断开` : ''}
      </span>
    </div>
  )
}
