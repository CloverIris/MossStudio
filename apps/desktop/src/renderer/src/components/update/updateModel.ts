/**
 * What the update UI shows for an UpdaterState: the title bar chip, the
 * popover under it and the status lines in 设置 › 通知与更新. No React here.
 */
import { failedUpdateText, type UpdateBusyReason, type UpdateRestartResult, type UpdaterState } from '@shared/update'
import { bytes, date, dateTime, relative } from '../../lib/format'

export type ChipTone = 'quiet' | 'ready' | 'warn'

export interface ChipView {
  label: string
  tone: ChipTone
  /** 0–100 while downloading; null for an indeterminate step; undefined for no bar. */
  progress?: number | null
  /** Full sentence for screen readers and the tooltip. */
  description: string
}

const DOWNLOADING = new Set<UpdaterState['phase']>(['downloading', 'verifying', 'installing'])

export function isDownloading(state: UpdaterState): boolean {
  return DOWNLOADING.has(state.phase)
}

function downloadProgress(state: UpdaterState): number | null {
  if (state.phase !== 'downloading' || !state.progress) return null
  return Math.max(0, Math.min(100, state.progress.percent))
}

/** The version an update would bring, whichever field knows it. */
export function targetVersion(state: UpdaterState): string | null {
  return state.available?.version ?? state.pending ?? null
}

/**
 * The chip in the title bar. Nothing while there is nothing to do; a thin bar
 * while downloading; 重启以更新 once ready; 必须更新 (warning) when this
 * version may no longer generate; 新版本没能启动 (warning) on the first start
 * after a failed version was rolled back.
 */
export function chipView(state: UpdaterState | null): ChipView | null {
  if (!state || !state.supported) return null
  const version = targetVersion(state)
  const name = version ? `MossStudio ${version}` : 'MossStudio'
  const downloading = isDownloading(state)
  const progress = downloading ? downloadProgress(state) : undefined

  if (state.required) {
    return {
      label: '必须更新',
      tone: 'warn',
      progress,
      description: version ? `必须更新：这个版本已停止支持生成，请更新到 ${version}` : '必须更新：这个版本已停止支持生成，请更新',
    }
  }
  switch (state.phase) {
    case 'available':
      return version ? { label: `新版本 ${version}`, tone: 'quiet', description: `MossStudio ${version} 可以更新` } : null
    case 'downloading':
    case 'verifying':
    case 'installing':
      return {
        label: state.phase === 'downloading' ? '正在下载更新' : '正在准备更新',
        tone: 'quiet',
        progress,
        description:
          state.phase === 'downloading' && progress !== null
            ? `正在下载 ${name} 更新，${Math.round(progress ?? 0)}%`
            : `正在准备 ${name} 更新`,
      }
    case 'ready':
      return { label: '重启以更新', tone: 'ready', description: `${name} 已准备好，重启即可更新` }
    case 'waiting-idle':
      return { label: '空闲后重启', tone: 'quiet', description: '当前任务结束后会自动重启以更新' }
    case 'restarting':
      return { label: '正在重启…', tone: 'quiet', progress: null, description: '正在重启以更新' }
    case 'error':
      return version ? { label: '更新没有完成', tone: 'quiet', description: `更新没有完成：${state.error ?? '请稍后重试'}` } : null
    default:
      return state.failedNotice && state.failedVersion
        ? { label: '新版本没能启动', tone: 'warn', description: failedUpdateText(state.failedVersion, state.current).notice }
        : null
  }
}

/**
 * "2 个生成任务和 1 个模型下载" from what a restart would interrupt. `unknown` (main
 * could not tell, so it fails closed) is not a task and never goes in the list.
 */
