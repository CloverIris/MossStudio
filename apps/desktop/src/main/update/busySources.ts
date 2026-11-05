import { getEngineInstallProgress } from '../lib/engineStore'
import { mirrorOperationsInFlight as gitMirrorOperations } from '../services/git'
import { listDownloads } from '../services/models'
import { getMossInferDownloadState } from '../services/mossInferDownload'
import { listRemoteDownloads } from '../services/remoteDownloads'
import { listJobs } from '../services/supervisor'
import { mirrorOperationsInFlight as trainerMirrorOperations } from '../services/trainerGit'
import type { BusySnapshot } from './busy'

/**
 * The live stores: supervisor jobs (inference + training), model downloads (local and on SSH
 * hosts), engine downloads/installs and git mirror clones. Model imports keep no state in main
 * (they are a single awaited IPC call), so they cannot be counted. SSH terminal sessions do not
 * block a restart.
 */
export async function readBusySnapshot(): Promise<BusySnapshot> {
  // Errors propagate: the runtime fails closed ("无法确认是否有任务在运行").
  const jobs = await listJobs()
  return {
    jobs,
    downloads: [...listDownloads(), ...listRemoteDownloads()],
    engineDownloadPhase: getMossInferDownloadState()?.phase ?? null,
    engineInstalling: getEngineInstallProgress() !== null,
    gitOperations: gitMirrorOperations() + trainerMirrorOperations(),
  }
}
