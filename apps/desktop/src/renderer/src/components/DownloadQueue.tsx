import { Pause, Play, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import { ACTIVE_STATES, taskText, visibleTasks } from '../pages/models/logic'
import { Group, IconButton, ProgressBar, cn, useToast } from './ui'

/** The download queue of one machine, with pause / resume / cancel per task. */
export function DownloadQueue({
  tasks,
  onPause,
  onResume,
  onCancel,
}: {
  tasks: DownloadTask[]
  onPause: (task: DownloadTask) => Promise<unknown>
  onResume: (task: DownloadTask) => Promise<unknown>
  onCancel: (task: DownloadTask) => Promise<unknown>
}): React.JSX.Element | null {
  const toast = useToast()
  const [pending, setPending] = useState<string[]>([])
  const inFlight = useRef(new Set<string>())
  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setPending((current) => [...current, id])
    try {
      await action()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      inFlight.current.delete(id)
      setPending((current) => current.filter((item) => item !== id))
    }
  }
  const shown = visibleTasks(tasks)
  if (!shown.length) return null
  return (
    <Group>
      {shown.map((task) => {
        const active = ACTIVE_STATES.has(task.state)
        const disabled = pending.includes(task.id) || Boolean(task.connectionError)
        const progress = task.totalBytes > 0 ? (Math.min(task.bytes, task.totalBytes) / task.totalBytes) * 100 : 0
        const detail = task.connectionError ?? task.error ?? task.currentFile
        return (
          <div key={task.id} className="flex items-center gap-4 rounded-lg px-3.5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="truncate text-control text-ink">{task.label}</span>
                <span className={cn('tabular text-caption', task.state === 'error' ? 'text-danger' : 'text-ink-2')}>{taskText(task)}</span>
              </div>
              <ProgressBar value={progress} label={`${task.label} 下载进度`} />
              {detail && task.state !== 'error' ? (
                <span className="truncate text-caption text-ink-2" title={detail}>
                  {detail}
                  {task.filesTotal ? ` · ${task.filesDone}/${task.filesTotal} 个文件` : ''}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {active ? (
                <IconButton label={`暂停 ${task.label}`} disabled={disabled} onClick={() => void act(task.id, () => onPause(task))}>
                  <Pause className="size-4" strokeWidth={1.6} />
                </IconButton>
              ) : (
                <IconButton
                  label={`${task.state === 'error' ? '重试' : '继续'} ${task.label}`}
                  disabled={disabled}
                  onClick={() => void act(task.id, () => onResume(task))}
                >
                  <Play className="size-4" strokeWidth={1.6} />
                </IconButton>
              )}
              <IconButton label={`取消 ${task.label}`} disabled={disabled} onClick={() => void act(task.id, () => onCancel(task))}>
                <X className="size-4" strokeWidth={1.6} />
              </IconButton>
            </div>
          </div>
        )
      })}
    </Group>
  )
}
