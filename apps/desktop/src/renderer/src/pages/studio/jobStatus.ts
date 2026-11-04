import type { JobProgress, JobRecord, ProjectCanvas } from '@shared/types'

/** How a canvas card describes its generation state. Pure, no React. */

export const ACTIVE_JOB_STATES = new Set(['queued', 'starting', 'running'])

export type CardState = 'idle' | 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'lost'

export interface CardJobView {
  state: CardState
  active: boolean
  /** Short status for the card header, e.g. "4 张 · 18 秒" or "生成中". */
  label: string
  /** Progress line while running, e.g. "去噪 · 13 / 20 步 · 约 6 秒". */
  detail: string
  /** 0–100 once the denoise stage reports steps; undefined means indeterminate. */
  percent?: number
  outputs: NonNullable<ProjectCanvas['outputs']>
  error?: string
}

const STAGE_LABELS: Record<string, string> = {
  idle: '准备引擎',
  ready: '准备引擎',
  load: '加载模型',
  text: '理解描述',
  denoise: '绘制',
  decode: '还原图像',
  save: '保存结果',
}

export function stageLabel(progress: Pick<JobProgress, 'stage'> | undefined): string {
  return STAGE_LABELS[progress?.stage ?? 'idle'] ?? '处理中'
}

export function formatEta(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `约 ${seconds} 秒`
  return `约 ${Math.ceil(seconds / 60)} 分钟`
}

export function formatDuration(startedAt: string | undefined, endedAt: string | undefined): string {
  if (!startedAt || !endedAt) return ''
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

/** 1-based position among queued inference jobs on the same GPU and machine. */
export function queuePosition(job: JobRecord, jobs: readonly JobRecord[]): number {
  if (job.state !== 'queued') return 0
  return jobs
    .filter((item) => item.kind === 'inference' && item.state === 'queued' && item.deviceUuid === job.deviceUuid && item.hostId === job.hostId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .findIndex((item) => item.id === job.id) + 1
}

export function cardJobView(canvas: ProjectCanvas, job: JobRecord | undefined, jobs: readonly JobRecord[] = []): CardJobView {
  const outputs = job?.outputs?.length ? job.outputs : canvas.outputs ?? []
  const rawState = job?.state ?? canvas.jobState
  const lost = Boolean(canvas.jobId && !job && ACTIVE_JOB_STATES.has(canvas.jobState ?? ''))
  const state: CardState = lost ? 'lost' : rawState ?? 'idle'
  const active = !lost && ACTIVE_JOB_STATES.has(state)
  const progress = job?.progress ?? canvas.progress
  const error = job?.error?.message ?? canvas.error?.message

  if (state === 'queued') {
    const position = job ? queuePosition(job, jobs) : 0
    return { state, active, label: position > 0 ? `排队第 ${position} 位` : '排队中', detail: '等待前面的任务完成', outputs }
  }
  if (state === 'starting' || state === 'running') {
    const steps = progress?.stage === 'denoise' && progress.total > 0
    const percent = steps ? Math.min(100, Math.max(0, progress.percent)) : undefined
    const parts = [steps ? `${progress.current} / ${progress.total} 步` : stageLabel(progress), formatEta(progress?.etaMs)].filter(Boolean)
    return { state, active, label: state === 'starting' ? '准备中' : '生成中', detail: parts.join(' · '), percent, outputs }
  }
  if (state === 'succeeded') {
    const duration = formatDuration(job?.startedAt, job?.endedAt)
    const label = outputs.length ? [`${outputs.length} 张`, duration].filter(Boolean).join(' · ') : '没有返回图片'
    return { state, active, label, detail: '', outputs, error: outputs.length ? undefined : '任务完成了，但没有返回图片' }
  }
  if (state === 'failed') return { state, active, label: '失败', detail: '', outputs, error: error ?? '生成失败' }
  if (state === 'canceled') return { state, active, label: '已取消', detail: '', outputs }
  if (state === 'lost') return { state, active, label: '状态未知', detail: '', outputs, error: '应用重启过，这次生成的进度已无法找回' }
  return { state: 'idle', active: false, label: outputs.length ? `${outputs.length} 张` : '', detail: '', outputs }
}
