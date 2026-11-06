import type { EnginePlanView, EngineReadiness, MossInferDownloadState } from '@shared/types'
import { enginePackageSummary, enginePackageTitle, parseEnginePackageId } from '@shared/enginePackages'
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
  // Several packages (one per kind of GPU): say which one, e.g. "兼容模式（2/2）· 正在下载".
  const step =
    download.step && download.step.count > 1 && engineDownloadActive(download)
      ? `${packageLabel(download.step.packageId) ?? download.step.packageId}（${download.step.index + 1}/${download.step.count}）· `
      : ''
  if (download.phase === 'downloading' && download.totalBytes > 0) {
    // Nothing received yet is 0, not 未知: the size is known from the release.
    return `${step}${label} ${download.bytes > 0 ? bytes(download.bytes) : '0 MB'} / ${bytes(download.totalBytes)}`
  }
  return `${step}${label}`
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

/** One line per GPU for Setup and 设置 › 设备: what runs on it and how big the download is. */
export interface PlanLine {
  gpuId: string
  gpu: string
  /** "CUDA 13 引擎 · 369 MB", "兼容模式 · 1 MB", "不能运行引擎". */
  detail: string
  /** Plain trade-offs of a non-CUDA package. */
  note?: string
  /** A quiet suggestion (update the driver, install ROCm 7). */
  tip?: string
  supported: boolean
  /** Not used on purpose (an integrated GPU next to a discrete one), not a failure. */
  skipped?: boolean
}

export function planLines(plan: EnginePlanView): PlanLine[] {
  const firstUser = new Map<string, string>()
  return plan.choices.map((choice) => {
    const base = { gpuId: choice.gpuId, gpu: choice.gpuName, ...(choice.tip ? { tip: choice.tip } : {}) }
    if (choice.integratedSkipped) return { ...base, detail: '不使用（已有独立显卡）', supported: false, skipped: true }
    if (!choice.package || !choice.packageId) return { ...base, detail: choice.reason, supported: false }
    // The small system-CUDA package needs the computer's CUDA libraries: say so.
    const title =
      choice.package.kind === 'cuda'
        ? `${enginePackageTitle(choice.package)} 引擎${choice.package.runtime === 'system-cuda' ? '（使用系统 CUDA 运行库）' : ''}`
        : enginePackageTitle(choice.package)
    const shared = firstUser.get(choice.packageId)
    if (!shared) firstUser.set(choice.packageId, choice.gpuName)
    const missing = plan.missing.includes(choice.packageId)
    const size = shared ? `与 ${shared} 共用` : missing ? (choice.asset?.size ? bytes(choice.asset.size) : '待下载') : '已安装'
    return {
      ...base,
      detail: `${title} · ${size}`,
      ...(choice.package.kind !== 'cuda' ? { note: enginePackageSummary(choice.package) } : {}),
      supported: true,
    }
  })
}

/** Bytes still to download for the plan. */
export function planMissingBytes(plan: EnginePlanView): number {
  return plan.packages.filter((item) => plan.missing.includes(item.packageId)).reduce((sum, item) => sum + item.asset.size, 0)
}

/** "CUDA 13" / "兼容模式" for a package id; null for none, "自定义引擎" for a custom one. */
export function packageLabel(packageId: string | null | undefined): string | null {
  if (!packageId) return null
  if (packageId === 'custom') return '自定义引擎'
  const pkg = parseEnginePackageId(packageId)
  return pkg ? enginePackageTitle(pkg) : packageId
}
