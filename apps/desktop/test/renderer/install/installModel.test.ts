import { describe, expect, it } from 'vitest'
import {
  downgradeText,
  folderProblemMessage,
  folderNote,
  legacyInPlace,
  oldInstallText,
  sameFolder,
  progressLabel,
  progressPercent,
  runView,
  setupScreen,
  spaceLine,
  type FolderCheck,
} from '@renderer/pages/install/installModel'

const MB = 1024 ** 2
const GB = 1024 ** 3

function check(code: string | null, patch: Partial<FolderCheck> = {}): FolderCheck {
  return {
    ok: code === null,
    problem: code ? { code, message: `main says ${code}` } : null,
    suggestion: null,
    freeBytes: 120 * GB,
    requiredBytes: 820 * MB,
    ...patch,
  }
}

describe('folderProblemMessage', () => {
  it('says nothing for a usable folder', () => {
    expect(folderProblemMessage(check(null))).toBeNull()
    expect(folderProblemMessage({ ...check(null), ok: false })).toBeNull()
  })

  it('offers <chosen>\\MossStudio for a non-empty folder', () => {
    const message = folderProblemMessage(check('E_NOT_EMPTY', { suggestion: 'D:\\工具\\MossStudio' }))!
    expect(message.text).toContain('已经有别的文件')
    expect(message.suggestion).toEqual({ path: 'D:\\工具\\MossStudio', label: '改用 D:\\工具\\MossStudio' })
  })

  it('explains no write access and missing space with both sizes', () => {
    expect(folderProblemMessage(check('E_NOT_WRITABLE'))!.text).toBe('没有权限写入这个文件夹。请换一个位置，例如你自己的用户文件夹。')
    expect(folderProblemMessage(check('E_NO_SPACE', { freeBytes: 300 * MB }))!.text).toBe(
      '这个磁盘的空间不够：需要 820 MB，只剩 300 MB。请清理一些空间，或换一个磁盘。',
    )
    expect(folderProblemMessage(check('E_NO_SPACE', { freeBytes: null }))!.text).toBe(
      '这个磁盘的空间不够：需要 820 MB。请清理一些空间，或换一个磁盘。',
    )
  })

  it('refuses system folders and drive roots, with a suggestion when main has one', () => {
    expect(folderProblemMessage(check('E_SYSTEM_DIR'))).toEqual({
      text: '不能装在系统文件夹或磁盘根目录，请换一个位置。',
      suggestion: undefined,
    })
    expect(folderProblemMessage(check('E_DRIVE_ROOT', { suggestion: 'D:\\MossStudio' }))).toEqual({
      text: '不能装在系统文件夹或磁盘根目录。',
      suggestion: { path: 'D:\\MossStudio', label: '改用 D:\\MossStudio' },
    })
  })

  it("keeps main's own message for other problems", () => {
    expect(folderProblemMessage(check('E_TEMP_DIR'))).toEqual({ text: 'main says E_TEMP_DIR', suggestion: undefined })
    expect(folderProblemMessage(check('E_PORTABLE_ROOT'))).toEqual({ text: 'main says E_PORTABLE_ROOT', suggestion: undefined })
  })
})

describe('space and progress', () => {
  it('shows what is needed and what is free', () => {
    expect(spaceLine(820 * MB, 120 * GB)).toBe('需要 820 MB · 可用 120 GB')
    expect(spaceLine(820 * MB, null)).toBe('需要 820 MB')
    expect(spaceLine(820 * MB)).toBe('需要 820 MB')
  })

  it('names each step plainly', () => {
    const running = (step: Parameters<typeof progressLabel>[0]['step']) => progressLabel({ status: 'running', step, percent: 40 })
    expect(running(null)).toBe('正在准备…')
    expect(running('prepare')).toBe('正在准备…')
    expect(running('convert')).toBe('正在整理旧版的程序文件…')
    expect(running('copy')).toBe('正在复制文件…')
    expect(running('launcher')).toBe('正在写入安装信息…')
    expect(running('record')).toBe('正在写入安装信息…')
    expect(running('integrate')).toBe('正在创建快捷方式…')
    expect(running('done')).toBe('安装完成')
    expect(progressLabel({ status: 'done', step: 'done', percent: 100 })).toBe('安装完成')
    expect(progressLabel({ status: 'failed', step: 'copy', percent: 40 })).toBe('安装没有完成')
  })

  it('fills the bar from main and is indeterminate while preparing', () => {
    expect(progressPercent({ status: 'running', step: 'copy', percent: 62 })).toBe(62)
    expect(progressPercent({ status: 'running', step: 'copy', percent: 140 })).toBe(100)
    expect(progressPercent({ status: 'running', step: 'prepare', percent: 0 })).toBeNull()
    expect(progressPercent({ status: 'running', step: null, percent: null })).toBeNull()
    expect(progressPercent({ status: 'done', step: 'done', percent: 100 })).toBe(100)
    expect(progressPercent({ status: 'failed', step: 'copy', percent: 40 })).toBeNull()
  })
})

