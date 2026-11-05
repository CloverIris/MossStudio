import { ImageOff, MoreHorizontal, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { ImageResizeMode, ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { Button, IconButton, cn } from '../../components/ui'
import { MenuItem, Popover } from '../../components/common/Popover'
import { cloverUrl } from '../../lib/clover'
import { CARD_FOOTER, CARD_HEADER, cardBodyHeight, cardWidth } from './boardLayout'
import { LivePreview, ProgressStrip, StatusOverlay } from './CardStatus'
import type { CardJobView } from './jobStatus'
import { MaskLayer, usePictureSize, type MaskBrush, type MaskCommand } from './MaskLayer'
import type { Size } from './mask'
import type { RerunCheck } from './readiness'
import { RegionLayer, type BoardTool } from './RegionLayer'
import { StartPicture } from './StartPicture'

/** Result picture with a readable fallback when the file on disk is gone. */
export function OutputImage({ path, alt, className, compact }: { path: string; alt: string; className?: string; compact?: boolean }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <span title={`图片文件找不到了：${path}`} className="flex size-full items-center justify-center px-3 text-center text-caption text-ink-2">
        {compact ? <ImageOff className="size-4 text-ink-3" aria-label="图片文件找不到了" /> : '图片文件找不到了'}
      </span>
    )
  }
  return <img src={cloverUrl(path)} alt={alt} draggable={false} onError={() => setBroken(true)} className={cn('size-full object-cover', className)} />
}

