import type { JobProgress, JobRecord } from '@shared/types'

/**
 * The one place that turns values into words. Every screen formats dates,
 * sizes, versions, strengths, durations and job states through here, so the
 * same thing reads the same everywhere (docs/reference/ui-rules.md).
 */

/* ------------------------------------------------------------------ */
/* Sizes and numbers                                                   */
/* ------------------------------------------------------------------ */

/** File and download sizes: "858 MB", "1.5 GB". */
export function bytes(value: number | null | undefined): string {
  if (!value || value <= 0) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

export function percent(current: number, total: number): number {
  if (!total) return 0
  return Math.max(0, Math.min(100, (current / total) * 100))
}

/** Picture size: "1024 × 1024", always with spaces around ×. */
export function dimensions(width: number, height: number): string {
  return `${width} × ${height}`
}

/**
 * A strength. `share` values run 0–1 and read as a percentage ("60%"); `weight`
 * values (LoRA, control, adapters) read as a plain multiplier ("0.8", "1").
 * An unset value is the engine default.
 */
export function strength(value: number | null | undefined, kind: 'share' | 'weight'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '默认'
  if (kind === 'share') return `${Math.round(value * 100)}%`
  return value.toFixed(2).replace(/\.?0+$/, '') || '0'
}

/** A version as people read it: no leading "v" ("v1.2.0" → "1.2.0"). */
export function version(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  return text.replace(/^v(?=\d)/i, '')
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/* ------------------------------------------------------------------ */
/* Dates and times                                                     */
/* ------------------------------------------------------------------ */

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Date only: "2026 年 11 月 4 日". */
export function date(value: string | number | Date | null | undefined): string {
  const parsed = toDate(value)
  if (!parsed) return '—'
  return `${parsed.getFullYear()} 年 ${parsed.getMonth() + 1} 月 ${parsed.getDate()} 日`
}

/** Date and time: "2026 年 11 月 4 日 14:32". */
export function dateTime(value: string | number | Date | null | undefined): string {
  const parsed = toDate(value)
  if (!parsed) return '—'
  return `${date(parsed)} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** Recent moments as "刚刚 / 5 分钟前 / 3 小时前 / 2 天前"; a week or older as the date. */
export function relative(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '从未'
  const parsed = toDate(value)
  if (!parsed) return '—'
  const diff = Date.now() - parsed.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return date(parsed)
}

/* ------------------------------------------------------------------ */
/* Durations                                                           */
/* ------------------------------------------------------------------ */

/** Time left: "约 6 秒", "约 3 分钟"; empty when unknown. */
export function eta(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `约 ${seconds} 秒`
  return `约 ${Math.ceil(seconds / 60)} 分钟`
}

/** Time taken: "18 秒", "2 分 5 秒", "3 分钟"; empty when unknown. */
export function duration(startedAt: string | undefined, endedAt: string | undefined): string {
  if (!startedAt || !endedAt) return ''
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

/* ------------------------------------------------------------------ */
/* Jobs: one vocabulary for the Activity panel and the Studio cards     */
/* ------------------------------------------------------------------ */

export const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set(['queued', 'starting', 'running'])

/** What a job is doing, in a word. */
export function jobStateLabel(job: Pick<JobRecord, 'state' | 'kind'>): string {
  switch (job.state) {
    case 'queued':
      return '排队中'
    case 'starting':
      return '准备中'
    case 'running':
      return job.kind === 'training' ? '训练中' : '生成中'
    case 'succeeded':
      return '完成'
    case 'failed':
      return '失败'
    case 'canceled':
      return '已取消'
  }
}

const STAGE_LABELS: Record<JobProgress['stage'], string> = {
  idle: '正在加载模型',
  ready: '正在加载模型',
  load: '正在加载模型',
  text: '理解描述',
  denoise: '绘制',
  decode: '还原图像',
  save: '保存结果',
}

/** The step of a run that is happening now. */
export function stageLabel(progress: Pick<JobProgress, 'stage'> | undefined): string {
  return STAGE_LABELS[progress?.stage ?? 'idle'] ?? '处理中'
}

/**
 * The progress line of a running job: "13 / 20 · 约 6 秒" while drawing,
 * otherwise the stage, e.g. "理解描述 · 约 8 秒".
 */
export function jobProgressDetail(progress: JobProgress | undefined): string {
  if (progress?.stage === 'denoise' && progress.total > 0) {
    return [`${progress.current} / ${progress.total}`, eta(progress.etaMs)].filter(Boolean).join(' · ')
  }
  return [stageLabel(progress), eta(progress?.etaMs)].filter(Boolean).join(' · ')
}

/** A job is named by what it draws (its prompt) or, for training, by the run. */
export function jobTitle(job: JobRecord): string {
  if (job.kind === 'training') return `训练 · ${job.trainerRunName ?? job.instanceName}`
  // Named after its canvas, as on the Studio card; the prompt only for jobs that have no canvas.
  if (job.canvasTitle?.trim()) return job.canvasTitle.trim()
  const prompt = job.params.prompt.trim()
  if (prompt) return prompt.length > 36 ? `${prompt.slice(0, 36)}…` : prompt
  return job.caseName ?? '生成'
}

/**
 * State plus the most useful detail, worded like the Studio card: queue place,
 * progress while running, the reason when failed, the size when done.
 */
export function jobSummary(job: JobRecord): string {
  const parts: string[] = [jobStateLabel(job)]
  if (job.state === 'queued') {
    if (job.queuePosition) parts.push(`第 ${job.queuePosition} 个`)
  } else if (job.kind === 'training' && (job.state === 'starting' || job.state === 'running')) {
    // A training run reports steps, not image stages.
    if (job.progress.total > 0) parts.push(`${job.progress.current} / ${job.progress.total}`)
    parts.push(eta(job.progress.etaMs))
  } else if (job.state === 'starting' || job.state === 'running') {
    parts.push(jobProgressDetail(job.progress))
  } else if (job.state === 'failed' && job.error?.message) {
    parts.push(job.error.message)
  } else if (job.state === 'succeeded' && job.kind !== 'training') {
    parts.push(dimensions(job.params.width, job.params.height))
  }
  return parts.filter(Boolean).join(' · ')
}
