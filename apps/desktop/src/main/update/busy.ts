import type { DownloadTask, JobRecord } from '@shared/types'
import type { UpdateBusyReason } from '@shared/update'

/** Snapshots of everything a restart would interrupt. */
export interface BusySnapshot {
  jobs: readonly Pick<JobRecord, 'state' | 'kind'>[]
  downloads: readonly Pick<DownloadTask, 'state'>[]
  /** MossInfer download/install phase, if one is running. */
  engineDownloadPhase: string | null
  /** An engine install in progress (local or remote). */
  engineInstalling: boolean
  /** Git mirror clones/fetches in flight (inference repo + trainer). Remote SSH sessions do not count. */
  gitOperations?: number
}

const ACTIVE_JOB = new Set(['queued', 'starting', 'running'])
const ACTIVE_DOWNLOAD = new Set(['queued', 'running', 'verifying'])
const ENGINE_DONE = new Set(['done', 'error', 'canceled'])

export function busyReasons(snapshot: BusySnapshot): UpdateBusyReason[] {
  const reasons: UpdateBusyReason[] = []
  const active = snapshot.jobs.filter((job) => ACTIVE_JOB.has(job.state))
  const training = active.filter((job) => job.kind === 'training').length
  const inference = active.length - training
  if (inference) reasons.push({ kind: 'inference', count: inference, label: `${inference} 个生成任务` })
  if (training) reasons.push({ kind: 'training', count: training, label: `${training} 个训练任务` })
  const downloads = snapshot.downloads.filter((task) => ACTIVE_DOWNLOAD.has(task.state)).length
  if (downloads) reasons.push({ kind: 'model-download', count: downloads, label: `${downloads} 个模型下载` })
  const engine = (snapshot.engineDownloadPhase !== null && !ENGINE_DONE.has(snapshot.engineDownloadPhase)) || snapshot.engineInstalling
  if (engine) reasons.push({ kind: 'engine-download', count: 1, label: '推理引擎下载或安装' })
  const git = snapshot.gitOperations ?? 0
  if (git) reasons.push({ kind: 'git-clone', count: git, label: git > 1 ? `${git} 个代码仓库下载` : '代码仓库下载' })
  return reasons
}