export function busyList(busy: UpdateBusyReason[]): string {
  const labels = busy.filter((item) => item.kind !== 'unknown' && item.count > 0).map((item) => item.label)
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join('、')}和${labels.at(-1)}`
}

export function busySentence(busy: UpdateBusyReason[]): string {
  const list = busyList(busy)
  if (list) return `${list}正在进行，现在重启会中断。`
  return busy.length ? '暂时无法确认有没有任务在运行，现在重启可能会中断它们。' : ''
}

/**
 * What to tell the user after 重启以更新 or 回到上一个版本 when it did not restart.
 * null: nothing to say (restarting, or a busy restart, which the popover asks about).
 */
export function restartFeedback(
  result: UpdateRestartResult,
  action: 'restart' | 'rollback',
): { text: string; tone: 'info' | 'error' } | null {
  switch (result.status) {
    case 'restarting':
      return null
    case 'busy': {
      if (action === 'restart') return null
      const list = busyList(result.busy)
      return { text: list ? `${list}结束后，再回到上一个版本。` : '暂时无法确认有没有任务在运行，请稍后再回到上一个版本。', tone: 'info' }
    }
    case 'nothing-pending':
      return { text: action === 'restart' ? '更新还没有准备好，请稍后再试' : '没有可以回到的版本', tone: 'info' }
    case 'unsupported':
      return { text: result.reason, tone: 'error' }
    case 'failed':
      return { text: `没能重启：${result.error}。MossStudio 没有改动，可以稍后再试。`, tone: 'error' }
  }
}

export type PopoverAction =
  | 'download'
  | 'cancel-download'
  | 'restart'
  | 'restart-when-idle'
  | 'cancel-when-idle'
  | 'retry'
  | 'later'
  | 'retry-failed'
  | 'dismiss-failed'

export interface PopoverView {
  title: string
  meta: string
  /** A short line about the current step (progress, busy, waiting, error). */
  status: string | null
  statusTone: 'neutral' | 'warn' | 'danger'
  progress?: number | null
  /** Release notes; empty when there are none to show (the rollback notice). */
  notes: string
  notesUrl?: string
  required: boolean
  primary: PopoverAction | null
  secondary: PopoverAction | null
}

export const ACTION_LABEL: Record<PopoverAction, string> = {
  download: '下载更新',
  'cancel-download': '取消下载',
  restart: '重启以更新',
  'restart-when-idle': '空闲后自动重启',
  'cancel-when-idle': '取消自动重启',
  retry: '重试',
  later: '稍后',
  'retry-failed': '再试一次',
  'dismiss-failed': '知道了',
}

/**
 * Release notes without their own leading "## MossStudio 1.1.0" heading: the
 * popover already shows that title right above them.
 */
export function releaseNotes(notes: string | undefined, version: string | null): string {
  const text = notes?.trim() ?? ''
  const [first = '', ...rest] = text.split(/\r?\n/)
  const repeatsTitle = version !== null && /^#{1,6}\s/.test(first) && first.includes(version)
  return (repeatsTitle ? rest.join('\n').trim() : text) || '这次更新没有附加说明。'
}

/**
 * The popover under the chip. `busy` is what the last restart attempt said
 * would be interrupted.
 */
export function popoverView(state: UpdaterState, busy: UpdateBusyReason[] = []): PopoverView {
  const version = targetVersion(state)
  const available = state.available
  const meta = [
    `当前 ${state.current}`,
    available?.publishedAt && date(available.publishedAt) !== '—' ? `${date(available.publishedAt)}发布` : null,
    available && state.phase === 'available' ? bytes(available.downloadSize) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const base: PopoverView = {
    title: version ? `MossStudio ${version}` : 'MossStudio 更新',
    meta,
    status: null,
    statusTone: 'neutral',
    notes: releaseNotes(available?.notes, version),
    notesUrl: available?.notesUrl,
    required: state.required,
    primary: null,
    secondary: 'later',
  }
  // While ready, only this attempt's answer counts: reopening offers 重启以更新 again,
  // and a new attempt asks main afresh. While waiting, main's own list is current.
  const waitingOn = state.busy.length ? state.busy : busy

  switch (state.phase) {
    case 'available':
      return { ...base, primary: 'download' }
    case 'downloading': {
      const progress = downloadProgress(state)
      const amount = state.progress ? `${bytes(state.progress.bytes)} / ${bytes(state.progress.totalBytes)}` : ''
      return {
        ...base,
        status: `正在下载${amount ? ` ${amount}` : ''}。下载完成后，重启即可更新。`,
        progress,
        primary: null,
        secondary: 'cancel-download',
      }
    }
    case 'verifying':
    case 'installing':
      return { ...base, status: '正在检查并准备更新文件…', progress: null, secondary: null }
    case 'ready':
      if (busy.length) {
        return { ...base, status: busySentence(busy), statusTone: 'warn', primary: 'restart-when-idle', secondary: 'later' }
      }
      return { ...base, status: '更新已准备好。重启后就是新版本，作品和设置都会保留。', primary: 'restart', secondary: 'later' }
    case 'waiting-idle': {
      const list = busyList(waitingOn)
      return {
        ...base,
        status: list ? `等${list}结束后，会自动重启以更新。` : '当前任务结束后，会自动重启以更新。',
        primary: null,
        secondary: 'cancel-when-idle',
      }
    }
    case 'restarting':
      return { ...base, status: '正在重启…', progress: null, primary: null, secondary: null }
    case 'error':
      return { ...base, status: state.error ?? '更新没有完成，请稍后重试。', statusTone: 'danger', primary: 'retry' }
    default:
      if (state.failedNotice && state.failedVersion && !state.required) {
        const text = failedUpdateText(state.failedVersion, state.current)
        return {
          ...base,
          title: text.title,
          meta: `当前 ${state.current}`,
          status: text.detail,
          statusTone: 'warn',
          notes: '',
          notesUrl: undefined,
          primary: 'retry-failed',
          secondary: 'dismiss-failed',
        }
      }
      return { ...base, status: state.required ? '正在查找可以安装的版本…' : null, secondary: null }
  }
}

/** The status line under the version in 设置 › 通知与更新. */
export function settingsStatus(state: UpdaterState): string {
  const version = targetVersion(state)
  if (!state.supported) return state.unsupportedReason ?? '这份 MossStudio 不能在这里自动更新。'
  switch (state.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `有新版本 ${version}`
    case 'downloading':
      return state.progress ? `正在下载 ${version}：${Math.round(state.progress.percent)}%` : `正在下载 ${version}`
    case 'verifying':
    case 'installing':
      return `正在准备 ${version}`
    case 'ready':
      return `${version} 已准备好，重启即可更新`
    case 'waiting-idle':
      return `${version} 会在当前任务结束后安装`
    case 'restarting':
      return '正在重启以更新'
    case 'error':
      return state.error ?? '更新没有完成'
    default:
      return '已经是最新版本'
  }
}

export function checkedLabel(checkedAt: string | null): string {
  return checkedAt ? `上次检查：${relative(checkedAt)}` : '还没有检查过'
}

/** Exact time for the tooltip of the last-check label. */
export function checkedTitle(checkedAt: string | null): string | undefined {
  return checkedAt ? dateTime(checkedAt) : undefined
}

export const RELEASES_URL = 'https://github.com/CloverIris/MossStudio/releases'

/** Notes link for the settings row: the release's own page, else the releases list. */
export function notesLink(state: UpdaterState | null): string {
  return state?.available?.notesUrl ?? RELEASES_URL
}
