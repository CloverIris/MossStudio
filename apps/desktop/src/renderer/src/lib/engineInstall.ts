import type { EngineReadiness, MossInferDownloadState } from '@shared/types'
import { bytes } from './format'

/** Result of the main process' system CUDA check (`Ipc.engineSystemCuda`). */
export interface SystemCudaCheck {
  supported: boolean
  gpu: string
  cublasLt: string[]
  driverVersion?: string
  driverCompatible?: boolean
  error?: string
}

export type EngineInstallPlan =
  | { kind: 'install'; variant: 'system-cuda' | 'bundled'; channel: 'stable'; architecture: 'auto' }
  | { kind: 'driver'; message: string }

/**
 * Pick the engine package without asking. The small system-CUDA package is
 * used when the computer already has a matching CUDA library; otherwise the
 * package that brings its own CUDA libraries. An outdated driver cannot be
 * worked around by the app, so it is reported in plain words instead.
 */
export function planEngineInstall(check: SystemCudaCheck | null): EngineInstallPlan {
  if (check?.driverCompatible === false) {
    return {
      kind: 'driver',
      message: `显卡驱动版本过旧${check.driverVersion ? `（当前 ${check.driverVersion}）` : ''}。请先到 NVIDIA 官网更新显卡驱动，然后重试。`,
    }
  }
  return {
    kind: 'install',
    channel: 'stable',
    architecture: 'auto',
    variant: check?.supported ? 'system-cuda' : 'bundled',
  }
}

const PHASE_LABELS: Record<MossInferDownloadState['phase'], string> = {
  querying: '正在查找最新版本',
  downloading: '正在下载',
  verifying: '正在校验',
  extracting: '正在安装',
  cuda_libs: '正在准备运行库',
  done: '安装完成',
  error: '安装失败',
  canceled: '已取消',
}

export function engineDownloadActive(download: MossInferDownloadState | null | undefined): boolean {
  return Boolean(download && !['done', 'error', 'canceled'].includes(download.phase))
}

/** One line describing an engine install in progress, e.g. "正在下载 186 MB / 290 MB". */
export function engineDownloadLabel(download: MossInferDownloadState): string {
  const label = PHASE_LABELS[download.phase]
  if (download.phase === 'downloading' && download.totalBytes > 0) {
    return `${label} ${bytes(download.bytes)} / ${bytes(download.totalBytes)}`
  }
  return label
}

/** Percent for a progress bar, or null while the phase has no measurable progress. */
export function engineDownloadPercent(download: MossInferDownloadState): number | null {
  if (download.phase === 'done') return 100
  if (download.phase === 'downloading' && download.totalBytes > 0) return Math.max(0, Math.min(100, download.percent))
  return null
}

/** The error of the last install attempt, unless the engine works anyway. */
export function engineInstallError(
  readiness: EngineReadiness | null | undefined,
  download: MossInferDownloadState | null | undefined,
): string | null {
  if (download?.phase === 'error') return download.error ?? '引擎安装失败'
  if (readiness?.state !== 'ready' && readiness?.lastAttempt?.error) return readiness.lastAttempt.error
  return null
}
