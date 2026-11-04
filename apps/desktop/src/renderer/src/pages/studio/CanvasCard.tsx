import { ImageOff, MoreHorizontal, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { ProjectCanvas, ProjectLayer, ProjectLayerKind } from '@shared/types'
import { Button, IconButton, ProgressBar, cn } from '../../components/ui'
import { MenuItem, Popover } from '../../components/common/Popover'
import { cloverUrl } from '../../lib/clover'
import { CARD_FOOTER, CARD_HEADER, cardBodyHeight, cardWidth } from './board'
import type { CardJobView } from './jobStatus'
import type { RerunCheck } from './readiness'
import { RegionLayer, type BoardTool } from './RegionLayer'

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

export interface CanvasCardProps {
  canvas: ProjectCanvas
  view: CardJobView
  selected: boolean
  dragging: boolean
  tool: BoardTool
  regionKind: ProjectLayerKind
  selectedRegionId: string | null
  rerun: RerunCheck
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
 * (regions, progress or results), and the results row below.
 */
export function CanvasCard(props: CanvasCardProps): React.JSX.Element {
  const { canvas, view, selected } = props
  const [shown, setShown] = useState(0)
  const width = cardWidth(canvas)
  const bodyHeight = cardBodyHeight(canvas)
  const outputs = view.outputs
  const current = outputs[Math.min(shown, Math.max(0, outputs.length - 1))]
  const editable = canvas.kind === 'layout' && selected && !view.active
  const showRegions = canvas.kind === 'layout' && (selected || outputs.length === 0)
  const maxThumbs = Math.max(1, Math.floor((width - 116) / 42))

  return (
    <article
      data-canvas-card={canvas.id}
      aria-label={`${canvas.title}${selected ? '，已选中' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      className={cn('absolute flex flex-col', props.dragging && 'z-10')}
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
        <span className="tabular min-w-0 flex-1 truncate text-right text-ink-2">{view.label}</span>
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
              <MenuItem onSelect={() => { close(); props.onCopy() }}>复制为新画面</MenuItem>
              {canvas.jobId ? <MenuItem onSelect={() => { close(); props.onShowActivity() }}>在活动中查看</MenuItem> : null}
              <MenuItem tone="danger" onSelect={() => { close(); props.onDelete() }}>删除画面</MenuItem>
            </>
          )}
        </Popover>
      </header>

      <div
        className={cn(
          'relative overflow-hidden rounded-md bg-well-strong transition-shadow',
          selected && 'ring-2 ring-accent ring-offset-2 ring-offset-board',
          view.active && 'studio-card-running',
        )}
        style={{ height: bodyHeight }}
        onPointerDown={(event) => {
          // A press on the picture outside every region clears the region selection.
          if (editable && !(event.target as HTMLElement).closest('[data-region-id]')) props.onSelectRegion(null)
        }}
      >
        {current ? (
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
        ) : canvas.backgroundPath ? (
          <img src={cloverUrl(canvas.backgroundPath)} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
        ) : null}

        {showRegions ? (
          <RegionLayer
            canvas={canvas}
            interactive={editable}
            tool={props.tool}
            regionKind={props.regionKind}
            selectedRegionId={props.selectedRegionId}
            onSelectRegion={props.onSelectRegion}
            onChangeLayers={props.onChangeLayers}
            onRegionDrawn={props.onRegionDrawn}
            onOpenRegion={props.onOpenRegion}
          />
        ) : null}

        {view.active ? (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-panel p-3">
            {view.percent === undefined ? (
              <div className="h-1 w-full overflow-hidden rounded-full bg-well-strong" role="progressbar" aria-label="生成进度">
                <div className="studio-progress-indeterminate h-full w-1/3 rounded-full bg-accent" />
              </div>
            ) : (
              <ProgressBar value={view.percent} label="生成进度" />
            )}
            <div className="tabular flex items-center gap-2 text-caption">
              <span className="min-w-0 flex-1 truncate text-ink">{view.detail}</span>
              <button type="button" onClick={(event) => { event.stopPropagation(); props.onShowActivity() }} className="shrink-0 text-ink-2 underline-offset-2 hover:text-ink hover:underline">详情</button>
              {canvas.jobId ? (
                <button type="button" onClick={(event) => { event.stopPropagation(); props.onCancel() }} className="shrink-0 text-ink underline underline-offset-2">取消</button>
              ) : null}
            </div>
          </div>
        ) : view.error && outputs.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-caption text-ink-2">
            <span className="line-clamp-5 [overflow-wrap:anywhere]">{view.error}</span>
          </div>
        ) : canvas.kind === 'result' && outputs.length === 0 && view.state === 'canceled' ? (
          <div className="absolute inset-0 flex items-center justify-center text-caption text-ink-2">已取消</div>
        ) : null}
      </div>

      <footer className="flex items-center gap-1.5" style={{ height: CARD_FOOTER }}>
        {outputs.length > 0 && !view.active ? (
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
        ) : !view.active && (view.state === 'failed' || view.state === 'canceled' || view.state === 'lost' || view.state === 'succeeded') ? (
          <>
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
            {view.state === 'failed' && canvas.jobId ? (
              <Button tone="ghost" size="sm" className="h-7 px-2.5" onClick={(event) => { event.stopPropagation(); props.onShowActivity() }}>查看原因</Button>
            ) : null}
          </>
        ) : !view.active && canvas.kind === 'layout' ? (
          <span className="text-caption text-ink-2">{canvas.layers.length ? `${canvas.layers.length} 个区域 · 尚未生成` : '尚未生成'}</span>
        ) : null}
      </footer>
    </article>
  )
}
