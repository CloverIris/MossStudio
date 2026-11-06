import { describe, expect, it } from 'vitest'
import {
  ACTION_LABEL,
  RELEASES_URL,
  busyList,
  busySentence,
  checkedLabel,
  checkedTitle,
  chipView,
  isDownloading,
  notesLink,
  popoverView,
  restartFeedback,
  settingsStatus,
  targetVersion,
} from '@renderer/components/update/updateModel'
import type { UpdateBusyReason } from '@shared/update'
import {
  FIXTURE_NOW,
  updateAvailableFixture,
  updateDownloadingFixture,
  updateFailedFixture,
  updateReadyFixture,
  updaterStateFixture,
} from '../../mocks/backend'

const JOB: UpdateBusyReason = { kind: 'inference', count: 2, label: '2 个生成任务' }
const DOWNLOAD: UpdateBusyReason = { kind: 'model-download', count: 1, label: '1 个模型下载' }
const TRAINING: UpdateBusyReason = { kind: 'training', count: 1, label: '1 个训练任务' }

describe('chipView', () => {
  it('shows nothing without a state, for a copy that cannot update, and while idle or checking', () => {
    expect(chipView(null)).toBeNull()
    expect(chipView(updateAvailableFixture('1.1.0', { supported: false, unsupportedReason: '开发版本' }))).toBeNull()
    expect(chipView(updaterStateFixture())).toBeNull()
    expect(chipView(updaterStateFixture({ phase: 'checking' }))).toBeNull()
  })

  it('offers a new version quietly', () => {
    expect(chipView(updateAvailableFixture('1.1.0'))).toEqual({ label: '新版本 1.1.0', tone: 'quiet', description: 'MossStudio 1.1.0 可以更新' })
  })

  it('carries the download progress, clamped, and is indeterminate while preparing', () => {
    expect(chipView(updateDownloadingFixture('1.1.0', 42))).toMatchObject({ label: '正在下载更新', tone: 'quiet', progress: 42, description: '正在下载 MossStudio 1.1.0 更新，42%' })
    expect(chipView(updateDownloadingFixture('1.1.0', 140))!.progress).toBe(100)
    expect(chipView(updateDownloadingFixture('1.1.0', 0, { progress: null }))).toMatchObject({ progress: null, description: '正在准备 MossStudio 1.1.0 更新' })
    expect(chipView(updateDownloadingFixture('1.1.0', 100, { phase: 'verifying' }))).toMatchObject({ label: '正在准备更新', progress: null })
    expect(chipView(updateDownloadingFixture('1.1.0', 100, { phase: 'installing' }))).toMatchObject({ label: '正在准备更新', progress: null })
  })

  it('asks for a restart once the update is ready', () => {
    expect(chipView(updateReadyFixture('1.1.0'))).toEqual({ label: '重启以更新', tone: 'ready', description: 'MossStudio 1.1.0 已准备好，重启即可更新' })
    expect(chipView(updateReadyFixture('1.1.0', { available: null }))!.description).toBe('MossStudio 1.1.0 已准备好，重启即可更新')
  })

  it('says 必须更新 as a warning whenever the update is required, keeping the progress bar', () => {
    expect(chipView(updateAvailableFixture('1.1.0', { required: true }))).toMatchObject({ label: '必须更新', tone: 'warn', description: '必须更新：这个版本已停止支持生成，请更新到 1.1.0' })
    expect(chipView(updateDownloadingFixture('1.1.0', 30, { required: true }))).toMatchObject({ label: '必须更新', tone: 'warn', progress: 30 })
    expect(chipView(updateReadyFixture('1.1.0', { required: true }))).toMatchObject({ label: '必须更新', progress: undefined })
    expect(chipView(updaterStateFixture({ required: true }))!.description).toBe('必须更新：这个版本已停止支持生成，请更新')
  })

  it('covers waiting, restarting and a failed update', () => {
    expect(chipView(updateReadyFixture('1.1.0', { phase: 'waiting-idle' }))).toMatchObject({ label: '空闲后重启', tone: 'quiet' })
    expect(chipView(updateReadyFixture('1.1.0', { phase: 'restarting' }))).toMatchObject({ label: '正在重启…', progress: null })
    expect(chipView(updateAvailableFixture('1.1.0', { phase: 'error', error: '网络断开' }))).toMatchObject({ label: '更新没有完成', description: '更新没有完成：网络断开' })
    expect(chipView(updateAvailableFixture('1.1.0', { phase: 'error' }))!.description).toBe('更新没有完成：请稍后重试')
    // A failed check with nothing to offer stays quiet.
    expect(chipView(updaterStateFixture({ phase: 'error', error: '网络断开' }))).toBeNull()
  })

  it('stays hidden for an available phase that names no version', () => {
    expect(chipView(updaterStateFixture({ phase: 'available' }))).toBeNull()
  })
})

