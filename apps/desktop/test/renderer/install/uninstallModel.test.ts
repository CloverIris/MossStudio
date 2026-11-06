import { describe, expect, it } from 'vitest'
import { dataChoiceText, uninstallEntry, uninstallSummary } from '@renderer/pages/install/uninstallModel'

const GB = 1024 ** 3

describe('uninstall wording', () => {
  it('shows the data size and place, and that it is kept unless ticked', () => {
    expect(dataChoiceText({ dataBytes: 8.5 * GB, dataRoot: 'C:\\MossStudio\\data' })).toBe('共 8.5 GB，位于 C:\\MossStudio\\data。不勾选的话会保留，重新安装后可以继续使用。')
    expect(dataChoiceText({ dataBytes: null, dataRoot: '/home/小明/.local/share/MossStudio/data' })).toBe('位于 /home/小明/.local/share/MossStudio/data。不勾选的话会保留，重新安装后可以继续使用。')
    expect(dataChoiceText({ dataBytes: 0, dataRoot: null })).toBe('不勾选的话会保留，重新安装后可以继续使用。')
  })

  it('says what will go, per platform and choice', () => {
    expect(uninstallSummary(false, 'plan')).toBe('MossStudio 的程序文件和快捷方式会被删除。你的作品、模型和设置会保留。')
    expect(uninstallSummary(true, 'plan')).toBe('MossStudio 的程序文件和快捷方式会被删除，你的作品、模型和设置也会一起删除，无法恢复。')
    expect(uninstallSummary(false, 'trash')).toBe('MossStudio 会被移到废纸篓。你的作品、模型和设置会保留。')
  })
})

describe('uninstallEntry (设置 › 关于)', () => {
  const installed = { portable: false }

  it('offers the button on macOS and Linux installs', () => {
    expect(uninstallEntry({ platform: 'darwin', info: installed, inAppOnWindows: false })).toEqual({ kind: 'button' })
    expect(uninstallEntry({ platform: 'linux', info: installed, inAppOnWindows: false })).toEqual({ kind: 'button' })
  })

  it('points to 系统设置 › 应用 on Windows unless the app can start it', () => {
    expect(uninstallEntry({ platform: 'win32', info: installed, inAppOnWindows: false })).toMatchObject({ kind: 'system', text: expect.stringContaining('设置 › 应用') })
    expect(uninstallEntry({ platform: 'win32', info: installed, inAppOnWindows: true })).toEqual({ kind: 'button' })
  })

  it('explains portable copies and shows nothing for dev builds', () => {
    expect(uninstallEntry({ platform: 'win32', info: { portable: true }, inAppOnWindows: true })).toMatchObject({ kind: 'portable', text: expect.stringContaining('便携版') })
    expect(uninstallEntry({ platform: 'linux', info: null, inAppOnWindows: true })).toEqual({ kind: 'none' })
  })
})
