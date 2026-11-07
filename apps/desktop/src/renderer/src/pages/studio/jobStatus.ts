import type { JobProgress, JobRecord, ProjectCanvas } from '@shared/types'
import { ACTIVE_JOB_STATES, duration, jobProgressDetail, jobStateLabel } from '../../lib/format'

/** How a canvas card describes its generation state, in the shared job vocabulary (lib/format). Pure, no React. */

export { ACTIVE_JOB_STATES }

export type CardState = 'idle' | 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'lost'

/** Which part of a run a card is showing. */
export type CardPhase = 'queued' | 'loading' | 'text' | 'denoise' | 'decode' | 'save'

export interface CardJobView {
  state: CardState
  active: boolean
  /** Short status for the card header, e.g. "4 张 · 18 秒" or "生成中". */
  label: string
  /** Progress line while running, e.g. "12 / 30 · 约 8 秒" or "排队中 · 第 2 个". */
  detail: string
  /** 0–100 once the denoise stage reports steps; undefined means indeterminate. */
  percent?: number
  outputs: NonNullable<ProjectCanvas['outputs']>
  error?: string
  /** Set while active. */
  phase?: CardPhase
  /** 1-based place in the engine's queue while queued (0 = unknown). */
  queuePosition?: number
  /** The latest live picture while denoising; `seq` changes every time the engine rewrites it. */
  preview?: { path: string; seq: number }
  /** A failed run can be started again from the card. */
  retry?: boolean
}

function phaseOf(stage: JobProgress['stage']): CardPhase {
  if (stage === 'denoise' || stage === 'decode' || stage === 'save' || stage === 'text') return stage
  return 'loading'
}

/** 1-based position among queued inference jobs on the same GPU and machine. */
export function queuePosition(job: JobRecord, jobs: readonly JobRecord[]): number {
  if (job.state !== 'queued') return 0
  return (
    jobs
      .filter(
        (item) => item.kind === 'inference' && item.state === 'queued' && item.deviceUuid === job.deviceUuid && item.hostId === job.hostId,
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .findIndex((item) => item.id === job.id) + 1
  )
}

export function cardJobView(canvas: ProjectCanvas, job: JobRecord | undefined, jobs: readonly JobRecord[] = []): CardJobView {
  const outputs = job?.outputs?.length ? job.outputs : (canvas.outputs ?? [])
  const rawState = job?.state ?? canvas.jobState
  const lost = Boolean(canvas.jobId && !job && ACTIVE_JOB_STATES.has(canvas.jobState ?? ''))
  const state: CardState = lost ? 'lost' : (rawState ?? 'idle')
  const active = !lost && ACTIVE_JOB_STATES.has(state)
  const progress = job?.progress ?? canvas.progress
  const error = job?.error?.message ?? canvas.error?.message

  if (state === 'queued') {
    const position = job ? (job.queuePosition ?? queuePosition(job, jobs)) : 0
    return {
      state,
      active,
      label: jobStateLabel({ state }),
      detail: position > 0 ? `排队中 · 第 ${position} 个` : '排队中',
      outputs,
      phase: 'queued',
      queuePosition: position,
    }
  }
  if (state === 'starting' || state === 'running') {
    const stage = progress?.stage ?? 'idle'
    const phase = phaseOf(stage)
    const label = jobStateLabel({ state })
    // The last preview stays up while the picture is decoded and saved, so the card never goes blank.
    const preview =
      job?.preview?.path && (phase === 'denoise' || phase === 'decode' || phase === 'save')
        ? { path: job.preview.path, seq: job.preview.seq }
        : undefined
    const detail = jobProgressDetail(progress)
    if (phase === 'denoise' && progress && progress.total > 0) {
      const percent = Math.min(100, Math.max(0, progress.percent))
      return { state, active, label, detail, percent, outputs, phase, preview }
    }
    return { state, active, label, detail, outputs, phase, ...(preview ? { preview } : {}) }
  }
  if (state === 'succeeded') {
    const took = duration(job?.startedAt, job?.endedAt)
    const label = outputs.length ? [`${outputs.length} 张`, took].filter(Boolean).join(' · ') : '没有返回图片'
    return { state, active, label, detail: '', outputs, error: outputs.length ? undefined : '任务完成了，但没有返回图片' }
  }
  if (state === 'failed')
    return { state, active, label: jobStateLabel({ state }), detail: '', outputs, error: error ?? '生成失败', retry: true }
  if (state === 'canceled') return { state, active, label: jobStateLabel({ state }), detail: '', outputs }
  if (state === 'lost') return { state, active, label: '状态未知', detail: '', outputs, error: '应用重启过，这次生成的进度已无法找回' }
  return { state: 'idle', active: false, label: outputs.length ? `${outputs.length} 张` : '', detail: '', outputs }
}
