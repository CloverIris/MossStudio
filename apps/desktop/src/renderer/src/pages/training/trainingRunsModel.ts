import type { JobRecord, JobState } from '@shared/types'

export type RunTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

export interface TrainingRunRow {
  id: string
  name: string
  algo: string
  step: number
  total: number
  /** "1,200 / 2,000", or "—" before the trainer reports a total. */
  progressLabel: string
  percent: number
  state: JobState
  stateLabel: string
  tone: RunTone
  loss: number | null
  active: boolean
  startedAt: string
}

const STATE_LABEL: Record<JobState, string> = {
  queued: '排队中',
  starting: '启动中',
  running: '训练中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已停止',
}

const STATE_TONE: Record<JobState, RunTone> = {
  queued: 'neutral',
  starting: 'accent',
  running: 'accent',
  succeeded: 'ok',
  failed: 'danger',
  canceled: 'neutral',
}

const number = new Intl.NumberFormat('en-US')

function locationOf(job: JobRecord): string {
  return job.hostId || 'local'
}

/** Training job records for one location, newest first, shaped for the runs list. */
export function trainingRuns(jobs: readonly JobRecord[], hostId: string): TrainingRunRow[] {
  return jobs
    .filter((job) => job.kind === 'training' && locationOf(job) === hostId)
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((job) => {
      const total = job.progress.total > 0 ? job.progress.total : 0
      const step = job.metrics?.step ?? job.progress.current ?? 0
      const percent = total ? Math.max(0, Math.min(100, (step / total) * 100)) : Math.max(0, Math.min(100, job.progress.percent || 0))
      const loss = typeof job.metrics?.loss === 'number' && Number.isFinite(job.metrics.loss) ? job.metrics.loss : null
      const active = job.state === 'queued' || job.state === 'starting' || job.state === 'running'
      const stateLabel =
        job.state === 'running' && loss !== null ? `${STATE_LABEL.running} · loss ${loss.toFixed(3)}` : STATE_LABEL[job.state]
      return {
        id: job.id,
        name: job.trainerRunName || job.instanceName || '未命名训练',
        algo: (job.trainerAlgo || '').toUpperCase() || '—',
        step,
        total,
        progressLabel: total ? `${number.format(step)} / ${number.format(total)}` : '—',
        percent,
        state: job.state,
        stateLabel,
        tone: STATE_TONE[job.state],
        loss,
        active,
        startedAt: job.startedAt,
      }
    })
}