describe('a version rolled back after a failed start', () => {
  it('shows a warning chip only on the start that tells about it, and only when nothing else is going on', () => {
    expect(chipView(updateFailedFixture('1.1.0'))).toEqual({
      label: '新版本没能启动', tone: 'warn',
      description: 'MossStudio 1.1.0 没能正常启动，已经自动回到 1.0.3。你的作品、模型和设置都没有受影响。',
    })
    expect(chipView(updateFailedFixture('1.1.0', { failedNotice: false }))).toBeNull()
    expect(chipView(updateFailedFixture('1.1.0', { phase: 'available', available: updateAvailableFixture('1.2.0').available }))?.label).toBe('新版本 1.2.0')
  })

  it('explains in the popover and offers 再试一次 / 知道了, without release notes', () => {
    const view = popoverView(updateFailedFixture('1.1.0'))
    expect(view).toMatchObject({
      title: '1.1.0 没能正常启动', meta: '当前 1.0.3', statusTone: 'warn', notes: '', primary: 'retry-failed', secondary: 'dismiss-failed',
    })
    expect(view.status).toBe('更新到 1.1.0 后它没能正常打开，所以 MossStudio 回到了 1.0.3，之后也不会再自动提示这个版本。如果当时是你自己关掉了它，可以放心再试一次。')
    expect(ACTION_LABEL['retry-failed']).toBe('再试一次')
    expect(ACTION_LABEL['dismiss-failed']).toBe('知道了')
    expect(popoverView(updateFailedFixture('1.1.0', { failedNotice: false })).primary).toBeNull()
  })
})

describe('busy wording', () => {
  it('lists what a restart would interrupt in plain Chinese', () => {
    expect(busyList([])).toBe('')
    expect(busyList([JOB])).toBe('2 个生成任务')
    expect(busyList([JOB, DOWNLOAD])).toBe('2 个生成任务和1 个模型下载')
    expect(busyList([JOB, TRAINING, DOWNLOAD])).toBe('2 个生成任务、1 个训练任务和1 个模型下载')
    expect(busyList([{ ...JOB, count: 0 }, DOWNLOAD])).toBe('1 个模型下载')
    expect(busySentence([JOB])).toBe('2 个生成任务正在进行，现在重启会中断。')
    expect(busySentence([])).toBe('')
  })
})

