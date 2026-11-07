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
import { CanvasCard, type CardMenuAction, type CardStrip } from './CanvasCard'
import { canConnect, newCanvasMenu } from './connect'
import { isImageFile } from './imageNodes'
import { cardJobView, type CardJobView } from './jobStatus'
import { LinkMenu } from './LinkMenu'
import { controlKindLabel, linkSourceImage, roleLabel, type LinkRole, type PickTarget } from './links'
import { BRUSH_DEFAULT, maskAvailability, startPictureSize } from './mask'
import type { MaskBrush, MaskCommand } from './MaskLayer'
import { rerunEligibility, type Blocker, type ReadinessInput } from './readiness'
import type { BoardTool } from './RegionLayer'
import { CardToolbar, MaskBar, Toolbar } from './Toolbar'
import { useCardDrag } from './useCardDrag'
import { useWireConnect } from './useWireConnect'
import { useWireSelection } from './useWireSelection'
import { InputAdder, InputThumbs, NewMenu, StartRow } from './BoardControls'
import type { PortActions } from './SlotMenu'
import { inputSlots, socketY } from './ports'
import { WireChips, WireLayer } from './WireLayer'
import { recipes, type Recipe } from './recipes'
import { upscaleProblem } from './nodes'
import {
  boardCanvases,
  canDropRun,
  canUnpin,
  filmstripOf,
  foldedRunIds,
  givesPicture,
  isActiveRun,
  pictureLink,
  runsOf,
  unpinRun,
  type StripItem,
} from './runs'
import { useRunDrag } from './useRunDrag'
import { boardPorts, type Point } from './wires'
import { OutputImage } from './OutputImage'

