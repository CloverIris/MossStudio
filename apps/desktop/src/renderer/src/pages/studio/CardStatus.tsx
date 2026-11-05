import { useEffect, useState } from 'react'
import { Spinner, cn } from '../../components/ui'
import { cloverUrl } from '../../lib/clover'
import type { CardJobView } from './jobStatus'

/** The engine rewrites one preview file; `seq` makes every frame a new URL. */
export function previewSrc(path: string, seq: number): string {
  return `${cloverUrl(path)}&seq=${seq}`
}

/**
 * The live denoise picture. Two image slots: the next frame loads under the
 * current one and fades in on top only once decoded, so the card never
 * flashes blank between frames.
 */
export function LivePreview({ path, seq, alt }: { path: string; seq: number; alt: string }): React.JSX.Element {
  const src = previewSrc(path, seq)
  const [slots, setSlots] = useState<[string | null, string | null]>([null, null])
  const [front, setFront] = useState<0 | 1>(0)
  const [loaded, setLoaded] = useState<[boolean, boolean]>([false, false])
  const back = front === 0 ? 1 : 0

  useEffect(() => {
    if (slots[front] === src || slots[back] === src) return
    setSlots((current) => {
      const next: [string | null, string | null] = [...current]
      next[back] = src
      return next
    })
    setLoaded((current) => {
      const next: [boolean, boolean] = [...current]
      next[back] = false
      return next
    })
  }, [src, slots, front, back])

  return (
    <div data-live-preview className="absolute inset-0">
      {([0, 1] as const).map((slot) => {
        const value = slots[slot]
        if (!value) return null
        const isFront = slot === front && loaded[slot]
        return (
          <img
            key={slot}
            src={value}
            alt={isFront ? alt : ''}
            aria-hidden={isFront ? undefined : true}
            draggable={false}
            data-preview-front={isFront || undefined}
            onLoad={() => {
              setLoaded((current) => {
                const next: [boolean, boolean] = [...current]
                next[slot] = true
                return next
              })
              if (value === src) setFront(slot)
            }}
            className={cn(
              'absolute inset-0 size-full object-cover transition-opacity duration-200',
              isFront ? 'z-[1] opacity-100' : loaded[slot] ? 'z-0 opacity-100' : 'z-0 opacity-0',
            )}
          />
        )
      })}
    </div>
  )
}

/** Thin progress line along the bottom of the picture. */
export function ProgressStrip({ percent }: { percent?: number }): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label="生成进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
      className="absolute inset-x-0 bottom-0 z-[2] h-1 overflow-hidden bg-well-strong"
    >
      {percent === undefined ? (
        <div className="studio-progress-indeterminate h-full w-1/3 bg-accent" />
      ) : (
        <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}

/** What the picture area says while a run has not drawn anything yet, or ended without a picture. */
export function StatusOverlay({ view, hasPicture }: { view: CardJobView; hasPicture: boolean }): React.JSX.Element | null {
  if (view.active) {
    if (hasPicture) return null
    const text = view.phase === 'queued' ? view.detail : view.detail.split(' · ')[0]
    return (
      <div data-card-status={view.phase} className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-caption text-ink-2">
        {view.phase === 'queued' ? null : <Spinner className="text-ink-3" />}
        <span className="tabular">{text}</span>
      </div>
    )
  }
  if (view.state === 'failed' && view.outputs.length === 0) {
    return (
      <div data-card-status="failed" role="alert" className="absolute inset-0 flex items-center justify-center bg-danger-soft p-4 text-center text-caption text-danger">
        <span className="line-clamp-5 [overflow-wrap:anywhere]">{view.error}</span>
      </div>
    )
  }
  if (view.error && view.outputs.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-caption text-ink-2">
        <span className="line-clamp-5 [overflow-wrap:anywhere]">{view.error}</span>
      </div>
    )
  }
  if (view.state === 'canceled' && view.outputs.length === 0) {
    return <div data-card-status="canceled" className="absolute inset-0 flex items-center justify-center text-caption text-ink-2">已取消</div>
  }
  return null
}
