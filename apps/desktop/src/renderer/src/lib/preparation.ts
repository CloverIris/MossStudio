import type { DownloadTask, MossInferDownloadState } from '@shared/types'
import { engineDownloadActive } from './engineInstall'

/** One thing being prepared: the runtime (engine packages) or the model files. */
export interface PreparationPart {
  id: 'engine' | 'model'
  done: number
  total: number
  speedBps: number
  finished: boolean
  failed: boolean
}

/** Everything being prepared, as one number to watch. */
export interface Preparation {
  done: number
  total: number
  /** 0–100. */
  percent: number
  speedBps: number
  /** Null until there is a speed to go by. */
  secondsLeft: number | null
  /** Still downloading or installing. */
  active: boolean
  /** A part stopped with an error or was paused. */
  failed: boolean
  parts: PreparationPart[]
}

const ACTIVE_TASK = new Set(['queued', 'running', 'verifying'])

function enginePart(download: MossInferDownloadState | null | undefined): PreparationPart | null {
  if (!download || download.phase === 'canceled') return null
  const active = engineDownloadActive(download)
  // Several packages download one after another; their sizes are not known up front, so each counts as the current one.
  const count = download.step?.count ?? 1
  const index = download.step?.index ?? 0
  const each = download.totalBytes
  const total = each * count
  // Past the download (verifying, unpacking) the current package counts as fetched.
  const current = download.phase === 'downloading' ? download.bytes : each
  const done = download.phase === 'done' ? total : Math.min(total, each * index + current)
  if (total <= 0 && !active) return null
  return {
    id: 'engine',
    done,
    total,
    speedBps: download.phase === 'downloading' ? download.speedBps : 0,
    finished: download.phase === 'done',
    failed: download.phase === 'error',
  }
}

function modelPart(tasks: readonly DownloadTask[]): PreparationPart | null {
  if (tasks.length === 0) return null
  const total = tasks.reduce((sum, task) => sum + task.totalBytes, 0)
  const done = tasks.reduce((sum, task) => sum + (task.state === 'done' ? task.totalBytes : Math.min(task.bytes, task.totalBytes)), 0)
  const speedBps = tasks.reduce((sum, task) => sum + (task.state === 'running' ? task.speedBps : 0), 0)
  return {
    id: 'model',
    done,
    total,
    speedBps,
    finished: tasks.every((task) => task.state === 'done'),
    failed: tasks.some((task) => task.state === 'error' || task.state === 'paused'),
  }
}

/**
 * The engine install and the model downloads as one progress: bytes done of
 * bytes to fetch, the combined speed and the time left. Null when nothing is
 * being prepared.
 */
export function preparationProgress(
  engineDownload: MossInferDownloadState | null | undefined,
  modelTasks: readonly DownloadTask[],
): Preparation | null {
  const parts = [enginePart(engineDownload), modelPart(modelTasks)].filter((part): part is PreparationPart => part !== null)
  const active = engineDownloadActive(engineDownload) || modelTasks.some((task) => ACTIVE_TASK.has(task.state))
  if (parts.length === 0) return null
  const done = parts.reduce((sum, part) => sum + part.done, 0)
  const total = parts.reduce((sum, part) => sum + part.total, 0)
  const speedBps = parts.reduce((sum, part) => sum + part.speedBps, 0)
  const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0
  const left = Math.max(0, total - done)
  return {
    done,
    total,
    percent,
    speedBps,
    secondsLeft: active && speedBps > 0 ? left / speedBps : null,
    active,
    failed: parts.some((part) => part.failed),
    parts,
  }
}

/** Local model downloads (not those of a remote host). */
export function localModelTasks(downloads: readonly DownloadTask[]): DownloadTask[] {
  return downloads.filter((task) => task.kind === 'model' && !task.hostId)
}

/** "还要约 18 分钟", in plain words. */
export function timeLeftLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  if (seconds < 60) return '不到 1 分钟'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`
}
