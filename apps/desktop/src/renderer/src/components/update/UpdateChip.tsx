import { AlertTriangle, ArrowUpCircle, ExternalLink, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { Button, MarkdownBody, ProgressBar, Spinner, cn, useToast } from '../ui'
import { ACTION_LABEL, chipView, popoverView, restartFeedback, type ChipView, type PopoverAction } from './updateModel'

const CHIP_TONE: Record<ChipView['tone'], string> = {
  quiet: 'bg-well text-ink hover:bg-raised',
  ready: 'bg-ink text-on-ink font-medium hover:opacity-90',
  warn: 'bg-warn-soft text-warn font-medium hover:bg-raised',
}

function ChipIcon({ view }: { view: ChipView }): React.JSX.Element {
  if (view.tone === 'warn') return <AlertTriangle className="size-3.5" aria-hidden="true" />
  if (view.tone === 'ready') return <RotateCw className="size-3.5" aria-hidden="true" />
  return <ArrowUpCircle className="size-3.5 text-ink-2" aria-hidden="true" />
}

/** A 2px bar along the chip's bottom edge: the download at a glance. */
function ChipProgress({ value }: { value: number | null }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="absolute inset-x-2 bottom-[3px] h-0.5 overflow-hidden rounded-full bg-well-strong">
      <span
        className={cn('block h-full rounded-full bg-accent transition-[width] duration-300', value === null && 'animate-pulse')}
        style={{ width: `${value ?? 100}%` }}
      />
    </span>
  )
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
  const root = useRef<HTMLDivElement>(null)
  const view = chipView(state)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLElement>('[data-update-chip]')?.focus()
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

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
    <div ref={root} className="no-drag relative">
      <button
        type="button"
        data-update-chip
        data-tone={view.tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={view.description}
        title={view.description}
        onClick={() => setOpen(!open)}
        className={cn(
          'relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption transition-[background-color,opacity]',
          CHIP_TONE[view.tone],
          open && view.tone === 'quiet' && 'bg-raised',
        )}
      >
        <ChipIcon view={view} />
        <span className="whitespace-nowrap">{view.label}</span>
        {view.progress !== undefined ? <ChipProgress value={view.progress} /> : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="更新"
          data-update-popover
          className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-[380px] flex-col gap-4 rounded-xl bg-raised p-4 text-ink shadow-float"
        >
          {panel.required ? (
            <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-ui text-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              <span>
                <span className="font-semibold">必须更新。</span>这个版本已停止支持生成，更新后才能继续生成图片。
              </span>
            </p>
          ) : null}

          <div className="flex flex-col gap-0.5">
            <h2 className="text-section font-semibold">{panel.title}</h2>
            {panel.meta ? <p className="tabular text-caption text-ink-2">{panel.meta}</p> : null}
          </div>

          {panel.status ? (
            <div className="flex flex-col gap-2" role="status">
              <p
                className={cn(
                  'text-ui',
                  panel.statusTone === 'danger' ? 'text-danger' : panel.statusTone === 'warn' ? 'text-ink' : 'text-ink-2',
                )}
              >
                {panel.statusTone === 'warn' ? (
                  <AlertTriangle className="mr-1.5 inline size-4 -translate-y-px text-warn" aria-hidden="true" />
                ) : null}
                {panel.status}
              </p>
              {panel.progress !== undefined ? (
                <ProgressBar value={panel.progress ?? 100} tone={panel.progress === null ? 'neutral' : 'accent'} label="更新进度" />
              ) : null}
            </div>
          ) : null}

          {panel.notes ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-caption font-medium text-ink-2">更新内容</h3>
              <div className="max-h-[240px] overflow-y-auto rounded-lg bg-well px-3 py-2.5">
                <MarkdownBody>{panel.notes}</MarkdownBody>
              </div>
              {panel.notesUrl ? (
                <button
                  type="button"
                  className="flex items-center gap-1 self-start rounded-md px-1 text-caption text-ink-2 transition-colors hover:text-ink"
                  onClick={() => void call(Ipc.openExternal, { url: panel.notesUrl })}
                >
                  完整更新说明
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </button>
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
      ) : null}
    </div>
  )
}
