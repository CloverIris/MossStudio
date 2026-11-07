import type { ControlAdapterEntry, ProjectCanvas } from '@shared/types'
import { MenuItem } from '../../components/common/Popover'
import type { LinkRole } from './links'
import type { InputSlot } from './ports'

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

/** What filling one input slot offers: pick from the board or a file, choose an adapter or a 风格. */
export function SlotMenu({
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
        {note('选控制适配器')}
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
