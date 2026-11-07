import { AlertTriangle, ArrowUpCircle, ExternalLink, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { Notice } from '../common/Notice'
import { Popover } from '../common/Popover'
import { Button, MarkdownBody, ProgressBar, Spinner, cn, useToast } from '../ui'
import { ACTION_LABEL, chipView, popoverView, restartFeedback, type ChipView, type PopoverAction } from './updateModel'

// Ready is a state, not a second main action next to 生成: the accent tint, not solid ink.
const CHIP_TONE: Record<ChipView['tone'], string> = {
  quiet: 'bg-well text-ink hover:bg-raised',
  ready: 'bg-accent-soft text-ink font-medium hover:bg-raised',
  warn: 'bg-warn-soft text-warn font-medium hover:bg-raised',
}

function ChipIcon({ view }: { view: ChipView }): React.JSX.Element {
  if (view.tone === 'warn') return <AlertTriangle className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
  if (view.tone === 'ready') return <RotateCw className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
  return <ArrowUpCircle className="size-3.5 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
}

/**
 * The update chip in the title bar and its popover: version, notes and the
 * one thing to do next (download, restart, or wait until the work is done).
 */
export function UpdateChip(): React.JSX.Element | null {
  const toast = useToast()
  const state = useApp((s) => s.update)
  const open = useApp((s) => s.updatePopoverOpen)
  const busy = useApp((s) => s.updateBusy)
  const setOpen = useApp((s) => s.setUpdatePopoverOpen)
  const download = useApp((s) => s.downloadUpdate)
  const cancelDownload = useApp((s) => s.cancelUpdateDownload)
  const restart = useApp((s) => s.restartToUpdate)
  const setRestartWhenIdle = useApp((s) => s.setRestartWhenIdle)
  const check = useApp((s) => s.checkForUpdates)
  const retryFailed = useApp((s) => s.retryFailedUpdate)
  const dismissFailed = useApp((s) => s.dismissFailedUpdate)
  const [working, setWorking] = useState<PopoverAction | null>(null)
  const view = chipView(state)

  // Nothing to offer any more (e.g. the check found nothing): close.
  useEffect(() => {
    if (!view && open) setOpen(false)
  }, [view, open, setOpen])

  if (!state || !view) return null
  const panel = popoverView(state, busy)

  async function run(action: PopoverAction): Promise<void> {
    if (action === 'later') {
      setOpen(false)
      return
    }
    setWorking(action)
    try {
      if (action === 'download') await download()
      else if (action === 'cancel-download') await cancelDownload()
      else if (action === 'restart-when-idle') await setRestartWhenIdle(true)
      else if (action === 'cancel-when-idle') await setRestartWhenIdle(false)
      else if (action === 'retry-failed') await retryFailed()
      else if (action === 'dismiss-failed') {
        await dismissFailed()
        setOpen(false)
      } else if (action === 'retry') {
        if (state?.available) await download()
        else await check()
      } else if (action === 'restart') {
        const result = await restart()
        const feedback = restartFeedback(result, 'restart')
        if (feedback) toast.push(feedback.text, feedback.tone)
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="no-drag">
      <Popover
        role="dialog"
        label="更新"
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="w-[360px] p-4"
        trigger={({ toggle, open: shown, ...aria }) => (
          <button
            type="button"
            data-update-chip
            data-tone={view.tone}
            {...aria}
            aria-label={view.description}
            title={view.description}
            onClick={toggle}
            className={cn(
              'relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-[background-color,opacity]',
              CHIP_TONE[view.tone],
              shown && view.tone === 'quiet' && 'bg-raised',
            )}
          >
            <ChipIcon view={view} />
            <span className="whitespace-nowrap">{view.label}</span>
            {view.progress !== undefined ? (
              // The download at a glance: a thin bar along the chip's bottom edge.
              <span aria-hidden="true" className="absolute inset-x-2 bottom-[3px]">
                <ProgressBar value={view.progress} className="h-0.5" />
              </span>
            ) : null}
          </button>
        )}
      >
        {() => (
          <div data-update-popover className="flex flex-col gap-4">
            {panel.required ? (
              <Notice tone="warn" title="必须更新">
                这个版本已停止支持生成，更新后才能继续生成图片。
              </Notice>
            ) : null}

            <div className="flex flex-col gap-0.5">
              <h2 className="text-section font-semibold">{panel.title}</h2>
              {panel.meta ? <p className="tabular text-caption text-ink-2">{panel.meta}</p> : null}
            </div>

            {panel.status ? (
              <div className="flex flex-col gap-2">
                {/* Something to watch or that went wrong is a Notice, like 必须更新 above; progress stays a plain line. */}
                {panel.statusTone === 'neutral' ? (
                  <p role="status" className="text-ui text-ink-2">
                    {panel.status}
                  </p>
                ) : (
                  <Notice tone={panel.statusTone}>{panel.status}</Notice>
                )}
                {panel.progress !== undefined ? <ProgressBar value={panel.progress} label="更新进度" /> : null}
              </div>
            ) : null}

            {panel.notes ? (
              <div className="flex flex-col gap-1.5">
                <h3 className="text-caption font-medium text-ink-2">更新内容</h3>
                <div className="max-h-[240px] overflow-y-auto rounded-lg bg-well px-3 py-2.5">
                  <MarkdownBody>{panel.notes}</MarkdownBody>
                </div>
                {panel.notesUrl ? (
                  <Button
                    tone="ghost"
                    size="xs"
                    className="self-start"
                    onClick={() => void call(Ipc.openExternal, { url: panel.notesUrl })}
                  >
                    完整更新说明
                    <ExternalLink className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null}

            {panel.primary || panel.secondary ? (
              <div className="flex items-center justify-end gap-2">
                {panel.secondary ? (
                  <Button tone="ghost" size="md" disabled={working !== null} onClick={() => void run(panel.secondary!)}>
                    {working === panel.secondary ? <Spinner /> : null}
                    {ACTION_LABEL[panel.secondary]}
                  </Button>
                ) : null}
                {panel.primary ? (
                  <Button tone="primary" size="md" disabled={working !== null} onClick={() => void run(panel.primary!)}>
                    {working === panel.primary ? <Spinner /> : null}
                    {ACTION_LABEL[panel.primary]}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Popover>
    </div>
  )
}
