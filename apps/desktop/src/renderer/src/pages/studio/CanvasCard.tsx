import { ChevronRight, Copy, Image as ImageIcon, MoreHorizontal, Palette, PenLine, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ImageResizeMode, ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { Button, IconButton, Pill, cn } from '../../components/ui'
import { MenuItem, Popover } from '../../components/common/Popover'
import { cloverUrl } from '../../lib/clover'
import type { LinkRole } from './links'
import { OutputImage } from './OutputImage'
import { CARD_FOOTER, CARD_HEADER, cardBodyHeight, cardWidth } from './boardLayout'
import { LivePreview, ProgressStrip, StatusOverlay } from './CardStatus'
import type { CardJobView } from './jobStatus'
import { MaskLayer, usePictureSize, type MaskBrush, type MaskCommand } from './MaskLayer'
import type { Size } from './mask'
import type { RerunCheck } from './readiness'
import { canvasDescription } from './prompt'
import { Filmstrip } from './Filmstrip'
import { RegionLayer, type BoardTool } from './RegionLayer'
import type { StripItem } from './runs'
import { StartPicture } from './StartPicture'

export interface CardMask {
  interactive: boolean
  brush: MaskBrush
  command?: MaskCommand
  onSave: (png: Uint8Array | null) => void
}

/** A 画面's filmstrip: its pictures, the one on its face, and how each run is doing. */
export interface CardStrip {
  items: readonly StripItem[]
  shown: number
  views: ReadonlyMap<string, CardJobView>
  onShow: (index: number) => void
  /** Open the viewer at this picture (double-click a thumbnail). */
  onOpen: (index: number) => void
  /** A press on a thumbnail: a click shows it, a drag onto the board pins it (see Board). */
  onPointerDown: (index: number, event: React.PointerEvent<HTMLButtonElement>) => void
}

export interface CardMenuAction {
  label: string
  onSelect: () => void
  tone?: 'danger'
}

export interface CanvasCardProps {
  canvas: ProjectCanvas
  view: CardJobView
  selected: boolean
  dragging: boolean
  tool: BoardTool
  regionKind: ProjectLayerKind
  selectedRegionId: string | null
  rerun: RerunCheck
  /** The linked start picture, drawn as the backdrop of a layout canvas. */
  initPicture?: { path: string; resize?: ImageResizeMode; size: Size | null } | null
  /** The mask painted over the start picture; absent when there is none to show. */
  mask?: CardMask | null
  /** The card has a picture to give: show its output port. */
  hasOutput: boolean
  /**
   * A 画面's filmstrip, once it has run. `view` is then the shown run's, and
   * the face shows the picture picked in the strip.
   */
  strip?: CardStrip | null
  /** The job of the run the card shows (a 画面's filmstrip pick); default: its own. */
  jobId?: string
  /** A 风格 card: how many 画面 use it. */
  styleUsers?: number
  /** Entries of the ⋯ menu: 用作起始图, 固定到画板 and so on (danger ones next to 删除). */
  menuActions?: readonly CardMenuAction[]
  /**
   * While a wire is out and this card can take it: the inputs it could fill,
   * one socket each on the left edge, top to bottom; `active` is the one the
   * wire is at (-1: none). `y` is board pixels from the top of the picture;
   * `scale` keeps the sockets at screen size. `ghost` previews the picture.
   */
  dropZones?: {
    items: { label: string; role: LinkRole; ok: boolean; reason?: string; y: number }[]
    active: number
    scale: number
    ghost?: string | null
  }
  /** A wire is being dragged that this card cannot take: it steps back. */
  inert?: boolean
  /** A wire is out (from any card): handles stop taking presses. */
  connecting?: boolean
  /** This card's own wire is out: its handle stays lit. */
  wireOut?: boolean
  onHoverChange?: (on: boolean) => void
  /** The model this canvas generates with, for its chip; null on cards that do not generate. */
  model?: { label: string; ready: boolean } | null
  onPortDown: (event: React.PointerEvent<HTMLElement>) => void
  /** The description typed on the card itself (double-click the empty face). */
  onChangeDescription?: (text: string) => void
  onSelect: () => void
  onSelectRegion: (id: string | null) => void
  onChangeLayers: (update: (layers: ProjectLayer[]) => ProjectLayer[]) => void
  onRegionDrawn: (id: string) => void
  onOpenRegion: (id: string) => void
  onDragStart: (event: React.PointerEvent<HTMLElement>) => void
  onOpenViewer: (index: number) => void
  onRerun: (seed: 'new' | 'same') => void
  onCancel: () => void
  onShowActivity: () => void
  onCopy: () => void
  onDelete: () => void
}

/**
 * The description, written on the card's empty face; double-click to edit it
 * there. The left panel keeps the full editor.
 */
function FaceDescription({
  text,
  editing,
  invite,
  onDone,
}: {
  text: string
  editing: boolean
  /** Show that an empty face can be written on (the card is selected). */
  invite: boolean
  onDone: (text: string | null) => void
}): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) return
    const element = field.current
    element?.focus()
    element?.setSelectionRange(element.value.length, element.value.length)
  }, [editing])
  if (editing) {
    return (
      <textarea
        ref={field}
        data-face-editor
        aria-label="描述"
        defaultValue={text}
        placeholder="想要什么样的画面？"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={(event) => onDone(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            onDone(null)
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="absolute inset-2 z-[3] resize-none rounded-md bg-raised p-2 text-caption leading-snug text-ink outline-none placeholder:text-ink-3"
      />
    )
  }
  if (!text.trim()) {
    // Nothing to read on an empty face; a selected one shows it can be written on (double-click).
    return invite ? (
      <span data-face-description="" className="pointer-events-none absolute inset-0 z-[1] grid place-items-center text-ink-2">
        <PenLine className="size-5" aria-label="双击写描述" strokeWidth={1.6} />
      </span>
    ) : (
      <span data-face-description="" hidden />
    )
  }
  return (
    <p
      data-face-description
      // Ink, not ink-2: the empty face is well-strong, where ink-2 falls below 4.5:1 in the light theme.
      className="pointer-events-none absolute inset-x-3 top-2.5 z-[1] line-clamp-4 text-caption leading-snug text-ink"
    >
      {text}
    </p>
  )
}

/** A layout canvas's settings stay in the panel; the card only shows a model that cannot be used. */
function ModelWarning({ model }: { model?: { label: string; ready: boolean } | null }): React.JSX.Element | null {
  if (!model || model.ready) return null
  return (
    <div data-card-chips className="flex min-w-0 flex-1 items-center overflow-hidden">
      <Pill tone="warn" className="min-w-0 shrink">
        <span className="truncate">{model.label}</span>
      </Pill>
    </div>
  )
}

/** What each kind of input looks like as a socket. */
const SOCKET_ICONS: Record<LinkRole, typeof ImageIcon> = {
  init: ImageIcon,
  control: SlidersHorizontal,
  reference: Copy,
  style: Palette,
}

/**
 * One canvas on the board: title and state above the picture, the picture
 * (regions, live progress, results or an imported image), and the results
 * row below. The output port on the right edge starts a wire.
 */
export function CanvasCard(props: CanvasCardProps): React.JSX.Element {
  const { canvas, view, selected } = props
  // A 画面 acts on the job of the run it shows.
  const jobId = props.jobId ?? canvas.jobId
  const [shown, setShown] = useState(0)
  const width = cardWidth(canvas)
  const bodyHeight = cardBodyHeight(canvas)
  const isImage = canvas.kind === 'image'
  const isStyle = canvas.kind === 'style'
  // A 放大 redraws its 原图: it has no regions of its own.
  const drawsRegions = canvas.kind === 'layout' && !canvas.upscale
  const outputs = isImage || isStyle ? [] : view.outputs
  const strip = props.strip?.items.length ? props.strip : null
  const stripItem = strip ? strip.items[strip.shown] : undefined
  const faceIndex = stripItem ? stripItem.output : shown
  const current = outputs[Math.min(faceIndex, Math.max(0, outputs.length - 1))]
  const editable = drawsRegions && selected && !view.active
  const showRegions = drawsRegions && (selected || outputs.length === 0)
  const maxThumbs = Math.max(1, Math.floor((width - 116) / 42))
  const preview = view.active ? view.preview : undefined
  // While painting the mask, the start picture shows even over earlier results.
  const painting = Boolean(props.mask?.interactive && props.initPicture)
  const pictureSize = usePictureSize(props.mask ? props.initPicture?.path : undefined, props.initPicture?.size ?? null)
  const [editing, setEditing] = useState(false)
  // An empty face (nothing generated, no start picture or underlay) shows the description instead.
  // A 风格 always shows its description.
  const blankFace =
    isStyle ||
    (canvas.kind === 'layout' && !preview && !current && !painting && !props.initPicture && !canvas.backgroundPath && !view.active)
  // The header speaks only while something is happening or went wrong.
  const loud = view.active || view.state === 'failed' || view.state === 'lost'
  const statusLabel = isImage || isStyle || !loud ? '' : view.label
  // Buttons and the filmstrip show on hover, focus or selection; a model that cannot be used always shows.
  const modelProblem = canvas.kind === 'layout' && !strip && !view.active && props.model && !props.model.ready
  const quietFooter = !selected && !modelProblem

  return (
    <article
      data-canvas-card={canvas.id}
      data-canvas-kind={canvas.kind}
      data-node={canvas.upscale ? 'upscale' : undefined}
      aria-label={`${canvas.title}${selected ? '，已选中' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      onPointerEnter={() => props.onHoverChange?.(true)}
      onPointerLeave={() => props.onHoverChange?.(false)}
      className={cn('group/card absolute flex flex-col transition-opacity', props.inert && 'opacity-40', props.dragging && 'z-10')}
      style={{ left: canvas.x, top: canvas.y, width }}
    >
      <header
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest('button')) props.onDragStart(event)
        }}
        className={cn('flex touch-none select-none items-center gap-2 text-caption', props.dragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ height: CARD_HEADER }}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            props.onSelect()
          }}
          className="min-w-0 truncate text-left font-semibold text-ink"
        >
          {canvas.title}
        </button>
        <span className={cn('tabular min-w-0 flex-1 truncate text-right', view.state === 'failed' ? 'text-danger' : 'text-ink-2')}>
          {statusLabel}
        </span>
        {/* A menu choice acts on its own; the click must not reach the card and select it again. */}
        <div className="contents" onClick={(event) => event.stopPropagation()}>
          <Popover
            align="end"
            label={`${canvas.title} 操作`}
            trigger={(menu) => (
              <IconButton
                label={`${canvas.title} 更多操作`}
                className={cn(
                  '-mr-1.5 size-6',
                  !selected && 'opacity-0 focus-visible:opacity-100 [article:hover_&]:opacity-100',
                  menu.open && 'opacity-100',
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  menu.toggle()
                }}
                aria-expanded={menu['aria-expanded']}
                aria-haspopup="menu"
              >
                <MoreHorizontal className="size-4" strokeWidth={1.6} />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                {props.menuActions
                  ?.filter((action) => action.tone !== 'danger')
                  .map((action) => (
                    <MenuItem
                      key={action.label}
                      tone={action.tone}
                      onSelect={() => {
                        close()
                        action.onSelect()
                      }}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                <MenuItem
                  onSelect={() => {
                    close()
                    props.onCopy()
                  }}
                >
                  {isImage || isStyle ? '复制' : '复制为新画面'}
                </MenuItem>
                {jobId && !isImage ? (
                  <MenuItem
                    onSelect={() => {
                      close()
                      props.onShowActivity()
                    }}
                  >
                    查看详情
                  </MenuItem>
                ) : null}
                {props.menuActions
                  ?.filter((action) => action.tone === 'danger')
                  .map((action) => (
                    <MenuItem
                      key={action.label}
                      tone="danger"
                      onSelect={() => {
                        close()
                        action.onSelect()
                      }}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                <MenuItem
                  tone="danger"
                  onSelect={() => {
                    close()
                    props.onDelete()
                  }}
                >
                  {isImage ? '删除' : isStyle ? '删除风格' : '删除画面'}
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </header>

      <div
        data-card-body
        className={cn(
          'relative overflow-hidden rounded-md bg-well-strong transition-shadow',
          selected && 'ring-2 ring-accent ring-offset-2 ring-offset-board',
          view.active && !preview && 'studio-card-running',
        )}
        style={{ height: bodyHeight }}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement
          const onRegion = Boolean(target.closest('[data-region-id]'))
          // A press on the picture outside every region clears the region selection.
          if (editable && !onRegion) props.onSelectRegion(null)
          // The picture moves its card, as the title row does.
          if (props.tool === 'select' && !painting && !editing && !onRegion && !target.closest('textarea, input, [data-board-ui]'))
            props.onDragStart(event)
        }}
        onDoubleClick={(event) => {
          if (!blankFace || props.tool !== 'select' || !props.onChangeDescription) return
          if ((event.target as HTMLElement).closest('[data-region-id]')) return
          event.stopPropagation()
          if (!selected) props.onSelect()
          setEditing(true)
        }}
      >
        {preview ? (
          <LivePreview path={preview.path} seq={preview.seq} alt={`${canvas.title} 的实时预览`} />
        ) : painting && props.initPicture ? (
          <StartPicture path={props.initPicture.path} resize={props.initPicture.resize} canvas={canvas} />
        ) : current ? (
          <button
            type="button"
            aria-label={`查看 ${canvas.title} 的结果`}
            onDoubleClick={() => props.onOpenViewer(Math.min(faceIndex, outputs.length - 1))}
            onClick={(event) => {
              if (!selected) return
              event.stopPropagation()
              props.onOpenViewer(Math.min(faceIndex, outputs.length - 1))
            }}
            className="absolute inset-0 block cursor-zoom-in"
          >
            <OutputImage path={current.path} alt={canvas.title} />
          </button>
        ) : isImage && canvas.imagePath ? (
          <OutputImage path={canvas.imagePath} alt={canvas.title} className="absolute inset-0" />
        ) : props.initPicture ? (
          <StartPicture path={props.initPicture.path} resize={props.initPicture.resize} canvas={canvas} />
        ) : canvas.backgroundPath ? (
          <img src={cloverUrl(canvas.backgroundPath)} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
        ) : null}

        {props.mask && pictureSize && !preview && (painting || !current) ? (
          <MaskLayer
            canvas={canvas}
            picture={pictureSize}
            mode={props.initPicture?.resize}
            interactive={props.mask.interactive}
            brush={props.mask.brush}
            command={props.mask.command}
            onSave={props.mask.onSave}
          />
        ) : null}

        {blankFace ? (
          <FaceDescription
            text={canvasDescription(canvas)}
            editing={editing}
            invite={selected}
            onDone={(text) => {
              setEditing(false)
              if (text !== null && text !== canvasDescription(canvas)) props.onChangeDescription?.(text)
            }}
          />
        ) : null}

        {showRegions && !preview ? (
          <RegionLayer
            canvas={canvas}
            interactive={editable && props.tool !== 'mask'}
            tool={props.tool}
            regionKind={props.regionKind}
            selectedRegionId={props.selectedRegionId}
            onSelectRegion={props.onSelectRegion}
            onChangeLayers={props.onChangeLayers}
            onRegionDrawn={props.onRegionDrawn}
            onOpenRegion={props.onOpenRegion}
          />
        ) : null}

        {isImage || isStyle ? null : <StatusOverlay view={view} hasPicture={Boolean(preview)} />}
        {view.active && (view.phase === 'denoise' || view.phase === 'decode' || view.phase === 'save' || view.phase === 'text') ? (
          <ProgressStrip percent={view.phase === 'denoise' ? view.percent : undefined} />
        ) : null}

        {strip && strip.items.length > 1 && !selected ? (
          // How many pictures the filmstrip holds; the strip itself shows when the card is selected.
          <span
            data-strip-count
            aria-label={`共 ${strip.items.length} 张`}
            className="tabular pointer-events-none absolute bottom-1.5 right-1.5 z-[2] rounded-full bg-raised px-1.5 text-micro font-medium text-ink shadow-float"
          >
            {strip.items.length}
          </span>
        ) : null}
        {props.dropZones ? (
          // While a wire is out, the face steps back behind the sockets; the one the wire is at previews the picture.
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[4]">
            {props.dropZones.ghost ? <OutputImage path={props.dropZones.ghost} alt="" className="opacity-60" /> : null}
            <div className="absolute inset-0 bg-board opacity-55" />
          </div>
        ) : null}
      </div>

      {props.dropZones ? (
        <div data-drop-zones className="pointer-events-none absolute left-0 z-[6]" style={{ top: CARD_HEADER, height: bodyHeight }}>
          {props.dropZones.items.map((zone, index) => {
            const on = index === props.dropZones!.active
            const Icon = SOCKET_ICONS[zone.role]
            return (
              <div
                key={`${zone.label}-${index}`}
                data-drop-zone={zone.label}
                data-active={on || undefined}
                className={cn(
                  'absolute left-0 top-0 flex origin-top-left items-center gap-2 whitespace-nowrap text-caption',
                  zone.ok ? 'text-ink' : 'text-ink-2',
                  on && zone.ok && 'font-semibold',
                )}
                style={{ transform: `translate(0, ${zone.y}px) scale(${props.dropZones!.scale}) translate(-14px, -50%)` }}
              >
                <span
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full shadow-float transition-colors',
                    on && zone.ok ? 'bg-accent text-on-accent' : 'bg-raised',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" strokeWidth={1.8} />
                </span>
                {zone.label}
                {/* Why not, only for the socket the wire is at. */}
                {on && !zone.ok && zone.reason ? <span className="font-normal text-ink-2">· {zone.reason}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {props.hasOutput ? (
        // The whole right edge pulls out a wire, not only its dot.
        <div
          aria-hidden="true"
          data-board-ui
          data-output-edge={canvas.id}
          className={cn('absolute z-[5] cursor-crosshair touch-none', props.connecting && 'pointer-events-none')}
          style={{ left: width - 8, top: CARD_HEADER, width: 16, height: bodyHeight }}
          onPointerDown={(event) => {
            event.stopPropagation()
            props.onPortDown(event)
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      {props.hasOutput ? (
        <button
          type="button"
          data-board-ui
          data-output-port={canvas.id}
          aria-label={`从 ${canvas.title} 拉出连线`}
          onPointerDown={(event) => {
            event.stopPropagation()
            props.onPortDown(event)
          }}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'group/port absolute z-[5] flex size-7 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none items-center justify-center rounded-full',
            props.connecting && 'pointer-events-none',
          )}
          style={{ left: width, top: CARD_HEADER + bodyHeight / 2 }}
        >
          {/* Every picture carries its handle; it lights up under the pointer and while its wire is out. */}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-5 items-center justify-center rounded-full shadow-float transition-colors',
              props.wireOut
                ? 'bg-accent text-on-accent'
                : 'bg-raised text-ink-2 group-hover/port:bg-accent group-hover/port:text-on-accent',
            )}
          >
            <ChevronRight className="size-3" strokeWidth={2.2} />
          </span>
        </button>
      ) : null}

      <footer
        className={cn(
          'flex items-center gap-1.5 transition-opacity',
          quietFooter &&
            'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100',
        )}
        style={{ height: CARD_FOOTER }}
      >
        {isImage || isStyle ? null : view.active ? (
          <div className="tabular flex min-w-0 flex-1 items-center gap-2 text-caption">
            <span data-card-progress className="min-w-0 flex-1 truncate text-ink">
              {view.detail}
            </span>
            <Button
              tone="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                props.onShowActivity()
              }}
            >
              查看详情
            </Button>
            {jobId ? (
              <Button
                tone="ghost"
                size="xs"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onCancel()
                }}
              >
                取消
              </Button>
            ) : null}
          </div>
        ) : strip ? (
          <>
            <Filmstrip
              items={strip.items}
              shown={strip.shown}
              views={strip.views}
              max={strip.items.length > maxThumbs ? Math.max(1, maxThumbs - 1) : maxThumbs}
              onShow={strip.onShow}
              onOpen={strip.onOpen}
              onPointerDown={strip.onPointerDown}
            />
            <span className="flex-1" />
            {view.state === 'failed' ? (
              <Button
                size="xs"
                aria-label={`重试 ${canvas.title}`}
                disabled={!props.rerun.ok}
                title={props.rerun.reason}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onRerun('same')
                }}
              >
                重试
              </Button>
            ) : (
              <>
                <Button
                  size="xs"
                  disabled={!props.rerun.ok}
                  title={props.rerun.reason}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onRerun('new')
                  }}
                >
                  换个种子
                </Button>
                <Button
                  size="xs"
                  aria-label={`重新生成 ${canvas.title}`}
                  disabled={!props.rerun.ok}
                  title={props.rerun.reason ?? '用现在的设置和这张图的种子再生成一次'}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onRerun('same')
                  }}
                >
                  重新生成
                </Button>
              </>
            )}
          </>
        ) : outputs.length > 0 ? (
          <>
            {outputs.slice(0, maxThumbs).map((output, index) => (
              <button
                key={output.path}
                type="button"
                aria-label={`第 ${index + 1} 张`}
                onMouseEnter={() => setShown(index)}
                onFocus={() => setShown(index)}
                onClick={(event) => {
                  event.stopPropagation()
                  props.onOpenViewer(index)
                }}
                className={cn(
                  'size-8 shrink-0 overflow-hidden rounded-[4px] bg-well-strong',
                  index === shown && outputs.length > 1 && 'ring-2 ring-accent ring-offset-2 ring-offset-board',
                )}
              >
                <OutputImage path={output.path} alt="" compact />
              </button>
            ))}
            {outputs.length > maxThumbs ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onOpenViewer(maxThumbs)
                }}
                className="tabular shrink-0 px-1 text-caption text-ink-2 hover:text-ink"
              >
                +{outputs.length - maxThumbs}
              </button>
            ) : null}
            <span className="flex-1" />
            <Button
              size="xs"
              disabled={!props.rerun.ok}
              title={props.rerun.reason}
              onClick={(event) => {
                event.stopPropagation()
                props.onRerun('new')
              }}
            >
              换个种子
            </Button>
            <Button
              size="xs"
              aria-label={`重新生成 ${canvas.title}`}
              disabled={!props.rerun.ok}
              title={props.rerun.reason ?? '用同样的参数和种子再生成一次'}
              onClick={(event) => {
                event.stopPropagation()
                props.onRerun('same')
              }}
            >
              重新生成
            </Button>
          </>
        ) : view.state === 'failed' ? (
          <>
            <Button
              size="xs"
              aria-label={`重试 ${canvas.title}`}
              disabled={!props.rerun.ok}
              title={props.rerun.reason}
              onClick={(event) => {
                event.stopPropagation()
                props.onRerun('same')
              }}
            >
              重试
            </Button>
            {jobId ? (
              <Button
                tone="ghost"
                size="xs"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onShowActivity()
                }}
              >
                查看详情
              </Button>
            ) : null}
          </>
        ) : view.state === 'canceled' || view.state === 'lost' || view.state === 'succeeded' ? (
          <Button
            size="xs"
            aria-label={`重新生成 ${canvas.title}`}
            disabled={!props.rerun.ok}
            title={props.rerun.reason}
            onClick={(event) => {
              event.stopPropagation()
              props.onRerun('same')
            }}
          >
            重新生成
          </Button>
        ) : canvas.kind === 'layout' ? (
          <ModelWarning model={props.model} />
        ) : null}
      </footer>
    </article>
  )
}