const FIT_PADDING = { top: 116, side: 48 }

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
  /** The 生成 footer's readiness: says why the mask tool and the link menu are off while the engine is not ready. */
  blockers: readonly Blocker[]
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
  /** What an empty input slot's menu does (add from the board or a file, choose a control adapter). */
  portActions: PortActions
  /** The model chip of a card: its short name, and whether it is ready to use. */
  describeModel?: (canvas: ProjectCanvas) => { label: string; ready: boolean } | null
  /** Text typed into a card's description on the board. */
  onChangeDescription: (canvasId: string, text: string) => void
  /** Show this filmstrip picture on its 画面's face (and give it to wires from there). */
  onShowOutput: (layoutId: string, link: CanvasImageLink) => void
  /** Pin a filmstrip run as a card of its own: under its 画面, or where it was dragged to. */
  onPinRun: (runId: string, at?: Point) => void
  /** Put a pinned result back into its 画面's filmstrip. */
  onUnpinRun: (runId: string) => void
  /** 用作起始图, or a wire dropped on the empty board: a new 画面 fed by this card's picture. */
  onNewFromPicture: (sourceId: string, role: 'init' | 'reference', at?: Point) => void
  /** 用这次的设置: the 画面 takes back the settings one of its runs was made with. */
  onUseRunSettings: (layoutId: string, runId: string) => void
  /** Remove one run from a 画面's filmstrip. */
  onDropRun: (runId: string) => void
  /** A recipe from the new-canvas tile: a 画面 wired to a picture the user chooses. */
  onRecipe: (recipe: Recipe) => void
  /** 放大: a 放大 node fed by this card's picture (to its right, or at a board point). */
  onUpscale: (sourceId: string, at?: Point) => void
  /** A new 风格 node from the new-canvas tile. */
  onAddStyle: () => void
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
  // Results folded into a 画面's filmstrip are not cards on the board.
  const folded = useMemo(() => foldedRunIds(props.canvases), [props.canvases])
  const cards = useMemo(() => boardCanvases(props.canvases, folded), [props.canvases, folded])
  const tileSize = selected && (selected.kind === 'layout' || selected.kind === 'result') ? selected : { width: 1024, height: 1024 }
  const newSpot = nextFreeSpot(cards, tileSize)
  const tileRect = { x: newSpot.x, y: newSpot.y, w: cardWidth(tileSize), h: CARD_HEADER + cardBodyHeight(tileSize) }

  const [hoveredWire, setHoveredWire] = useState<string | null>(null)
  /** The card under the pointer: its wires show their labels, and it shows its ＋. */
  const [hoveredCard, setHoveredCard] = useState<string | null>(null)
  const { engineFeatures, controlAdapters, blockers } = props
  const styleNodes = useMemo(() => props.canvases.filter((canvas) => canvas.kind === 'style'), [props.canvases])
  const hasStyles = styleNodes.length > 0
  const slotsFor = useCallback(
    (canvas: ProjectCanvas) => inputSlots(canvas, engineFeatures, controlAdapters, blockers, hasStyles),
    [engineFeatures, controlAdapters, blockers, hasStyles],
  )
  // Only linked inputs have a port on the card; empty ones are added through the card's ＋.
  const linkedSlotsFor = useCallback((canvas: ProjectCanvas) => slotsFor(canvas).filter((slot) => slot.linked), [slotsFor])
  const ports = useMemo(() => boardPorts(cards, view.zoom, linkedSlotsFor), [cards, view.zoom, linkedSlotsFor])
  const wires = ports.wires
  const slotsForRef = useRef(slotsFor)
  slotsForRef.current = slotsFor
  const mask = maskAvailability(selected, props.engineFeatures, props.blockers)

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
    const byPosition = [...cards].sort((a, b) => a.y - b.y || a.x - b.x)
    if (!cardDrag.draggingId) {
      order.current = byPosition.map((canvas) => canvas.id)
      return byPosition
    }
    const rank = new Map(order.current.map((id, index) => [id, index]))
    return [...cards].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  }, [cards, cardDrag.draggingId])
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const connect = useWireConnect({
    viewport,
    view: viewRef,
    cards: orderedRef,
    slotsFor: slotsForRef,
    onSlotDrop: (targetId, sourceId, drop) => latest.current.onLink(targetId, drop.role, { canvasId: sourceId }, drop.kind),
  })
  // An empty slot's menu acts on its card: select it first, as the inputs panel does.
  const portActions: PortActions = {
    ...props.portActions,
    onPick: (canvasId, role, kind) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onPick(canvasId, role, kind)
    },
    onAddFromFile: (canvasId, role, kind) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onAddFromFile(canvasId, role, kind)
    },
    onAddFromGallery: (canvasId, role, kind) => {
      if (canvasId !== latest.current.selectedCanvasId) latest.current.onSelectCanvas(canvasId)
      latest.current.portActions.onAddFromGallery(canvasId, role, kind)
    },
  }
  const showRef = useRef((layoutId: string, item: StripItem) =>
    latest.current.onShowOutput(layoutId, item.output ? { canvasId: item.runId, output: item.output } : { canvasId: item.runId }),
  )
  // A thumbnail let go outside its 画面 becomes a card where it was dropped.
  const dropRef = useRef((layoutId: string, item: StripItem, at: Point) => {
    const list = latest.current.canvases
    const layout = list.find((canvas) => canvas.id === layoutId)
    const run = list.find((canvas) => canvas.id === item.runId)
    if (!layout || !run || run.kind !== 'result') return
    const rect = cardRect(layout)
    if (at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h) return
    latest.current.onPinRun(run.id, { x: at.x - cardWidth(run) / 2, y: at.y - CARD_HEADER / 2 })
  })
  const runDrag = useRunDrag({ viewport, view: viewRef, onShow: showRef, onDrop: dropRef })
  const wireSelection = useWireSelection(wires, (wire) => latest.current.onRemoveLink(wire.targetId, wire.role!, wire.at))
  const selectedWireId = wireSelection.selectedWireId
  const setSelectedWireId = wireSelection.select

  const fit = useCallback(() => {
    const size = viewportSize()
    if (!size.width || !size.height) return
    const list = boardCanvases(latest.current.canvases)
    const choice = list.find((canvas) => canvas.id === latest.current.selectedCanvasId) ?? { width: 1024, height: 1024 }
    const spot = nextFreeSpot(list, choice)
    const extra = { x: spot.x, y: spot.y, w: cardWidth(choice), h: CARD_HEADER + cardBodyHeight(choice) }
    setView(fitView(size, boardBounds(list, extra), FIT_PADDING))
  }, [])

  const reveal = useCallback((canvasId: string) => {
    const list = latest.current.canvases
    const found = list.find((item) => item.id === canvasId)
    // A run in a filmstrip shows on its 画面.
    const canvas = found && foldedRunIds(list).has(found.id) ? list.find((item) => item.id === found.sourceCanvasId) : found
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
    return pickFor && givesPicture(canvas, props.canvases) && canConnect(props.canvases, canvas.id, pickFor).ok ? 'ok' : 'inert'
  }
  const pickRole = props.pickTarget
    ? props.pickTarget.role === 'control'
      ? `控制图 · ${controlKindLabel(props.pickTarget.kind ?? '')}`
      : roleLabel(props.pickTarget.role)
    : ''

  const menuSource = connect.menu ? props.canvases.find((canvas) => canvas.id === connect.menu!.sourceId) : undefined

  // 放大 is offered when the engine takes a start picture and the picture can still grow.
  const canUpscale = (canvas: ProjectCanvas): boolean =>
    props.engineFeatures?.imageInput !== false && !upscaleProblem(props.canvases, pictureLink(props.canvases, { canvasId: canvas.id }))
  // The ⋯ menu of a card: what can be done with the picture it shows.
  const cardActions = (canvas: ProjectCanvas, run: ProjectCanvas, item: StripItem | undefined): CardMenuAction[] => {
    const actions: CardMenuAction[] = []
    if (canvas.kind === 'layout') {
      if (!item) return actions
      if (item.path) actions.push({ label: '用作起始图', onSelect: () => props.onNewFromPicture(canvas.id, 'init') })
      if (item.path && canUpscale(canvas)) actions.push({ label: '放大', onSelect: () => props.onUpscale(canvas.id) })
      if (folded.has(run.id) && item.path) actions.push({ label: '固定到画板', onSelect: () => props.onPinRun(run.id) })
      if (run.kind === 'result') actions.push({ label: '用这次的设置', onSelect: () => props.onUseRunSettings(canvas.id, run.id) })
      // A run that is also a card is deleted from its card.
      if (!isActiveRun(run, props.jobs) && canDropRun(props.canvases, run.id))
        actions.push({ label: '删除这次生成', tone: 'danger', onSelect: () => props.onDropRun(run.id) })
      return actions
    }
    if (givesPicture(canvas, props.canvases)) {
      actions.push({ label: '用作起始图', onSelect: () => props.onNewFromPicture(canvas.id, 'init') })
      if (canUpscale(canvas)) actions.push({ label: '放大', onSelect: () => props.onUpscale(canvas.id) })
    }
    // A pinned result goes back into its 画面's filmstrip, unless it feeds another canvas.
    if (canUnpin(canvas, props.canvases) && foldedRunIds(unpinRun(props.canvases, canvas.id)).has(canvas.id)) {
      const source = props.canvases.find((item) => item.id === canvas.sourceCanvasId)
      actions.push({ label: `收回到「${source?.title ?? '画面'}」`, onSelect: () => props.onUnpinRun(canvas.id) })
    }
    return actions
  }
  const recipeList = recipes(props.engineFeatures, props.controlAdapters, props.blockers)
  // Wire labels show for the cards being looked at: the selected one and the one under the pointer.
  const focusIds = new Set([props.selectedCanvasId, hoveredCard].filter((id): id is string => Boolean(id)))
  // The ＋ that adds an input: on the hovered or selected 画面, below its linked inputs.
  const adderCanvas =
    connect.draft || props.pickTarget ? undefined : cards.find((canvas) => canvas.id === (hoveredCard ?? props.selectedCanvasId))
  const adderSlots = adderCanvas?.kind === 'layout' ? slotsFor(adderCanvas).filter((slot) => !slot.linked) : []
  const adderPorts = adderCanvas
    ? wires.filter((wire) => wire.kind === 'input' && wire.targetId === adderCanvas.id).map((wire) => wire.to.y)
    : []
  const adderFor =
    adderCanvas && adderSlots.length
      ? {
          canvas: adderCanvas,
          slots: adderSlots,
          point: {
            x: adderCanvas.x,
            y: adderPorts.length
              ? Math.max(...adderPorts) + 30 / Math.max(0.01, view.zoom)
              : adderCanvas.y + CARD_HEADER + cardBodyHeight(adderCanvas) / 2,
          },
        }
      : null
  // An empty project: one blank 画面, with the ways to start from a picture under it.
  const only = cards.length === 1 ? cards[0]! : null
  const startFor =
    only && only.kind === 'layout' && !only.inputs && !only.jobState && !only.outputs?.length && !runsOf(only, props.canvases).length
      ? only
      : null
  const dragged = runDrag.drag
  // The card a wire is aimed at shows its sockets; its linked inputs' thumbnails and labels step aside.
  const aimedId = connect.draft?.zones ? connect.draft.targetId : undefined
  const labelled = aimedId ? wires.filter((wire) => wire.kind !== 'input' || wire.targetId !== aimedId) : wires

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
      <Toolbar tool={props.tool} onTool={props.onTool} zoom={view.zoom} onZoom={zoomBy} onFit={fit} />
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
          const viewOf = (run: ProjectCanvas): CardJobView =>
            cardJobView(run, run.jobId ? props.jobs.find((item) => item.id === run.jobId) : undefined, props.jobs)
          // A 画面 shows the run picked in its filmstrip: its picture, progress and job.
          const film = canvas.kind === 'layout' ? filmstripOf(canvas, props.canvases) : null
          const item = film ? film.items[film.shown] : undefined
          const shownRun = (item && film?.runs.find((run) => run.id === item.runId)) || canvas
          const views = new Map<string, CardJobView>(film?.runs.map((run) => [run.id, viewOf(run)]) ?? [])
          const strip: CardStrip | null =
            film && item
              ? {
                  items: film.items,
                  shown: film.shown,
                  views,
                  onShow: (index) => showRef.current(canvas.id, film.items[index]!),
                  onOpen: (index) => props.onOpenViewer(film.items[index]!.runId, film.items[index]!.output),
                  onPointerDown: (index, event) => runDrag.start(canvas.id, film.items[index]!, event),
                }
              : null
          const jobId = shownRun.jobId
          const busy = props.busyIds.has(canvas.id)
          const isSelected = canvas.id === props.selectedCanvasId
          const init = canvas.kind === 'layout' ? canvas.inputs?.init : undefined
          const initPath = init ? linkSourceImage(init.link, props.canvases) : null
          const showMask = Boolean(init && isSelected && (props.tool === 'mask' || canvas.inputs?.mask))
          const draft = connect.draft
          const pick = pickState(canvas)
          const zones = draft?.targetId === canvas.id ? draft.zones : undefined
          // While a wire is dragged, cards that cannot take it step back.
          const inert = Boolean(draft && canvas.id !== draft.sourceId && !canConnect(props.canvases, draft.sourceId, canvas).ok)
          return (
            <CanvasCard
              key={canvas.id}
              onHoverChange={(on: boolean) => setHoveredCard((current) => (on ? canvas.id : current === canvas.id ? null : current))}
              inert={inert}
              canvas={canvas}
              view={views.get(shownRun.id) ?? viewOf(shownRun)}
              strip={strip}
              jobId={jobId}
              menuActions={cardActions(canvas, shownRun, item)}
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
              // A 风格 always offers its wire; a picture card once it has a picture.
              hasOutput={canvas.kind === 'style' || givesPicture(canvas, props.canvases)}
              styleUsers={
                canvas.kind === 'style'
                  ? props.canvases.filter(
                      (item) => item.kind === 'layout' && item.inputs?.styles?.links.some((link) => link.canvasId === canvas.id),
                    ).length
                  : undefined
              }
              model={canvas.kind === 'layout' ? (props.describeModel?.(canvas) ?? null) : null}
              onChangeDescription={(text) => props.onChangeDescription(canvas.id, text)}
              dropZones={
                zones
                  ? {
                      items: zones.slots.map((slot, index) => {
                        const drop = zones.drops[index]!
                        const y = socketY(canvas, index, zones.slots.length, view.zoom) - canvas.y - CARD_HEADER
                        return { label: slot.label, ok: drop.ok, reason: drop.ok ? undefined : drop.reason, y }
                      }),
                      active: zones.active,
                      scale: 1 / Math.max(0.01, view.zoom),
                    }
                  : draft?.targetId === canvas.id
                    ? { items: [], active: -1, scale: 1 }
                    : undefined
              }
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
              onOpenViewer={(index) => props.onOpenViewer(shownRun.id, index)}
              onRerun={(seed) => props.onRerun(canvas.id, seed)}
              onCancel={() => {
                if (jobId) props.onCancel(jobId)
              }}
              onShowActivity={() => props.onShowActivity(jobId)}
              onCopy={() => props.onCopy(canvas)}
              onDelete={() => props.onDelete(canvas)}
            />
          )
        })}
        <InputThumbs wires={labelled} canvases={props.canvases} zoom={view.zoom} />
        {selected && selected.kind === 'layout' && !selected.upscale && !connect.draft ? (
          // A 画面's tools sit on the selected card, above its title.
          <div
            className="absolute left-0 top-0 z-[7] origin-top-left"
            style={{
              transform: `translate(${selected.x}px, ${selected.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(0, calc(-100% - 6px))`,
            }}
          >
            <CardToolbar
              tool={props.tool}
              onTool={props.onTool}
              regionKind={props.regionKind}
              onRegionKind={props.onRegionKind}
              underlay={selected.backgroundPath}
              onUnderlay={props.onUnderlay}
              mask={mask}
            />
          </div>
        ) : null}
        <WireChips
          wires={labelled}
          zoom={view.zoom}
          focus={focusIds}
          selectedWireId={selectedWireId}
          hovered={hoveredWire}
          onHover={setHoveredWire}
          onSelect={(id) => {
            setSelectedWireId(id)
            props.onSelectRegion(null)
          }}
          onRemove={wireSelection.remove}
        />
        {adderFor ? (
          <InputAdder
            canvasId={adderFor.canvas.id}
            title={adderFor.canvas.title}
            slots={adderFor.slots}
            point={adderFor.point}
            zoom={view.zoom}
            adapters={props.controlAdapters}
            styles={styleNodes}
            actions={portActions}
            onHoverChange={(on: boolean) =>
              setHoveredCard((current) => (on ? adderFor.canvas.id : current === adderFor.canvas.id ? null : current))
            }
          />
        ) : null}
        {/* A refusal that is not a drop zone's (a zone says its own) shows by the pointer. */}
        {connect.draft && !connect.draft.ok && connect.draft.reason && !connect.draft.zones ? (
          <div
            role="status"
            data-wire-refused
            className="pointer-events-none absolute left-0 top-0 z-[7] origin-top-left whitespace-nowrap rounded-full bg-raised px-2.5 py-1 text-caption text-ink shadow-float"
            style={{
              transform: `translate(${connect.draft.to.x}px, ${connect.draft.to.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(12px, 12px)`,
            }}
          >
            {connect.draft.reason}
          </div>
        ) : null}
        <NewMenu
          point={{ x: tileRect.x, y: tileRect.y + CARD_HEADER + Math.min(cardBodyHeight(tileSize), 256) / 2 }}
          zoom={view.zoom}
          recipes={recipeList}
          onAddCanvas={props.onAddCanvas}
          onAddStyle={props.onAddStyle}
          onRecipe={props.onRecipe}
        />
        {startFor ? (
          <StartRow
            point={{ x: startFor.x, y: startFor.y + cardRect(startFor).h + 12 / view.zoom }}
            zoom={view.zoom}
            recipes={recipeList}
            onRecipe={props.onRecipe}
          />
        ) : null}
        {dragged?.item.path ? (
          <div
            aria-hidden="true"
            data-run-drag
            className="pointer-events-none absolute left-0 top-0 z-[8] size-16 origin-top-left overflow-hidden rounded-md bg-well-strong shadow-float"
            style={{
              transform: `translate(${dragged.at.x}px, ${dragged.at.y}px) scale(${1 / Math.max(0.01, view.zoom)}) translate(-50%, -50%)`,
            }}
          >
            <OutputImage path={dragged.item.path} alt="" />
          </div>
        ) : null}
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
      {connect.menu ? (
        <LinkMenu
          title={`用「${menuSource?.title ?? '图片'}」新建画面`}
          entries={newCanvasMenu(props.engineFeatures, props.blockers)}
          at={connect.menu.at}
          bounds={viewportSize()}
          onClose={connect.closeMenu}
          onPick={(role, kind) => {
            const menu = connect.menu!
            const at = { x: menu.point.x, y: menu.point.y - CARD_HEADER }
            if (kind === 'upscale') props.onUpscale(menu.sourceId, at)
            else if (role === 'init' || role === 'reference') props.onNewFromPicture(menu.sourceId, role, at)
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
