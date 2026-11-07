import { Palette, Plus } from 'lucide-react'
import { useState } from 'react'
import type { ControlAdapterEntry, ProjectCanvas } from '@shared/types'
import { cn } from '../../components/ui'
import { MenuGap, MenuItem, Popover } from '../../components/common/Popover'
import { linkSourceImage } from './links'
import { OutputImage } from './OutputImage'
import type { InputSlot } from './ports'
import type { Recipe } from './recipes'
import { SlotMenu, type PortActions } from './SlotMenu'
import type { Point, Wire } from './wires'

/**
 * Board controls that keep their screen size at any zoom: the ＋ that adds
 * an input to a card, the thumbnails of linked pictures, and the ＋ that
 * makes a new card. Placed in board pixels, scaled by 1/zoom.
 */

const at = (point: Point, zoom: number, anchor = 'translate(-50%, -50%)'): React.CSSProperties => ({
  transform: `translate(${point.x}px, ${point.y}px) scale(${1 / Math.max(0.01, zoom)}) ${anchor}`,
})

/** The ＋ on a card's left edge: choose what to add, then how. */
export function InputAdder({
  canvasId,
  title,
  slots,
  point,
  zoom,
  adapters,
  styles,
  actions,
  onHoverChange,
}: {
  canvasId: string
  title: string
  /** The card's empty slots. */
  slots: readonly InputSlot[]
  point: Point
  zoom: number
  adapters: readonly ControlAdapterEntry[]
  styles: readonly ProjectCanvas[]
  actions: PortActions
  /** The pointer is over the ＋ (it belongs to its card's hover). */
  onHoverChange: (on: boolean) => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<InputSlot | null>(null)
  // One kind of input: no need to ask which.
  const only = slots.length === 1 ? slots[0]! : null
  const slot = chosen ?? only
  return (
    <div
      data-board-ui
      data-input-adder={canvasId}
      className="absolute left-0 top-0 z-[6] origin-top-left"
      style={at(point, zoom)}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      <Popover
        align="start"
        label={`给「${title}」接入`}
        className="w-[200px]"
        onOpenChange={(open) => {
          if (!open) setChosen(null)
        }}
        trigger={(menu) => (
          <button
            type="button"
            aria-label={`给「${title}」接入图片`}
            aria-expanded={menu['aria-expanded']}
            aria-controls={menu['aria-controls']}
            aria-haspopup={menu['aria-haspopup']}
            onClick={(event) => {
              event.stopPropagation()
              menu.toggle()
            }}
            className={cn(
              'flex size-6 items-center justify-center rounded-full shadow-float transition-colors',
              menu.open ? 'bg-accent text-on-accent' : 'bg-raised text-ink-2 hover:text-ink',
            )}
          >
            <Plus className="size-3.5" aria-hidden="true" strokeWidth={2} />
          </button>
        )}
      >
        {(close) =>
          slot ? (
            <SlotMenu canvasId={canvasId} slot={slot} adapters={adapters} styles={styles} actions={actions} close={close} />
          ) : (
            slots.map((item) => (
              <MenuItem
                key={item.key}
                disabled={item.needs === 'engine'}
                title={item.needs === 'engine' ? item.reason : undefined}
                onSelect={() => setChosen(item)}
              >
                {item.label}
              </MenuItem>
            ))
          )
        }
      </Popover>
    </div>
  )
}

/**
 * A linked input shows as what it is: the picture's thumbnail (a 风格 as a
 * swatch) at the end of its wire, on the card's edge.
 */
export function InputThumbs({
  wires,
  canvases,
  zoom,
}: {
  wires: readonly Wire[]
  canvases: readonly ProjectCanvas[]
  zoom: number
}): React.JSX.Element {
  return (
    <>
      {wires.map((wire) => {
        if (wire.kind !== 'input') return null
        const style = wire.role === 'style'
        const path = style ? null : linkSourceImage({ canvasId: wire.sourceId, ...(wire.output ? { output: wire.output } : {}) }, canvases)
        return (
          <span
            key={wire.id}
            aria-hidden="true"
            data-input-thumb={wire.id}
            className="pointer-events-none absolute left-0 top-0 z-[5] block size-6 origin-top-left overflow-hidden rounded-[5px] bg-raised shadow-float"
            style={at(wire.to, zoom)}
          >
            {path ? (
              <OutputImage path={path} alt="" compact />
            ) : (
              <span className="flex size-full items-center justify-center text-ink-2">
                <Palette className="size-3.5" strokeWidth={1.6} />
              </span>
            )}
          </span>
        )
      })}
    </>
  )
}

/** The ＋ after the last card: a blank 画面, a recipe, or a 风格. */
export function NewMenu({
  point,
  zoom,
  recipes,
  onAddCanvas,
  onAddStyle,
  onRecipe,
}: {
  point: Point
  zoom: number
  recipes: readonly Recipe[]
  onAddCanvas: () => void
  onAddStyle: () => void
  onRecipe: (recipe: Recipe) => void
}): React.JSX.Element {
  return (
    <div
      data-board-ui
      data-new-canvas
      className="absolute left-0 top-0 z-[6] origin-top-left"
      style={at(point, zoom, 'translate(0, -50%)')}
    >
      <Popover
        align="start"
        label="新建"
        className="w-[180px]"
        trigger={(menu) => (
          <button
            type="button"
            aria-label="新建"
            title="新建"
            aria-expanded={menu['aria-expanded']}
            aria-controls={menu['aria-controls']}
            aria-haspopup={menu['aria-haspopup']}
            onClick={menu.toggle}
            className={cn(
              'flex size-10 items-center justify-center rounded-full transition-colors',
              menu.open ? 'bg-well-strong text-ink' : 'bg-well text-ink-2 hover:bg-well-strong hover:text-ink',
            )}
          >
            <Plus className="size-5" aria-hidden="true" strokeWidth={1.6} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close()
                onAddCanvas()
              }}
            >
              新建画面
            </MenuItem>
            {recipes
              .filter((recipe) => recipe.role)
              .map((recipe) => (
                <MenuItem
                  key={recipe.id}
                  disabled={Boolean(recipe.disabled)}
                  title={recipe.disabled}
                  onSelect={() => {
                    close()
                    onRecipe(recipe)
                  }}
                >
                  {recipe.label}
                </MenuItem>
              ))}
            <MenuGap />
            <MenuItem
              onSelect={() => {
                close()
                onAddStyle()
              }}
            >
              新建风格
            </MenuItem>
            {recipes
              .filter((recipe) => !recipe.role)
              .map((recipe) => (
                <MenuItem
                  key={recipe.id}
                  onSelect={() => {
                    close()
                    onRecipe(recipe)
                  }}
                >
                  {recipe.label}
                </MenuItem>
              ))}
          </>
        )}
      </Popover>
    </div>
  )
}

/** An empty project: the ways to start from a picture, under the first 画面. */
export function StartRow({
  point,
  zoom,
  recipes,
  onRecipe,
}: {
  point: Point
  zoom: number
  recipes: readonly Recipe[]
  onRecipe: (recipe: Recipe) => void
}): React.JSX.Element {
  const starts = recipes.filter(
    (recipe) => recipe.id === 'edit' || recipe.id === 'inpaint' || recipe.id === 'compose' || recipe.id === 'upscale',
  )
  return (
    <div
      data-board-ui
      data-start-row
      role="group"
      aria-label="从一张图开始"
      className="absolute left-0 top-0 z-[6] flex w-max origin-top-left gap-1.5"
      style={at(point, zoom, 'translate(0, 0)')}
    >
      {starts.map((recipe) => (
        <button
          key={recipe.id}
          type="button"
          disabled={Boolean(recipe.disabled)}
          title={recipe.disabled}
          onClick={() => onRecipe(recipe)}
          className="h-7 whitespace-nowrap rounded-full bg-well px-3 text-caption text-ink transition-colors hover:bg-well-strong disabled:cursor-not-allowed disabled:text-ink-2"
        >
          {recipe.label}
        </button>
      ))}
    </div>
  )
}
