import { Plus } from 'lucide-react'
import type { ControlAdapterEntry, ProjectCanvas } from '@shared/types'
import { cn } from '../../components/ui'
import { MenuItem, Popover } from '../../components/common/Popover'
import type { LinkRole } from './links'
import type { InputSlot } from './ports'
import { CHIP_MIN_ZOOM, type EmptyPort } from './wires'

/** What an empty slot's menu can do; the Studio page wires these to the inputs it already has. */
export interface PortActions {
  /** Pick the picture from another card on the board. */
  onPick: (canvasId: string, role: LinkRole, kind?: string) => void
  /** Choose picture files and link them in. */
  onAddFromFile: (canvasId: string, role: LinkRole, kind?: string) => void
  onSetControlAdapter: (canvasId: string, adapterId: string) => void
  onNavigate: (to: string) => void
  /** Wire a 风格 into the canvas: an existing one, or a new one when `styleId` is absent. */
  onAddStyle: (canvasId: string, styleId?: string) => void
}

function slotTitle(slot: InputSlot): string {
  if (slot.reason) return `${slot.label}：${slot.reason}`
  const from = slot.role === 'style' ? '一个风格' : '一张图'
  return `${slot.label}：${slot.hint}。点击添加，或把${from}的连线拖到这里`
}

/**
 * The sockets and muted chips of empty slots, beside their ports and at screen size like
 * the wire chips. Clicking one offers the ways to fill it, or says what has
 * to happen first. Below CHIP_MIN_ZOOM they show only on the selected card.
 */
export function EmptyPortChips({
  ports,
  zoom,
  selectedCanvasId,
  active,
  adapters,
  styles = [],
  actions,
}: {
  ports: readonly EmptyPort[]
  zoom: number
  selectedCanvasId: string | null
  active: string | null
  adapters: readonly ControlAdapterEntry[]
  /** The 风格 nodes on the board, for a 风格 socket's menu. */
  styles?: readonly ProjectCanvas[]
  actions: PortActions
}): React.JSX.Element {
  const scale = 1 / Math.max(0.01, zoom)
  return (
    <>
      {ports.map(({ canvasId, slot, chip, port }) => {
        const id = `${canvasId}/${slot.key}`
        const on = active === id
        // A hollow socket on the card's edge, drawn above the card so it reads as a whole circle.
        const dot = (
          <span
            key={`${id}/dot`}
            aria-hidden="true"
            data-empty-port-dot={id}
            className={cn(
              'pointer-events-none absolute left-0 top-0 z-[6] block size-2.5 origin-top-left rounded-full transition-colors',
              on ? 'bg-accent' : 'bg-ink-3',
              slot.needs && !on && 'opacity-50',
            )}
            style={{ transform: `translate(${port.x}px, ${port.y}px) scale(${on ? 1.4 * scale : scale}) translate(-50%, -50%)` }}
          >
            {/* Tonal, not a border: a board-coloured centre makes it read as an open socket. */}
            {on ? null : <span className="absolute inset-[1.5px] rounded-full bg-board" />}
          </span>
        )
        if (zoom < CHIP_MIN_ZOOM && canvasId !== selectedCanvasId && !on) return dot
        return [
          dot,
          <div
            key={id}
            data-board-ui
            data-empty-port={id}
            className="absolute left-0 top-0 z-[6] origin-top-left"
            style={{ transform: `translate(${chip.x + chip.w}px, ${chip.y + chip.h / 2}px) scale(${scale}) translate(-100%, -50%)` }}
          >
            <Popover
              align="end"
              label={`添加${slot.label}`}
              className="w-[240px]"
              trigger={(menu) => (
                <button
                  type="button"
                  title={slotTitle(slot)}
                  aria-label={`${slot.label}，${slot.reason ?? '还没有接图片'}`}
                  aria-expanded={menu['aria-expanded']}
                  aria-controls={menu['aria-controls']}
                  aria-haspopup={menu['aria-haspopup']}
                  onClick={(event) => {
                    event.stopPropagation()
                    menu.toggle()
                  }}
                  className={cn(
                    'tabular flex h-5 items-center gap-0.5 whitespace-nowrap rounded-full px-2 text-micro font-medium transition-colors',
                    on || menu.open ? 'bg-accent-soft text-accent' : 'bg-well text-ink-2 hover:bg-well-strong hover:text-ink',
                  )}
                >
                  <Plus className="size-3" aria-hidden="true" strokeWidth={1.6} />
                  {slot.label}
                </button>
              )}
            >
              {(close) => <SlotMenu canvasId={canvasId} slot={slot} adapters={adapters} styles={styles} actions={actions} close={close} />}
            </Popover>
          </div>,
        ]
      })}
    </>
  )
}

function SlotMenu({
  canvasId,
  slot,
  adapters,
  styles,
  actions,
  close,
}: {
  canvasId: string
  slot: InputSlot
  adapters: readonly ControlAdapterEntry[]
  styles: readonly ProjectCanvas[]
  actions: PortActions
  close: () => void
}): React.JSX.Element {
  const note = (text: string): React.JSX.Element => <p className="px-2 pb-1 pt-1.5 text-caption text-ink-2">{text}</p>
  if (slot.role === 'style') {
    return (
      <>
        {note(slot.hint)}
        {styles.map((style) => (
          <MenuItem
            key={style.id}
            onSelect={() => {
              close()
              actions.onAddStyle(canvasId, style.id)
            }}
          >
            用「{style.title}」
          </MenuItem>
        ))}
        <MenuItem
          onSelect={() => {
            close()
            actions.onAddStyle(canvasId)
          }}
        >
          新建风格
        </MenuItem>
      </>
    )
  }
  if (slot.needs === 'engine') return note(slot.reason ?? '现在还不能接图片')
  if (slot.needs === 'adapter-missing') {
    return (
      <>
        {note('按深度或颜色构图需要一个控制适配器，先在模型页添加。')}
        <MenuItem
          onSelect={() => {
            close()
            actions.onNavigate('/models')
          }}
        >
          去添加控制适配器
        </MenuItem>
      </>
    )
  }
  if (slot.needs === 'adapter') {
    return (
      <>
        {note('先选择用哪个控制适配器：')}
        {adapters.map((adapter) => (
          <MenuItem
            key={adapter.id}
            onSelect={() => {
              close()
              actions.onSetControlAdapter(canvasId, adapter.id)
            }}
          >
            {adapter.name}
          </MenuItem>
        ))}
      </>
    )
  }
  return (
    <>
      {note(slot.hint)}
      <MenuItem
        onSelect={() => {
          close()
          actions.onPick(canvasId, slot.role, slot.kind)
        }}
      >
        从画板选择
      </MenuItem>
      <MenuItem
        onSelect={() => {
          close()
          actions.onAddFromFile(canvasId, slot.role, slot.kind)
        }}
      >
        从文件…
      </MenuItem>
    </>
  )
}
