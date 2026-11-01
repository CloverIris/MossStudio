import { ChevronDown, Download, Pause, Play, RefreshCw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import { percent } from '../lib/format'
import { Card, IconButton, ProgressBar, cn, useToast } from './ui'

export const downloadLabels: Record<DownloadTask['state'], string> = {
  queued: '等待下载', running: '下载中', verifying: '校验中', paused: '已暂停',
  done: '已完成', error: '下载失败', canceled: '已取消',
}
const bytes = (value: number): string => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB`
  : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : value >= 1e3 ? `${(value / 1e3).toFixed(1)} KB` : `${value} B`

export function DownloadQueue({ tasks, title = '下载队列', onPause, onResume, onCancel, onRefresh }: {
  tasks: DownloadTask[]
  title?: string
  onPause: (task: DownloadTask) => Promise<unknown>
  onResume: (task: DownloadTask) => Promise<unknown>
  onCancel: (task: DownloadTask) => Promise<unknown>
  onRefresh?: () => Promise<unknown>
}): React.JSX.Element | null {
  const toast = useToast()
  const [pending, setPending] = useState<string[]>([])
  const inFlight = useRef(new Set<string>())
  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    setPending((current) => [...current, id])
    try { await action() }
    catch (error) { toast.push(error instanceof Error ? error.message : String(error), 'error') }
    finally { inFlight.current.delete(id); setPending((current) => current.filter((item) => item !== id)) }
  }
  const visibleTasks = tasks.filter((task) => task.state !== 'done')
  if (!visibleTasks.length) return null
  return (
    <Card className="overflow-hidden">
      <details open>
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-ui font-medium">
          <span className="flex items-center gap-2"><Download className="size-4 text-accent-400" />{title}<span className="text-[var(--color-text-tertiary)]">{visibleTasks.length}</span></span>
          <ChevronDown className="size-4" />
        </summary>
        {onRefresh ? <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] px-4 py-2 text-caption text-[var(--color-text-tertiary)]">
          <span>关闭启动器后远端仍会下载，重新连接后自动恢复进度。</span>
          <IconButton label="刷新远端下载状态" disabled={pending.includes('refresh')} onClick={() => void act('refresh', onRefresh)}><RefreshCw className="size-4" /></IconButton>
        </div> : null}
        <div className="max-h-[320px] divide-y divide-[var(--color-border-subtle)] overflow-y-auto border-t border-[var(--color-border-subtle)]">
          {visibleTasks.map((task) => {
            const active = ['running', 'queued', 'verifying'].includes(task.state)
            const disabled = pending.includes(task.id) || Boolean(task.connectionError)
            const progress = percent(task.bytes, task.totalBytes)
            return (
              <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="truncate text-ui font-medium">{task.label}</span>
                    <span className={cn('text-ui tabular-nums', task.state === 'error' ? 'text-red-300' : 'text-[var(--color-text-secondary)]')}>
                      {task.connectionError ? '连接中断 · 上次进度' : downloadLabels[task.state]} · {bytes(task.bytes)} / {task.totalBytes ? bytes(task.totalBytes) : '待查询'}{task.totalBytes > 0 ? ` · ${progress.toFixed(1)}%` : ''}
                    </span>
                  </div>
                  <ProgressBar value={progress} className="mt-2" />
                  <p className="mt-1.5 truncate text-caption text-[var(--color-text-tertiary)]" title={task.connectionError ?? task.error ?? task.currentFile}>
                    {task.connectionError ?? task.error ?? task.currentFile ?? '正在获取文件清单'}
                    {!task.connectionError && task.speedBps > 0 ? ` · ${bytes(task.speedBps)}/s` : ''}
                    {task.filesTotal ? ` · ${task.filesDone}/${task.filesTotal} 个文件` : ''}
                  </p>
                  {task.remotePath ? <p className="mt-1 truncate font-mono text-caption text-[var(--color-text-tertiary)]" title={task.remotePath}>{task.remotePath}</p> : null}
                </div>
                {task.state !== 'done' ? active ? (
                  <IconButton label={`暂停 ${task.label}`} disabled={disabled} onClick={() => void act(task.id, () => onPause(task))}><Pause className="size-4" /></IconButton>
                ) : (
                  <IconButton label={`${task.state === 'error' ? '重试' : '继续'} ${task.label}`} disabled={disabled} onClick={() => void act(task.id, () => onResume(task))}><Play className="size-4" /></IconButton>
                ) : null}
                <IconButton label={`${task.state === 'done' ? '移除记录' : '取消'} ${task.label}`} disabled={disabled} onClick={() => void act(task.id, () => onCancel(task))}><X className="size-4" /></IconButton>
              </div>
            )
          })}
        </div>
      </details>
    </Card>
  )
}