describe('popoverView', () => {
  it('offers the download with version, date and size when 自动下载更新 is off', () => {
    const view = popoverView(updateAvailableFixture('1.1.0'))
    expect(view).toMatchObject({
      title: 'MossStudio 1.1.0',
      meta: '当前 1.0.3 · 2026年10月30日发布 · 46 MB',
      primary: 'download',
      secondary: 'later',
      required: false,
      notesUrl: 'https://github.com/CloverIris/MossStudio/releases/tag/v1.1.0',
    })
    expect(view.notes).toContain('生成更快')
  })

  it('falls back to a plain line when the release has no notes', () => {
    const state = updateAvailableFixture('1.1.0')
    state.available!.notes = '  '
    expect(popoverView(state).notes).toBe('这次更新没有附加说明。')
    expect(popoverView(updaterStateFixture()).title).toBe('MossStudio 更新')
  })

  it('shows download progress with sizes and lets the download be canceled', () => {
    const view = popoverView(updateDownloadingFixture('1.1.0', 50))
    expect(view).toMatchObject({ progress: 50, primary: null, secondary: 'cancel-download' })
    expect(view.status).toBe('正在下载 23 MB / 46 MB。下载完成后，重启即可更新。')
    expect(view.meta).toBe('当前 1.0.3 · 2026年10月30日发布')
    expect(popoverView(updateDownloadingFixture('1.1.0', 0, { progress: null })).status).toBe('正在下载。下载完成后，重启即可更新。')
    expect(popoverView(updateDownloadingFixture('1.1.0', 100, { phase: 'verifying' }))).toMatchObject({ progress: null, primary: null, secondary: null })
  })

  it('offers 重启以更新 when ready and nothing is running', () => {
    expect(popoverView(updateReadyFixture('1.1.0'))).toMatchObject({ primary: 'restart', secondary: 'later', statusTone: 'neutral' })
  })

  it('says what is running and offers 空闲后自动重启 / 稍后 when a restart would interrupt work', () => {
    const fromAnswer = popoverView(updateReadyFixture('1.1.0'), [JOB])
    expect(fromAnswer).toMatchObject({ status: '2 个生成任务正在进行，现在重启会中断。', statusTone: 'warn', primary: 'restart-when-idle', secondary: 'later' })
    // Reopened without a fresh answer: offer the restart again (main re-checks), whatever main last listed.
    expect(popoverView(updateReadyFixture('1.1.0', { busy: [DOWNLOAD] }))).toMatchObject({ primary: 'restart' })
  })

  it('while waiting for idle, names the work and offers to cancel', () => {
    expect(popoverView(updateReadyFixture('1.1.0', { phase: 'waiting-idle', busy: [JOB] }))).toMatchObject({
      status: '等2 个生成任务结束后，会自动重启以更新。', primary: null, secondary: 'cancel-when-idle',
    })
    expect(popoverView(updateReadyFixture('1.1.0', { phase: 'waiting-idle' })).status).toBe('当前任务结束后，会自动重启以更新。')
  })

  it('shows restarting and a failure with 重试', () => {
    expect(popoverView(updateReadyFixture('1.1.0', { phase: 'restarting' }))).toMatchObject({ status: '正在重启…', primary: null, secondary: null })
    expect(popoverView(updateAvailableFixture('1.1.0', { phase: 'error', error: '校验失败' }))).toMatchObject({ status: '校验失败', statusTone: 'danger', primary: 'retry' })
    expect(popoverView(updateAvailableFixture('1.1.0', { phase: 'error' })).status).toBe('更新没有完成，请稍后重试。')
  })

  it('flags a required update', () => {
    expect(popoverView(updateAvailableFixture('1.1.0', { required: true })).required).toBe(true)
    expect(popoverView(updaterStateFixture({ required: true }))).toMatchObject({ status: '正在查找可以安装的版本…', primary: null })
  })

  it('leaves out a publish date it cannot read', () => {
    const state = updateAvailableFixture('1.1.0')
    state.available!.publishedAt = 'not a date'
    expect(popoverView(state).meta).toBe('当前 1.0.3 · 46 MB')
  })
})