export interface CardMask {
  interactive: boolean
  brush: MaskBrush
  command?: MaskCommand
  onSave: (png: Uint8Array | null) => void
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
  /** While a wire is dragged over this card: whether it can be dropped here. */
  dropTarget?: 'ok' | 'no'
  /** Board pick mode: 'ok' = a click picks this card's picture, 'inert' = it cannot be picked. */
  pick?: 'ok' | 'inert'
  onPortDown: (event: React.PointerEvent<HTMLElement>) => void
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
 * One canvas on the board: title and state above the picture, the picture
 * (regions, live progress, results or an imported image), and the results
 * row below. The output port on the right edge starts a wire.
 */
export function CanvasCard(props: CanvasCardProps): React.JSX.Element {
  const { canvas, view, selected } = props
  const [shown, setShown] = useState(0)
  const width = cardWidth(canvas)
  const bodyHeight = cardBodyHeight(canvas)
  const isImage = canvas.kind === 'image'
  const outputs = isImage ? [] : view.outputs
  const current = outputs[Math.min(shown, Math.max(0, outputs.length - 1))]
  const editable = canvas.kind === 'layout' && selected && !view.active
  const showRegions = canvas.kind === 'layout' && (selected || outputs.length === 0)
  const maxThumbs = Math.max(1, Math.floor((width - 116) / 42))
  const preview = view.active ? view.preview : undefined
  // While painting the mask, the start picture shows even over earlier results.
  const painting = Boolean(props.mask?.interactive && props.initPicture)
  const pictureSize = usePictureSize(props.mask ? props.initPicture?.path : undefined, props.initPicture?.size ?? null)

  return (
    <article
      data-canvas-card={canvas.id}
      data-canvas-kind={canvas.kind}
      aria-label={`${canvas.title}${selected ? '，已选中' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      // In pick mode a click anywhere on the card picks it; nothing inside reacts.
      onClickCapture={props.pick ? (event) => { event.stopPropagation(); event.preventDefault(); if (props.pick === 'ok') props.onSelect() } : undefined}
      data-pick={props.pick}
      className={cn(
        'group/card absolute flex flex-col',
        props.dragging && 'z-10',
        props.pick === 'ok' && 'cursor-pointer',
        props.pick === 'inert' && 'cursor-not-allowed opacity-50',
      )}
      style={{ left: canvas.x, top: canvas.y, width }}
    >
      <header
        onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) props.onDragStart(event) }}
        className={cn('flex touch-none select-none items-center gap-2 text-caption', props.dragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ height: CARD_HEADER }}
      >
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); props.onSelect() }}
          className="min-w-0 truncate text-left font-semibold text-ink"
        >
          {canvas.title}
        </button>
        <span className={cn('tabular min-w-0 flex-1 truncate text-right', view.state === 'failed' ? 'text-danger' : 'text-ink-2')}>{isImage ? '' : view.label}</span>
        <Popover
          align="end"
          label={`${canvas.title} 操作`}
          trigger={(menu) => (
            <IconButton
              label={`${canvas.title} 更多操作`}
              className={cn('-mr-1.5 size-6', !selected && 'opacity-0 focus-visible:opacity-100 [article:hover_&]:opacity-100', menu.open && 'opacity-100')}
              onClick={(event) => { event.stopPropagation(); menu.toggle() }}
              aria-expanded={menu['aria-expanded']}
              aria-haspopup="menu"
            >
              <MoreHorizontal className="size-4" />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <MenuItem onSelect={() => { close(); props.onCopy() }}>{isImage ? '复制' : '复制为新画面'}</MenuItem>
              {canvas.jobId && !isImage ? <MenuItem onSelect={() => { close(); props.onShowActivity() }}>在活动中查看</MenuItem> : null}
              <MenuItem tone="danger" onSelect={() => { close(); props.onDelete() }}>{isImage ? '删除' : '删除画面'}</MenuItem>
            </>
          )}
        </Popover>
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
          // A press on the picture outside every region clears the region selection.
          if (editable && !(event.target as HTMLElement).closest('[data-region-id]')) props.onSelectRegion(null)
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
            onDoubleClick={() => props.onOpenViewer(Math.min(shown, outputs.length - 1))}
            onClick={(event) => {
              if (!selected) return
              event.stopPropagation()
              props.onOpenViewer(Math.min(shown, outputs.length - 1))
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

        {isImage ? null : <StatusOverlay view={view} hasPicture={Boolean(preview)} />}
        {view.active && (view.phase === 'denoise' || view.phase === 'decode' || view.phase === 'save' || view.phase === 'text') ? (
          <ProgressStrip percent={view.phase === 'denoise' ? view.percent : undefined} />
        ) : null}

        {props.pick === 'ok' ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[4] opacity-0 transition-opacity [article:hover_&]:bg-accent-soft [article:hover_&]:opacity-100" />
        ) : null}
        {props.dropTarget ? (
          <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 z-[4]', props.dropTarget === 'ok' ? 'bg-accent-soft' : 'bg-well')} />
        ) : null}
      </div>

      {props.hasOutput ? (
        <button
          type="button"
          data-board-ui
          data-output-port={canvas.id}
          aria-label={`从 ${canvas.title} 拉出连线`}
          title="拖到另一个画面上，把这张图接进去"
          onPointerDown={(event) => { event.stopPropagation(); props.onPortDown(event) }}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'absolute z-[5] flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair touch-none items-center justify-center rounded-full transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100',
          )}
          style={{ left: width, top: CARD_HEADER + bodyHeight / 2 }}
        >
          <span aria-hidden="true" className="size-3 rounded-full bg-accent outline-2 outline-board" />
        </button>
      ) : null}

      <footer className="flex items-center gap-1.5" style={{ height: CARD_FOOTER }}>
        {isImage ? (
          <span className="text-caption text-ink-2">图片</span>
        ) : view.active ? (
          <div className="tabular flex min-w-0 flex-1 items-center gap-2 text-caption">
            <span data-card-progress className="min-w-0 flex-1 truncate text-ink">{view.detail}</span>
            <button type="button" onClick={(event) => { event.stopPropagation(); props.onShowActivity() }} className="shrink-0 text-ink-2 underline-offset-2 hover:text-ink hover:underline">详情</button>
            {canvas.jobId ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); props.onCancel() }} className="shrink-0 text-ink underline underline-offset-2">取消</button>
            ) : null}
          </div>
        ) : outputs.length > 0 ? (
          <>
            {outputs.slice(0, maxThumbs).map((output, index) => (
              <button
                key={output.path}
                type="button"
                aria-label={`第 ${index + 1} 张`}
                onMouseEnter={() => setShown(index)}
                onFocus={() => setShown(index)}
                onClick={(event) => { event.stopPropagation(); props.onOpenViewer(index) }}
                className={cn('size-8 shrink-0 overflow-hidden rounded-[4px] bg-well-strong', index === shown && outputs.length > 1 && 'ring-2 ring-ink ring-offset-2 ring-offset-board')}
              >
                <OutputImage path={output.path} alt="" compact />
              </button>
            ))}
            {outputs.length > maxThumbs ? (
              <button type="button" onClick={(event) => { event.stopPropagation(); props.onOpenViewer(maxThumbs) }} className="tabular shrink-0 px-1 text-caption text-ink-2 hover:text-ink">
                +{outputs.length - maxThumbs}
              </button>
            ) : null}
            <span className="flex-1" />
            <Button
              tone="secondary"
              size="sm"
              className="h-7 px-2.5"
              disabled={!props.rerun.ok}
              title={props.rerun.reason}
              onClick={(event) => { event.stopPropagation(); props.onRerun('new') }}
            >
              换个种子
            </Button>
            <IconButton
              label={`重新生成 ${canvas.title}`}
              className="size-7"
              disabled={!props.rerun.ok}
              title={props.rerun.reason ?? '用同样的参数和种子再生成一次'}
              onClick={(event) => { event.stopPropagation(); props.onRerun('same') }}
            >
              <RotateCcw className="size-3.5" />
            </IconButton>
          </>
        ) : view.state === 'failed' ? (
          <>
            <Button
              tone="secondary"
              size="sm"
              className="h-7 px-2.5"
              aria-label={`重试 ${canvas.title}`}
              disabled={!props.rerun.ok}
              title={props.rerun.reason}
              onClick={(event) => { event.stopPropagation(); props.onRerun('same') }}
            >
              重试
            </Button>
            {canvas.jobId ? (
              <Button tone="ghost" size="sm" className="h-7 px-2.5" onClick={(event) => { event.stopPropagation(); props.onShowActivity() }}>查看原因</Button>
            ) : null}
          </>
        ) : view.state === 'canceled' || view.state === 'lost' || view.state === 'succeeded' ? (
          <Button
            tone="secondary"
            size="sm"
            className="h-7 px-2.5"
            aria-label={`重新生成 ${canvas.title}`}
            disabled={!props.rerun.ok}
            title={props.rerun.reason}
            onClick={(event) => { event.stopPropagation(); props.onRerun('same') }}
          >
            重新生成
          </Button>
        ) : canvas.kind === 'layout' ? (
          <span className="text-caption text-ink-2">{canvas.layers.length ? `${canvas.layers.length} 个区域 · 尚未生成` : '尚未生成'}</span>
        ) : null}
      </footer>
    </article>
  )
}