describe('setupScreen', () => {
  const screen = (
    kind: Parameters<typeof setupScreen>[0]['kind'],
    phase: Parameters<typeof setupScreen>[0]['phase'] = 'idle',
    downgradeAccepted = false,
  ) => setupScreen({ kind, phase, downgradeAccepted })

  it('asks where on a first install', () => {
    expect(screen(null, null)).toBe('loading')
    expect(screen('first')).toBe('choose')
  })

  it('asks nothing for an update or a repair', () => {
    expect(screen('update')).toBe('progress')
    expect(screen('repair')).toBe('progress')
  })

  it('asks once before a downgrade', () => {
    expect(screen('downgrade')).toBe('downgrade')
    expect(screen('downgrade', 'idle', true)).toBe('progress')
  })

  it('follows the run to done or failed', () => {
    expect(screen('first', 'installing')).toBe('progress')
    expect(screen('first', 'done')).toBe('done')
    expect(screen('downgrade', 'failed')).toBe('failed')
  })
})

describe('runView', () => {
  it('maps the setup phase and the last progress event', () => {
    expect(runView('installing', { phase: 'copy', percent: 30 })).toEqual({ status: 'running', step: 'copy', percent: 30 })
    expect(runView('idle', null)).toEqual({ status: 'running', step: null, percent: null })
    expect(runView('done', { phase: 'done', percent: 100 })).toMatchObject({ status: 'done' })
    expect(runView('failed', null)).toMatchObject({ status: 'failed' })
  })
})

describe('old install and downgrade wording', () => {
  it('describes the old install with its size when known', () => {
    expect(
      oldInstallText({ root: 'C:\\Users\\小明\\AppData\\Local\\Programs\\MossStudio', dataBytes: 8.5 * GB, version: '1.0.3' }),
    ).toEqual({
      title: '发现旧版 MossStudio 1.0.3',
      description: '位于 C:\\Users\\小明\\AppData\\Local\\Programs\\MossStudio，里面有你的作品、模型和设置，共 8.5 GB。',
    })
    expect(oldInstallText({ root: '/old', dataBytes: null, version: null })).toEqual({
      title: '发现旧版 MossStudio',
      description: '位于 /old，里面有你的作品、模型和设置。',
    })
  })

  it('describes data a keep-data uninstall left behind', () => {
    expect(
      oldInstallText({ root: 'C:\\MossStudio', dataDir: 'C:\\MossStudio\\data', dataBytes: 12 * GB, version: '1.9.0', source: 'kept' }),
    ).toEqual({
      title: '发现上次保留的数据',
      description: '卸载 MossStudio 1.9.0 时留下的作品、模型和设置，位于 C:\\MossStudio\\data，共 12 GB。',
    })
    expect(oldInstallText({ root: '/r', dataDir: '/r/data', dataBytes: null, version: null, source: 'kept' }).description).toBe(
      '卸载 MossStudio 时留下的作品、模型和设置，位于 /r/data。',
    )
  })

  it('notes a location whose kept data the install will use', () => {
    expect(folderNote({ ok: true, kind: 'data' })).toBe('这个文件夹里有上次卸载时保留的作品、模型和设置，装好后会继续使用它们。')
    expect(folderNote({ ok: false, kind: 'data' })).toBeNull()
    expect(folderNote({ ok: true, kind: 'empty' })).toBeNull()
    expect(folderNote(null)).toBeNull()
  })

  it('knows when the install goes where the old install or the kept data already is', () => {
    expect(sameFolder('win32', 'C:\\Moss\\', 'c:/moss')).toBe(true)
    expect(sameFolder('linux', '/a/Moss', '/a/moss')).toBe(false)
    expect(sameFolder('linux', '/a/moss/', '/a/moss')).toBe(true)
    const kept = { root: 'C:\\Moss', source: 'kept' }
    expect(legacyInPlace('win32', kept, { kind: 'data', path: 'c:\\moss' })).toBe(true)
    expect(legacyInPlace('win32', kept, { kind: 'data', path: 'D:\\Moss' })).toBe(false)
    expect(legacyInPlace('win32', kept, { kind: 'missing', path: 'C:\\Moss' })).toBe(false)
    expect(legacyInPlace('win32', { root: 'C:\\Old', source: 'registry' }, { kind: 'legacy', path: 'C:\\Old' })).toBe(true)
    expect(legacyInPlace('win32', kept, null)).toBe(false)
  })

  it('asks the downgrade question once, saying data is kept', () => {
    const text = downgradeText('1.2.0', '1.1.0')
    expect(text.title).toBe('换成较早的 1.1.0？')
    expect(text.description).toContain('已经装有更新的 MossStudio 1.2.0')
    expect(text.description).toContain('作品、模型和设置都会保留')
  })
})
