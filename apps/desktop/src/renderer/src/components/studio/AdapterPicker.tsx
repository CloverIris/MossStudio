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
      description="为这个 Canvas 叠加若干适配器；强度在生成设置里逐个调整。"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button tone="ghost" onClick={() => void importFiles()} disabled={importing}>
            {importing ? <Spinner className="size-4" /> : <FilePlus2 className="size-4" />}
            导入 .safetensors
          </Button>
          <Button tone="primary" data-dialog-initial-focus onClick={onClose}>完成</Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、id 或基底模型"
            className="w-full pl-8"
            aria-label="搜索 LoRA"
          />
        </div>

        <div className="max-h-[46vh] min-h-24 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]">
          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center text-caption leading-5 text-[var(--color-text-tertiary)]">
              {selectable.length === 0
                ? <>模型库里还没有 LoRA。用下面的「导入 .safetensors」把本地文件加入模型库。</>
                : <>没有匹配「{query.trim()}」的 LoRA。</>}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
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
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                        active ? 'bg-accent-500/[0.08]' : 'hover:bg-white/[0.03]',
                      )}
                    >
                      <span className={cn(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                        active ? 'border-accent-400 bg-accent-500/25 text-accent-100' : 'border-[var(--color-border)]',
                      )}>
                        {active ? <Check className="size-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui text-[var(--color-text)]">{entry.name}</span>
                        <span className="block truncate font-mono text-micro text-[var(--color-text-tertiary)]">
                          {entry.id}{entry.base ? ` · ${entry.base}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-caption uppercase text-[var(--color-text-tertiary)]">{entry.kind}</span>
                      <span className="w-16 shrink-0 text-right text-caption tabular-nums text-[var(--color-text-tertiary)]">{bytes(entry.sizeBytes)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {orphans.length ? (
          <div className="rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
            <p className="text-caption text-amber-200">以下 LoRA 已不在模型库里，生成前需要移除：</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {orphans.map((row) => (
                <button
                  key={row.adapter.id}
                  type="button"
                  onClick={() => onToggle(row.adapter.id)}
                  className="rounded-full border border-amber-500/40 px-2 py-0.5 text-caption text-amber-100 hover:bg-amber-500/10"
                >
                  {row.name} · 移除
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="text-caption leading-4 text-[var(--color-text-tertiary)]">
          适配器按选择顺序叠加，强度 0–2，默认 1。
          {hiddenDmd ? ' 8 步 DMD 由采样档位自动启用，不在列表中重复出现。' : ''}
        </p>
      </div>
    </Modal>
  )
}
