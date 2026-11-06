import {
  Brush,
  ChevronDown,
  Eraser,
  FlipHorizontal2,
  Hand,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  SquareDashed,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GalleryItem, ProjectLayerKind } from '@shared/types'
import { Ipc } from '@shared/channels'
import { IconButton, Spinner, cn } from '../../components/ui'
import { MenuGap, MenuItem, Popover } from '../../components/common/Popover'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { BRUSH_MAX, BRUSH_MIN } from './mask'
import type { MaskBrush } from './MaskLayer'
import { KIND_LABEL, type BoardTool } from './RegionLayer'

/** Whether the 遮罩 tool shows, and why it is off. Hidden when the engine cannot inpaint. */
export interface MaskToolState {
  hidden: boolean
  enabled: boolean
  reason?: string
}

const TOOLS: Array<{ id: BoardTool; label: string; key: string; icon: React.ReactNode }> = [
  { id: 'select', label: '选择', key: 'V', icon: <MousePointer2 className="size-[18px]" strokeWidth={1.6} /> },
  { id: 'draw', label: '画框', key: 'B', icon: <SquareDashed className="size-[18px]" strokeWidth={1.6} /> },
  { id: 'pan', label: '平移', key: 'H', icon: <Hand className="size-[18px]" strokeWidth={1.6} /> },
]

function ToolButton({ on, className, ...props }: React.ComponentProps<'button'> & { on?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-ui text-ink transition-colors enabled:hover:bg-well disabled:opacity-40',
        on && 'bg-well-strong',
        className,
      )}
      {...props}
    />
  )
}