describe('settings lines', () => {
  it('describes every phase', () => {
    expect(settingsStatus(updaterStateFixture())).toBe('已经是最新版本')
    expect(settingsStatus(updaterStateFixture({ phase: 'checking' }))).toBe('正在检查更新…')
    expect(settingsStatus(updateAvailableFixture('1.1.0'))).toBe('有新版本 1.1.0')
    expect(settingsStatus(updateDownloadingFixture('1.1.0', 33.4))).toBe('正在下载 1.1.0：33%')
    expect(settingsStatus(updateDownloadingFixture('1.1.0', 0, { progress: null }))).toBe('正在下载 1.1.0')
    expect(settingsStatus(updateDownloadingFixture('1.1.0', 100, { phase: 'installing' }))).toBe('正在准备 1.1.0')
    expect(settingsStatus(updateReadyFixture('1.1.0'))).toBe('1.1.0 已准备好，重启即可更新')
    expect(settingsStatus(updateReadyFixture('1.1.0', { phase: 'waiting-idle' }))).toBe('1.1.0 会在当前任务结束后安装')
    expect(settingsStatus(updateReadyFixture('1.1.0', { phase: 'restarting' }))).toBe('正在重启以更新')
    expect(settingsStatus(updaterStateFixture({ phase: 'error', error: '网络断开' }))).toBe('网络断开')
    expect(settingsStatus(updaterStateFixture({ phase: 'error' }))).toBe('更新没有完成')
  })

  it('gives the reason when this copy cannot update here', () => {
    expect(settingsStatus(updaterStateFixture({ supported: false, phase: 'unsupported', unsupportedReason: '这是开发版本，不能在这里更新。' }))).toBe('这是开发版本，不能在这里更新。')
    expect(settingsStatus(updaterStateFixture({ supported: false, phase: 'unsupported' }))).toBe('这份 MossStudio 不能在这里自动更新。')
  })

  it('labels the last check', () => {
    expect(checkedLabel(null)).toBe('还没有检查过')
    expect(checkedLabel(new Date().toISOString())).toBe('上次检查：刚刚')
    expect(checkedTitle(null)).toBeUndefined()
    expect(checkedTitle(FIXTURE_NOW)).toMatch(/2026/)
  })

  it('links the release notes of the offered version, else the releases page', () => {
    expect(notesLink(updateAvailableFixture('1.1.0'))).toBe('https://github.com/CloverIris/MossStudio/releases/tag/v1.1.0')
    expect(notesLink(updaterStateFixture())).toBe(RELEASES_URL)
    expect(notesLink(null)).toBe(RELEASES_URL)
  })
})

describe('helpers', () => {
  it('knows the downloading phases and the target version', () => {
    expect(isDownloading(updateDownloadingFixture())).toBe(true)
    expect(isDownloading(updateReadyFixture())).toBe(false)
    expect(targetVersion(updateReadyFixture('1.2.0', { available: null }))).toBe('1.2.0')
    expect(targetVersion(updaterStateFixture())).toBeNull()
  })
})

describe('busy checks that fail closed', () => {
  const UNKNOWN: UpdateBusyReason = { kind: 'unknown', count: 1, label: '无法确认是否有任务在运行' }
  const GIT: UpdateBusyReason = { kind: 'git-clone', count: 1, label: '代码仓库下载' }

  it('never lists "unknown" as a task, but still says a restart may interrupt something', () => {
    expect(busyList([UNKNOWN])).toBe('')
    expect(busySentence([UNKNOWN])).toBe('暂时无法确认有没有任务在运行，现在重启可能会中断它们。')
    expect(busySentence([UNKNOWN, GIT])).toBe('代码仓库下载正在进行，现在重启会中断。')
    expect(popoverView(updateReadyFixture('1.1.0'), [UNKNOWN])).toMatchObject({ statusTone: 'warn', primary: 'restart-when-idle' })
  })
})

describe('restartFeedback', () => {
  it('says nothing while restarting, or for a busy restart (the popover asks)', () => {
    expect(restartFeedback({ status: 'restarting' }, 'restart')).toBeNull()
    expect(restartFeedback({ status: 'busy', busy: [JOB] }, 'restart')).toBeNull()
  })

  it('tells a busy rollback to wait, naming the work', () => {
    expect(restartFeedback({ status: 'busy', busy: [JOB] }, 'rollback')).toEqual({ text: '2 个生成任务结束后，再回到上一个版本。', tone: 'info' })
    expect(restartFeedback({ status: 'busy', busy: [{ kind: 'unknown', count: 1, label: 'x' }] }, 'rollback')!.text).toBe('暂时无法确认有没有任务在运行，请稍后再回到上一个版本。')
  })

  it('explains nothing-pending, unsupported and a launcher that could not start', () => {
    expect(restartFeedback({ status: 'nothing-pending' }, 'restart')).toEqual({ text: '更新还没有准备好，请稍后再试', tone: 'info' })
    expect(restartFeedback({ status: 'nothing-pending' }, 'rollback')).toEqual({ text: '没有可以回到的版本', tone: 'info' })
    expect(restartFeedback({ status: 'unsupported', reason: '开发版本' }, 'restart')).toEqual({ text: '开发版本', tone: 'error' })
    expect(restartFeedback({ status: 'failed', error: '启动程序没有响应' }, 'rollback')).toEqual({
      text: '没能重启：启动程序没有响应。MossStudio 没有改动，可以稍后再试。', tone: 'error',
    })
  })
})

