import type { ControlAdapterEntry, ProjectCanvas } from '@shared/types'
import { MenuItem } from '../../components/common/Popover'
import { pictureSources } from './connect'
import { linkSourceImage, type LinkRole } from './links'
import { OutputImage } from './OutputImage'
import type { InputSlot } from './ports'

/** What an empty slot's menu can do; the Studio page wires these to the inputs it already has. */
export interface PortActions {
  /** Link another card's picture in. */
  onLinkPicture: (canvasId: string, role: LinkRole, kind: string | undefined, sourceId: string) => void
  /** Choose picture files and link them in. */
  onAddFromFile: (canvasId: string, role: LinkRole, kind?: string) => void
  /** Choose a picture from 作品 and link it in. */
  onAddFromGallery: (canvasId: string, role: LinkRole, kind?: string) => void
  onSetControlAdapter: (canvasId: string, adapterId: string) => void
  onNavigate: (to: string) => void
  /** Wire a 风格 into the canvas: an existing one, or a new one when `styleId` is absent. */
  onAddStyle: (canvasId: string, styleId?: string) => void
}

/** What filling one input slot offers: a picture on the board, 作品 or a file, choose an adapter or a 风格. */
export function SlotMenu({
  canvasId,
  slot,
  adapters,
  styles,
  canvases,
  actions,
  close,
}: {
  canvasId: string
  canvases: readonly ProjectCanvas[]
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
      <PictureChoices
        targetId={canvasId}
        canvases={canvases}
        onChoose={(sourceId) => {
          close()
          actions.onLinkPicture(canvasId, slot.role, slot.kind, sourceId)
        }}
      />
      <MenuItem
        onSelect={() => {
          close()
          actions.onAddFromGallery(canvasId, slot.role, slot.kind)
        }}
      >
        从作品选择
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

/** The board's pictures that can go into a card, as thumbnails to click. */
export function PictureChoices({
  targetId,
  canvases,
  onChoose,
}: {
  targetId: string
  canvases: readonly ProjectCanvas[]
  onChoose: (sourceId: string) => void
}): React.JSX.Element | null {
  const target = canvases.find((canvas) => canvas.id === targetId)
  const sources = target ? pictureSources(canvases, target) : []
  if (!sources.length) return null
  return (
    <div role="group" aria-label="画板上的图" data-picture-choices className="grid max-h-[208px] grid-cols-3 gap-1.5 overflow-y-auto p-1">
      {sources.map((source) => {
        const path = linkSourceImage({ canvasId: source.id }, canvases)
        return (
          <button
            key={source.id}
            type="button"
            role="menuitem"
            aria-label={source.title}
            title={source.title}
            onClick={() => onChoose(source.id)}
            className="aspect-square overflow-hidden rounded-md bg-well transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {path ? <OutputImage path={path} alt="" compact /> : null}
          </button>
        )
      })}
    </div>
  )
}
