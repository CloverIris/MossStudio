import { X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import { ACTIVE_STATES, taskText, visibleTasks } from '../pages/models/logic'
import { DownloadActionIcon } from '../pages/models/ModelEntries'
import { Button, Group, ProgressBar, Row, cn, useToast } from './ui'

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
        const action = active ? '暂停' : task.state === 'error' ? '重试' : '继续'
        return (
          <Row
            key={task.id}
            className="py-3"
            title={task.label}
            description={
              <span className="flex flex-col gap-1.5">
                <span className={cn('tabular', task.state === 'error' && 'text-danger')}>{taskText(task)}</span>
                <ProgressBar value={progress} label={`${task.label} 下载进度`} />
                {detail && task.state !== 'error' ? (
                  <span className="truncate" title={detail}>
                    {detail}
                    {task.filesTotal ? ` · ${task.filesDone}/${task.filesTotal} 个文件` : ''}
                  </span>
                ) : null}
              </span>
            }
          >
            {/* The same labelled actions as the rows on the 模型 and LoRA tabs. */}
            <Button
              aria-label={`${action} ${task.label}`}
              disabled={disabled}
              onClick={() => void act(task.id, () => (active ? onPause(task) : onResume(task)))}
            >
              <DownloadActionIcon action={active ? 'pause' : 'resume'} label={action} />
              {action}
            </Button>
            <Button
              tone="ghost"
              aria-label={`取消 ${task.label}`}
              disabled={disabled}
              onClick={() => void act(task.id, () => onCancel(task))}
            >
              <X className="size-4" strokeWidth={1.6} />
              取消
            </Button>
          </Row>
        )
      })}
    </Group>
  )
}