/** Recent pictures from 作品, to place under the selected canvas as a guide. */
function UnderlayMenu({
  current,
  onPick,
  close,
}: {
  current?: string
  onPick: (item: GalleryItem | null) => void
  close: () => void
}): React.JSX.Element {
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    call<{ items: GalleryItem[] }>(Ipc.galleryList, { limit: 12 })
      .then((page) => {
        if (alive) setItems(page.items ?? [])
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="flex w-[280px] flex-col gap-2 p-1">
      <div className="px-1 text-caption font-medium text-ink-2">选一张作品垫在画面下面，作为构图参考</div>
      {items === null && !error ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : error ? (
        <p className="px-1 py-3 text-caption text-ink-2">读不到作品：{error}</p>
      ) : items && items.length === 0 ? (
        <p className="px-1 py-3 text-caption text-ink-2">作品里还没有图片。</p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {items!.map((item) => (
            <button
              key={item.path}
              type="button"
              title={item.name}
              aria-label={`用 ${item.name} 作底图`}
              aria-pressed={current === item.path}
              onClick={() => {
                onPick(item)
                close()
              }}
              className={cn(
                'aspect-square overflow-hidden rounded-md bg-well-strong',
                current === item.path && 'ring-2 ring-accent ring-offset-2 ring-offset-raised',
              )}
            >
              <img src={cloverUrl(item.path)} alt="" loading="lazy" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {current ? (
        <>
          <MenuGap />
          <MenuItem
            onSelect={() => {
              onPick(null)
              close()
            }}
          >
            不用底图
          </MenuItem>
        </>
      ) : null}
    </div>
  )
}

export function Toolbar({
  tool,
  onTool,
  regionKind,
  onRegionKind,
  canEditLayout,
  underlay,
  onUnderlay,
  zoom,
  onZoom,
  onFit,
  mask,
}: {
  tool: BoardTool
  onTool: (tool: BoardTool) => void
  regionKind: ProjectLayerKind
  onRegionKind: (kind: ProjectLayerKind) => void
  canEditLayout: boolean
  underlay?: string
  onUnderlay: (item: GalleryItem | null) => void
  zoom: number
  onZoom: (factor: number) => void
  onFit: () => void
  mask: MaskToolState
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="画布工具"
      data-board-ui
      className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-raised p-1 shadow-float"
    >
      {TOOLS.map((item) => (
        <ToolButton
          key={item.id}
          on={tool === item.id}
          aria-label={item.label}
          title={`${item.label}（${item.key}）`}
          onClick={() => onTool(item.id)}
        >
          {item.icon}
        </ToolButton>
      ))}
      <span aria-hidden="true" className="w-2" />
      <Popover
        align="center"
        label="新区域的类型"
        className="min-w-[140px]"
        trigger={(menu) => (
          <ToolButton title="新画的框是什么" onClick={menu.toggle} aria-expanded={menu['aria-expanded']} aria-haspopup="menu">
            {KIND_LABEL[regionKind]}
            <ChevronDown className="size-3.5 text-ink-2" aria-hidden="true" />
          </ToolButton>
        )}
      >
        {(close) =>
          (Object.keys(KIND_LABEL) as ProjectLayerKind[]).map((kind) => (
            <MenuItem
              key={kind}
              selected={kind === regionKind}
              onSelect={() => {
                onRegionKind(kind)
                if (tool !== 'draw') onTool('draw')
                close()
              }}
            >
              {KIND_LABEL[kind]}
            </MenuItem>
          ))
        }
      </Popover>
      <Popover
        align="center"
        label="底图"
        trigger={(menu) => (
          <ToolButton
            on={Boolean(underlay)}
            disabled={!canEditLayout}
            title={canEditLayout ? '在画面下面垫一张参考图' : '选中一个可编辑的画面后再选底图'}
            onClick={menu.toggle}
            aria-expanded={menu['aria-expanded']}
            aria-haspopup="dialog"
          >
            底图
          </ToolButton>
        )}
      >
        {(close) => <UnderlayMenu current={underlay} onPick={onUnderlay} close={close} />}
      </Popover>
      {mask.hidden ? null : (
        <ToolButton
          on={tool === 'mask'}
          disabled={!mask.enabled}
          aria-label="遮罩"
          title={mask.enabled ? '涂出要重画的部分（M）' : mask.reason}
          onClick={() => onTool(tool === 'mask' ? 'select' : 'mask')}
        >
          <Brush className="size-[18px]" strokeWidth={1.6} />
          遮罩
        </ToolButton>
      )}
      <span aria-hidden="true" className="w-2" />
      <IconButton label="缩小" onClick={() => onZoom(1 / 1.25)} className="text-ink">
        <Minus className="size-4" />
      </IconButton>
      <button
        type="button"
        onClick={onFit}
        title="适应窗口"
        className="tabular h-8 w-12 rounded-md text-center text-caption text-ink hover:bg-well"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton label="放大" onClick={() => onZoom(1.25)} className="text-ink">
        <Plus className="size-4" />
      </IconButton>
      <IconButton label="适应窗口" onClick={onFit} className="text-ink">
        <Maximize2 className="size-4" strokeWidth={1.6} />
      </IconButton>
    </div>
  )
}

/** Brush settings and commands while the 遮罩 tool is on; floats under the toolbar. */
export function MaskBar({
  brush,
  onBrush,
  onClear,
  onInvert,
  onDone,
}: {
  brush: MaskBrush
  onBrush: (brush: MaskBrush) => void
  onClear: () => void
  onInvert: () => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="遮罩工具"
      data-board-ui
      className="absolute left-1/2 top-[64px] z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-raised p-1 shadow-float"
    >
      <ToolButton
        on={brush.mode === 'paint'}
        aria-label="画笔"
        title="画笔：涂出要重画的部分"
        onClick={() => onBrush({ ...brush, mode: 'paint' })}
      >
        <Brush className="size-4" strokeWidth={1.6} />
      </ToolButton>
      <ToolButton
        on={brush.mode === 'erase'}
        aria-label="橡皮"
        title="橡皮：擦掉涂过的部分"
        onClick={() => onBrush({ ...brush, mode: 'erase' })}
      >
        <Eraser className="size-4" strokeWidth={1.6} />
      </ToolButton>
      <label className="flex h-8 items-center gap-2 px-2 text-caption text-ink-2">
        大小
        <input
          type="range"
          aria-label="笔刷大小"
          min={BRUSH_MIN}
          max={BRUSH_MAX}
          step={4}
          value={brush.size}
          onChange={(event) => onBrush({ ...brush, size: Number(event.target.value) })}
          className="w-24 accent-accent"
        />
        <span className="tabular w-7 text-right text-ink">{brush.size}</span>
      </label>
      <ToolButton aria-label="反转" title="反转：涂过的保留，其余重画" onClick={onInvert}>
        <FlipHorizontal2 className="size-4" strokeWidth={1.6} />
        反转
      </ToolButton>
      <ToolButton aria-label="清除" title="清除整个遮罩" onClick={onClear}>
        <Trash2 className="size-4" strokeWidth={1.6} />
        清除
      </ToolButton>
      <span aria-hidden="true" className="w-1" />
      <ToolButton className="bg-well" onClick={onDone}>
        完成
      </ToolButton>
    </div>
  )
}
