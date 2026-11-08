import { ChevronDown, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import type { DownloadGroup } from '../pages/models/logic'
import { DownloadProgress } from '../pages/models/DownloadProgress'
import { DownloadActionIcon } from '../pages/models/ModelEntries'
import { ModelName } from './common/ModelName'
import { Button, cn, Group, ProgressBar, useToast } from './ui'

/**
 * The download queue of one machine, one row per model: its name, one bar for
 * the whole model and 暂停 / 继续 / 取消 for all of it. The parts it is made of
 * fold out under the bar.
 */
export function DownloadQueue({
  groups,
  onPause,
  onResume,
  onCancel,
}: {
  groups: DownloadGroup[]
  onPause: (task: DownloadTask) => Promise<unknown>
  onResume: (group: DownloadGroup) => Promise<unknown>
  onCancel: (task: DownloadTask) => Promise<unknown>
}): React.JSX.Element | null {
  const toast = useToast()
  const [pending, setPending] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const inFlight = useRef(new Set<string>())
  async function act(key: string, action: () => Promise<unknown>): Promise<void> {
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setPending((current) => [...current, key])
    try {
      await action()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      inFlight.current.delete(key)
      setPending((current) => current.filter((item) => item !== key))
    }
  }
  if (!groups.length) return null
  return (
    <Group>
      {groups.map((group) => {
        const name = group.item.name
        const disabled = pending.includes(group.key) || group.progress.stateText === '连接中断'
        const open = expanded.includes(group.key)
        const toggle = (): void => setExpanded((current) => (open ? current.filter((key) => key !== group.key) : [...current, group.key]))
        const main = (): Promise<unknown> =>
          group.action === 'pause'
            ? Promise.all(group.open.filter((task) => task.state === 'queued' || task.state === 'running').map(onPause))
            : onResume(group)
        return (
          <div key={group.key} data-download-row className="flex w-full items-start gap-4 rounded-lg px-3.5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <DownloadProgress
                info={group.progress}
                label={`${name} 下载进度`}
                title={group.currentFile}
                heading={<ModelName item={group.item} className="text-control text-ink" />}
              />
              {group.parts.length > 1 ? (
                <>
                  {open ? (
                    <ul aria-label={`${name} 的部件`} className="flex flex-col gap-1.5 pt-1">
                      {group.parts.map((part) => (
                        <li
                          key={part.task.id}
                          className="tabular grid grid-cols-[5.5rem_minmax(0,1fr)_2.75rem_4.5rem] items-center gap-3 text-caption text-ink-2"
                        >
                          <span className="truncate">{part.role}</span>
                          <ProgressBar value={part.percent} tone={part.tone} label={`${part.role} 下载进度`} />
                          <span className="text-right">{part.done ? '完成' : `${part.percent}%`}</span>
                          <span className="text-right">{part.size}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={toggle}
                    className="inline-flex items-center gap-1 self-start rounded text-caption text-ink-2 transition-colors hover:text-ink"
                  >
                    <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} strokeWidth={1.6} />
                    {open ? '收起部件' : `${group.parts.length} 个部件`}
                  </button>
                </>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* The same labelled actions as the rows on the 模型 and LoRA tabs. */}
              <Button aria-label={`${group.actionLabel} ${name}`} disabled={disabled} onClick={() => void act(group.key, main)}>
                <DownloadActionIcon action={group.action} label={group.actionLabel} />
                {group.actionLabel}
              </Button>
              <Button
                tone="ghost"
                aria-label={`取消 ${name}`}
                disabled={disabled}
                onClick={() => void act(group.key, () => Promise.all(group.open.map(onCancel)))}
              >
                <X className="size-4" strokeWidth={1.6} />
                取消
              </Button>
            </div>
          </div>
        )
      })}
    </Group>
  )
}
