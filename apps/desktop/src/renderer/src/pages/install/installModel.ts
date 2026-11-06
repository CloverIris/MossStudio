/**
 * What the setup window shows: which screen, the words for every folder
 * problem, the space line and the progress line. No React here.
 */
import { bytes } from '../../lib/format'

/**
 * The result of checking a folder in the setup main process (main/install/location.ts):
 * a code for the problem, its own message, and a usable alternative when there is one.
 */
export interface FolderCheck {
  ok: boolean
  problem: { code: string; message: string } | null
  suggestion: string | null
  freeBytes: number | null
  requiredBytes: number
}

export interface FolderMessage {
  text: string
  /** A folder the window offers to use instead, with the button label. */
  suggestion?: { path: string; label: string }
}

/** Plain words for a folder problem; codes this window does not know keep main's message. */
export function folderProblemMessage(check: FolderCheck): FolderMessage | null {
  if (check.ok || !check.problem) return null
  const suggestion = check.suggestion ? { path: check.suggestion, label: `改用 ${check.suggestion}` } : undefined
  switch (check.problem.code) {
    case 'E_NOT_EMPTY':
      return { text: '这个文件夹里已经有别的文件。为了不和它们混在一起，建议装到里面新建的 MossStudio 文件夹。', suggestion }
    case 'E_NOT_WRITABLE':
      return { text: '没有权限写入这个文件夹。请换一个位置，例如你自己的用户文件夹。', suggestion }
    case 'E_NO_SPACE':
      return {
        text: check.freeBytes !== null
          ? `这个磁盘的空间不够：需要 ${bytes(check.requiredBytes)}，只剩 ${bytes(check.freeBytes)}。请清理一些空间，或换一个磁盘。`
          : `这个磁盘的空间不够：需要 ${bytes(check.requiredBytes)}。请清理一些空间，或换一个磁盘。`,
        suggestion,
      }
    case 'E_SYSTEM_DIR':
    case 'E_DRIVE_ROOT':
      return { text: suggestion ? '不能装在系统文件夹或磁盘根目录。' : '不能装在系统文件夹或磁盘根目录，请换一个位置。', suggestion }
    default:
      return { text: check.problem.message, suggestion }
  }
}

/**
 * A line under an install location that is fine but not empty: a folder an uninstall left with
 * the data kept, whose data the install keeps using. Null for every other check.
 */
export function folderNote(check: { ok: boolean; kind: string } | null): string | null {
  return check?.ok && check.kind === 'data' ? '这个文件夹里有上次卸载时保留的作品、模型和设置，装好后会继续使用它们。' : null
}

/** The same folder, the way the OS compares paths (case-insensitive on Windows and macOS). */
export function sameFolder(platform: 'win32' | 'linux' | 'darwin', a: string, b: string): boolean {
  const norm = (path: string): string => {
    const trimmed = path.trim().replace(/[\\/]+$/, '')
    return platform === 'linux' ? trimmed : trimmed.replace(/\//g, platform === 'win32' ? '\\' : '/').toLowerCase()
  }
  return norm(a) === norm(b)
}

/**
 * Is the install going where the old install (or the kept data) already is? Then its data stays
 * in use and there is no choice to make: an old 1.0.x folder is converted in place; a folder an
 * uninstall left keeps its data/.
 */
export function legacyInPlace(
  platform: 'win32' | 'linux' | 'darwin',
  legacy: { root: string; source: string },
  location: { kind: string; path: string } | null,
): boolean {
  if (!location) return false
  return legacy.source === 'kept' ? location.kind === 'data' && sameFolder(platform, location.path, legacy.root) : location.kind === 'legacy'
}

/** "需要 820 MB · 可用 120 GB" (free space only when known). */
export function spaceLine(requiredBytes: number, freeBytes?: number | null): string {
  const need = `需要 ${bytes(requiredBytes)}`
  return freeBytes && freeBytes > 0 ? `${need} · 可用 ${bytes(freeBytes)}` : need
}

/** The install steps main reports (main/install/install.ts), plus how the run ended. */
export type InstallStep = 'prepare' | 'convert' | 'copy' | 'launcher' | 'record' | 'integrate' | 'done'

export interface InstallRunView {
  status: 'running' | 'done' | 'failed'
  step: InstallStep | null
  /** 0–100 over the whole install. */
  percent: number | null
}

const STEP_LABEL: Record<InstallStep, string> = {
  prepare: '正在准备…',
  convert: '正在整理旧版的程序文件…',
  copy: '正在复制文件…',
  launcher: '正在写入安装信息…',
  record: '正在写入安装信息…',
  integrate: '正在创建快捷方式…',
  done: '安装完成',
}

export function progressLabel(run: InstallRunView): string {
  if (run.status === 'failed') return '安装没有完成'
  if (run.status === 'done') return '安装完成'
  return STEP_LABEL[run.step ?? 'prepare']
}

/** The bar: indeterminate until a step reports a size. */
export function progressPercent(run: InstallRunView): number | null {
  if (run.status === 'done') return 100
  if (run.status === 'failed' || run.percent === null || !run.step || run.step === 'prepare') return null
  return Math.max(0, Math.min(100, run.percent))
}

export type SetupScreen = 'loading' | 'choose' | 'downgrade' | 'progress' | 'done' | 'failed'

/**
 * Which screen: a first install asks where; an update or repair goes straight
 * to progress; installing an older version asks once; then done or failed.
 */
export function setupScreen(input: {
  kind: 'first' | 'update' | 'repair' | 'downgrade' | null
  phase: 'idle' | 'installing' | 'done' | 'failed' | null
  downgradeAccepted: boolean
}): SetupScreen {
  if (input.phase === 'installing') return 'progress'
  if (input.phase === 'done') return 'done'
  if (input.phase === 'failed') return 'failed'
  if (!input.kind) return 'loading'
  if (input.kind === 'first') return 'choose'
  if (input.kind === 'downgrade' && !input.downgradeAccepted) return 'downgrade'
  return 'progress'
}

/** The progress view of a setup state's phase and last progress event. */
export function runView(phase: 'idle' | 'installing' | 'done' | 'failed', progress: { phase: InstallStep; percent: number } | null): InstallRunView {
  return {
    status: phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'running',
    step: progress?.phase ?? null,
    percent: progress?.percent ?? null,
  }
}

export interface OldInstallView {
  title: string
  description: string
}

export function oldInstallText(old: { root: string; dataBytes: number | null; version: string | null; dataDir?: string; source?: string }): OldInstallView {
  const size = old.dataBytes !== null && old.dataBytes > 0 ? `，共 ${bytes(old.dataBytes)}` : ''
  if (old.source === 'kept') {
    return {
      title: '发现上次保留的数据',
      description: `卸载 MossStudio${old.version ? ` ${old.version}` : ''} 时留下的作品、模型和设置，位于 ${old.dataDir ?? old.root}${size}。`,
    }
  }
  return {
    title: old.version ? `发现旧版 MossStudio ${old.version}` : '发现旧版 MossStudio',
    description: `位于 ${old.root}，里面有你的作品、模型和设置${size}。`,
  }
}

export function downgradeText(installed: string, setup: string): { title: string; description: string } {
  return {
    title: `换成较早的 ${setup}？`,
    description: `这台电脑上已经装有更新的 MossStudio ${installed}。换成 ${setup} 后，作品、模型和设置都会保留，但新版本才有的功能可能用不了。`,
  }
}
