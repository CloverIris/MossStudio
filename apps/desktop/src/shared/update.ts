/**
 * The update runtime's view for the UI: one state object, pushed on every change
 * (Events.updateState) and returned by every update IPC call.
 */
import type { UpdateChannel } from './install'

export type UpdatePhase =
  /** This copy cannot update itself (dev build, portable without launcher, …): see `unsupportedReason`. */
  | 'unsupported'
  | 'idle'
  | 'checking'
  /** A newer version is offered and not downloaded yet. */
  | 'available'
  | 'downloading'
  | 'verifying'
  /** Unpacking and verifying app-<v>.partial. */
  | 'installing'
  /** `pending` is materialized: restart to switch to it. */
  | 'ready'
  /** Waiting for jobs/downloads to finish before restarting (restart-when-idle). */
  | 'waiting-idle'
  | 'restarting'
  | 'error'

export type UpdateBusyKind =
  | 'inference'
  | 'training'
  | 'model-download'
  | 'engine-download'
  /** A git mirror clone/fetch (inference repo or trainer). */
  | 'git-clone'
  /** The busy check itself failed: treated as busy (fail closed). */
  | 'unknown'

/** Something that a restart would interrupt. */
export interface UpdateBusyReason {
  kind: UpdateBusyKind
  /** Chinese, ready to show: e.g. "2 个生成任务". */
  label: string
  count: number
}

export interface UpdateAvailable {
  version: string
  publishedAt: string
  /** Markdown from the verified feed. */
  notes: string
  notesUrl?: string
  /** Bytes to download (the delta when one applies). */
  downloadSize: number
  kind: 'full' | 'delta'
}

export interface UpdateProgress {
  bytes: number
  totalBytes: number
  speedBps: number
  percent: number
}

export interface UpdateAnnouncement {
  id: string
  level: 'info' | 'warning' | 'critical'
  title: string
  body: string
  url?: string
  until?: string
}

export interface UpdaterState {
  /** False in dev, portable without launcher, or a setup run; the UI hides download/restart. */
  supported: boolean
  /** Chinese, shown when `supported` is false. */
  unsupportedReason: string | null
  current: string
  channel: UpdateChannel
  autoDownload: boolean
  phase: UpdatePhase
  checkedAt: string | null
  available: UpdateAvailable | null
  progress: UpdateProgress | null
  /** Downloaded and materialized; the next restart switches to it. */
  pending: string | null
  /** Kept for rollback (回到上一个版本). */
  previous: string | null
  canRollback: boolean
  /** From the verified feed: clients below it must update before generating. */
  minimumVersion: string | null
  /** current < minimumVersion: generation is blocked until the update is installed. */
  required: boolean
  /** What a restart would interrupt right now (filled by restart, restart-when-idle and while waiting). */
  busy: UpdateBusyReason[]
  restartWhenIdle: boolean
  /** Chinese message of the last failure, cleared by the next successful step. */
  error: string | null
  /** Announcements from the verified feed, minus dismissed and expired ones. */
  announcements: UpdateAnnouncement[]
  /**
   * The version the user rolled back from (回到上一个版本). It and anything not newer is not
   * offered again until update:unskip (Settings › 更新: 安装 <v>).
   */
  skippedVersion: string | null
  /**
   * The newest version newer than this one that failed its first start and was rolled back
   * automatically (install.json `failed`: the launcher or the macOS swap helper). Checks never
   * offer it by themselves; 再试一次 (update:retry-failed) clears it and downloads it again.
   */
  failedVersion: string | null
  /**
   * The first start after that rollback: tell the user once (title bar and a notification).
   * Cleared by update:dismiss-failed and gone on the next start.
   */
  failedNotice: boolean
}

export type UpdateRestartResult =
  | { status: 'restarting' }
  /** The launcher or the macOS helper could not be started; the app stays open (state.error). */
  | { status: 'failed'; error: string }
  | { status: 'busy'; busy: UpdateBusyReason[] }
  | { status: 'nothing-pending' }
  | { status: 'unsupported'; reason: string }

/** Chinese text for the blocked-generation error and the UI. */
export function requiredUpdateMessage(minimumVersion: string): string {
  return `必须更新：当前版本已停止支持生成，请先更新到 ${minimumVersion} 或更高版本（设置 › 更新）。`
}

/**
 * Chinese text about a version that failed its first start and was rolled back to `current`:
 * the one-time notice (notification and title bar popover) and the 设置 › 通知与更新 row.
 */
export function failedUpdateText(version: string, current: string): { title: string; notice: string; detail: string } {
  return {
    title: `${version} 没能正常启动`,
    notice: `MossStudio ${version} 没能正常启动，已经自动回到 ${current}。你的作品、模型和设置都没有受影响。`,
    detail: `更新到 ${version} 后它没能正常打开，所以 MossStudio 回到了 ${current}，之后也不会再自动提示这个版本。如果当时是你自己关掉了它，可以放心再试一次。`,
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Semver 2.0 precedence: a < b → negative, equal → 0, a > b → positive. A prerelease sorts below
 * its release; prerelease identifiers compare numerically when both are numeric, numeric below
 * alphanumeric, and a longer identifier list wins when all shared ones are equal. Unparseable
 * versions sort below everything so they are never offered.
 */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim())
  const pb = SEMVER.exec(b.trim())
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff) return diff
  }
  const ra = pa[4]
  const rb = pb[4]
  if (ra === undefined || rb === undefined) return ra === undefined ? (rb === undefined ? 0 : 1) : -1
  const ia = ra.split('.')
  const ib = rb.split('.')
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    const x = ia[i]
    const y = ib[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff) return diff
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
