import { cn } from '../../components/ui'
import { Popover } from '../../components/common/Popover'
import type { CardJobView } from './jobStatus'
import type { StripItem } from './runs'
import { OutputImage } from './OutputImage'

/** What a thumbnail without a picture says: the run is still going, failed or was stopped. */
function placeholder(view: CardJobView | undefined): string {
  if (!view || view.active) return '…'
  if (view.state === 'failed') return '失败'
  if (view.state === 'canceled' || view.state === 'lost') return '停止'
  return '…'
}

function Thumb({
  item,
  view,
  on,
  marked,
  onShow,
  onOpen,
  onPointerDown,
}: {
  item: StripItem
  view: CardJobView | undefined
  on: boolean
  /** Ring the shown thumbnail (only when there is more than one). */
  marked: boolean
  onShow: () => void
  onOpen: () => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-strip-item={`${item.runId}/${item.output}`}
      aria-label={`第 ${item.number} 张`}
      aria-pressed={on}
      title={item.path ? '点一下放到画面上，双击放大看；拖到画板上单独放' : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (item.path) onOpen()
      }}
      onClick={(event) => {
        event.stopPropagation()
        // A pointer press shows it on pointer-up (see Board), unless it was dragged out; keys click here.
        if (event.detail === 0 || !onPointerDown) onShow()
      }}
      className={cn(
        'tabular flex size-8 shrink-0 touch-none items-center justify-center overflow-hidden rounded-[4px] bg-well-strong text-micro text-ink-2',
        on && marked && 'ring-2 ring-accent ring-offset-2 ring-offset-board',
      )}
    >
      {item.path ? <OutputImage path={item.path} alt="" compact /> : placeholder(view)}
    </button>
  )
}

/**
 * A 画面's filmstrip: every picture it has made, newest on the right. Click
 * one to show it on the face (that is the picture its wires carry); the
 * older ones that do not fit sit behind "+N".
 */
export function Filmstrip({
  items,
  shown,
  views,
  max,
  onShow,
  onOpen,
  onPointerDown,
}: {
  items: readonly StripItem[]
  shown: number
  views: ReadonlyMap<string, CardJobView>
  /** How many thumbnails fit beside the buttons. */
  max: number
  onShow: (index: number) => void
  /** Open the viewer at this picture. */
  onOpen: (index: number) => void
  onPointerDown?: (index: number, event: React.PointerEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  const hidden = Math.max(0, items.length - max)
  const marked = items.length > 1
  return (
    <div data-filmstrip className="flex min-w-0 items-center gap-1.5">
      {hidden ? (
        <Popover
          align="start"
          label="全部图片"
          className="w-[232px]"
          trigger={(menu) => (
            <button
              type="button"
              aria-expanded={menu['aria-expanded']}
              aria-haspopup={menu['aria-haspopup']}
              aria-controls={menu['aria-controls']}
              title="看全部图片"
              onClick={(event) => {
                event.stopPropagation()
                menu.toggle()
              }}
              className={cn(
                'tabular h-8 shrink-0 rounded-[4px] px-1.5 text-caption transition-colors',
                shown < hidden ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-well hover:text-ink',
              )}
            >
              +{hidden}
            </button>
          )}
        >
          {(close) => (
            <div className="grid grid-cols-5 gap-1.5 p-1.5">
              {items.map((item, index) => (
                <Thumb
                  key={`${item.runId}/${item.output}`}
                  item={item}
                  view={views.get(item.runId)}
                  on={index === shown}
                  marked={marked}
                  onShow={() => {
                    onShow(index)
                    close()
                  }}
                  onOpen={() => {
                    close()
                    onOpen(index)
                  }}
                />
              ))}
            </div>
          )}
        </Popover>
      ) : null}
      {items.slice(hidden).map((item, offset) => {
        const index = hidden + offset
        return (
          <Thumb
            key={`${item.runId}/${item.output}`}
            item={item}
            view={views.get(item.runId)}
            on={index === shown}
            marked={marked}
            onShow={() => onShow(index)}
            onOpen={() => onOpen(index)}
            onPointerDown={onPointerDown ? (event) => onPointerDown(index, event) : undefined}
          />
        )
      })}
    </div>
  )
}
