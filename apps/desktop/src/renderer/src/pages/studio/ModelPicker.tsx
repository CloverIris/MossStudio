import { ArrowDownToLine, Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelBundle } from '@shared/types'
import { ModelName } from '../../components/common/ModelName'
import { MenuGap, MenuItem, Popover } from '../../components/common/Popover'
import { cn } from '../../components/ui'

/**
 * The model of a 画面: a field that opens a list of models, the downloaded
 * ones first (with their size) and the others under 未下载, which open the 模型
 * page at that model. Names show their variant as tags (INT8, 8 步), which a
 * native select cannot.
 */
export function ModelPicker({
  id,
  current,
  installed,
  others,
  sizes,
  disabled,
  placeholder,
  onPick,
  onDownload,
}: {
  id: string
  current: ModelBundle | null
  installed: readonly ModelBundle[]
  /** Models not downloaded yet. */
  others: readonly ModelBundle[]
  sizes: ReadonlyMap<string, string>
  disabled?: boolean
  /** What the field says when there is no model. */
  placeholder: string
  onPick: (id: string) => void
  onDownload: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const list = useRef<HTMLDivElement>(null)

  // Opening puts the focus on the current model, as a select does.
  useEffect(() => {
    if (!open) return
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    ;(items.find((item) => item.getAttribute('aria-current') === 'true') ?? items[0])?.focus()
  }, [open])

  // Up and down move between models; Home and End jump to the ends.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (!items.length) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const option = (bundle: ModelBundle, here: boolean, close: () => void): React.JSX.Element => (
    <MenuItem
      key={bundle.id}
      selected={bundle.id === current?.id}
      // A long name with tags can be cut short in the side panel; hovering shows it whole.
      title={bundle.name}
      // 未下载 already heads the group: an icon says 去下载 and leaves the name its room.
      hint={
        here ? (
          sizes.get(bundle.id)
        ) : (
          <>
            <ArrowDownToLine aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
            <span className="sr-only">去下载</span>
          </>
        )
      }
      onSelect={() => {
        close()
        if (here) onPick(bundle.id)
        else onDownload(bundle.id)
      }}
    >
      <span className={cn('flex min-w-0 items-center gap-2', !here && 'text-ink-2')}>
        <Check
          aria-hidden="true"
          strokeWidth={2}
          className={cn('size-3.5 shrink-0 text-accent', bundle.id !== current?.id && 'invisible')}
        />
        <ModelName item={bundle} />
      </span>
    </MenuItem>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="模型"
      rootClassName="flex w-full"
      // As wide as the field: the side panel clips anything wider.
      className="max-h-80 w-full min-w-0 overflow-y-auto"
      trigger={(menu) => (
        <button
          id={id}
          type="button"
          disabled={disabled}
          onClick={menu.toggle}
          aria-expanded={menu['aria-expanded']}
          aria-controls={menu['aria-controls']}
          aria-haspopup={menu['aria-haspopup']}
          data-model-picker
          className="ui-field flex items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1">{current ? <ModelName item={current} /> : placeholder}</span>
          <ChevronDown className="size-4 shrink-0 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
        </button>
      )}
    >
      {(close) => (
        <div ref={list} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
          {installed.length ? <GroupLabel>已下载</GroupLabel> : null}
          {installed.map((bundle) => option(bundle, true, close))}
          {others.length ? (
            <>
              {installed.length ? <MenuGap /> : null}
              <GroupLabel>未下载</GroupLabel>
              {others.map((bundle) => option(bundle, false, close))}
            </>
          ) : null}
        </div>
      )}
    </Popover>
  )
}

function GroupLabel({ children }: { children: string }): React.JSX.Element {
  return <div className="px-2.5 pt-1 pb-0.5 text-micro font-semibold text-ink-2">{children}</div>
}
