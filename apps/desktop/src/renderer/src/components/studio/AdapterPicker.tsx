import { Check, FilePlus2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AdapterEntry, CanvasAdapter } from '@shared/types'
import { adapterStatuses, isSelectableAdapter } from '@shared/adapters'
import { Button, Input, Modal, Spinner, cn } from '../ui'
import { bytes } from '../../lib/format'

interface Props {
  open: boolean
  selected: readonly CanvasAdapter[]
  catalog: readonly AdapterEntry[] | null | undefined
  onClose: () => void
  onToggle: (id: string) => void
  onImport: () => Promise<void>
}

/**
 * Multi-select over the model library. Selection applies immediately, so the
 * sampler row behind the dialog always shows what the next job will send.
 */
export function AdapterPicker({ open, selected, catalog, onClose, onToggle, onImport }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState(false)
  const chosen = useMemo(() => new Set(selected.map((item) => item.id)), [selected])
  const selectable = useMemo(() => (catalog ?? []).filter(isSelectableAdapter), [catalog])
  const hiddenDmd = useMemo(
    () => (catalog ?? []).filter((entry) => entry.installed && entry.kind === 'dmd').length,
    [catalog],
  )
  // A project can reference adapters that were uninstalled later; surface them so
  // the user can drop them instead of hunting for a missing entry.
  const orphans = useMemo(
    () => adapterStatuses(selected, catalog).filter((row) => !row.installed),
    [selected, catalog],
  )
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = needle
      ? selectable.filter((entry) =>
          entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle) || entry.base?.toLowerCase().includes(needle))
      : selectable
    return [...rows].sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [selectable, query, chosen])

  async function importFiles(): Promise<void> {
    setImporting(true)
    try {
      await onImport()
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="选择 LoRA"
      description="给这个画面叠加 LoRA；强度在左侧面板里逐个调整。"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={() => void importFiles()} disabled={importing}>
            {importing ? <Spinner className="size-4" /> : <FilePlus2 className="size-4" />}
            导入文件
          </Button>
          <Button tone="primary" size="md" data-dialog-initial-focus onClick={onClose}>完成</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称"
            className="pl-9"
            aria-label="搜索 LoRA"
          />
        </div>

        <div className="max-h-[46vh] min-h-24 overflow-y-auto rounded-xl bg-panel p-1.5">
          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center text-ui text-ink-2">
              {selectable.length === 0
                ? <>模型库里还没有 LoRA。用下面的「导入文件」把电脑上的 .safetensors 文件加进来。</>
                : <>没有名称包含「{query.trim()}」的 LoRA。</>}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((entry) => {
                const active = chosen.has(entry.id)
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onToggle(entry.id)}
                      aria-pressed={active}
                      data-adapter-option={entry.id}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                        active ? 'bg-well-strong' : 'hover:bg-well',
                      )}
                    >
                      <span className={cn(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                        active ? 'bg-accent text-on-accent' : 'bg-well-strong',
                      )}>
                        {active ? <Check className="size-3" aria-hidden="true" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-control text-ink">{entry.name}</span>
                        {entry.base ? <span className="block truncate text-caption text-ink-2">适用于 {entry.base}</span> : null}
                      </span>
                      <span className="tabular w-16 shrink-0 text-right text-caption text-ink-2">{bytes(entry.sizeBytes)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {orphans.length ? (
          <div className="flex flex-col gap-2 rounded-lg bg-warn-soft px-3 py-2.5">
            <p className="text-caption text-warn">下面的 LoRA 已经不在模型库里，生成前需要移除：</p>
            <div className="flex flex-wrap gap-1.5">
              {orphans.map((row) => (
                <Button key={row.adapter.id} tone="secondary" size="sm" className="h-7 px-2.5" onClick={() => onToggle(row.adapter.id)}>
                  移除「{row.name}」
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="text-caption text-ink-2">
          按选择顺序叠加，强度 0–2，默认 1。
          {hiddenDmd ? '「快速」质量自带的加速组件会自动启用，不在这里列出。' : ''}
        </p>
      </div>
    </Modal>
  )
}
