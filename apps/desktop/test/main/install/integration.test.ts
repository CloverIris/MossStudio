import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopExecArg,
  linuxDesktopEntry,
  windowsShortcutPaths,
  writeLinuxIntegration,
  writeWindowsShortcuts,
  type ShortcutOptions,
} from '@main/install/integration'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir()

describe('Windows shortcuts', () => {
  const host = { platform: 'win32' as const, home: 'C:\\Users\\张 三', env: { APPDATA: 'C:\\Users\\张 三\\AppData\\Roaming' } }

  it('go to the Start menu and the desktop', () => {
    expect(windowsShortcutPaths(host, 'D:\\桌面')).toEqual([
      'C:\\Users\\张 三\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MossStudio.lnk',
      'D:\\桌面\\MossStudio.lnk',
    ])
  })

  it('point at the launcher with the app’s AppUserModelID', () => {
    const calls: Array<{ path: string; operation: string; options: ShortcutOptions }> = []
    const paths = [join(temp(), '开始 菜单', 'MossStudio.lnk'), join(temp(), 'Desktop', 'MossStudio.lnk')]
    const failed = writeWindowsShortcuts(
      (path, operation, options) => {
        calls.push({ path, operation, options })
        return true
      },
      paths,
      'C:\\R\\MossStudio.exe',
      'C:\\R',
    )
    expect(failed).toEqual([])
    expect(calls.map((call) => call.path)).toEqual(paths)
    expect(calls[0]).toEqual({
      path: paths[0],
      operation: 'replace',
      options: {
        target: 'C:\\R\\MossStudio.exe',
        cwd: 'C:\\R',
        description: 'MossStudio',
        icon: 'C:\\R\\MossStudio.exe',
        iconIndex: 0,
        appUserModelId: 'com.cloveriris.mossstudio',
      },
    })
    expect(existsSync(join(temp(), '开始 菜单'))).toBe(true)
  })

  it('falls back to create and reports shortcuts that could not be written', () => {
    const operations: string[] = []
    const failed = writeWindowsShortcuts(
      (path, operation) => {
        operations.push(operation)
        return path.includes('ok') && operation === 'create'
      },
      [join(temp(), 'ok.lnk'), join(temp(), 'bad.lnk')],
      'C:\\R\\MossStudio.exe',
      'C:\\R',
    )
    expect(operations).toEqual(['replace', 'create', 'replace', 'create'])
    expect(failed).toEqual([join(temp(), 'bad.lnk')])
  })
})

describe('Linux desktop entry', () => {
  it('quotes the Exec path per the Desktop Entry spec', () => {
    expect(desktopExecArg('/home/张 三/.local/share/MossStudio/mossstudio')).toBe('"/home/张 三/.local/share/MossStudio/mossstudio"')
    expect(desktopExecArg('/odd/$HOME/"x"/a\\b/100%')).toBe('"/odd/\\\\$HOME/\\\\"x\\\\"/a\\\\\\\\b/100%%"')
  })

  it('writes the .desktop file and the icon under XDG_DATA_HOME', () => {
    const host = { platform: 'linux' as const, home: join(temp(), 'home'), env: { XDG_DATA_HOME: join(temp(), 'xdg 数据') } }
    const result = writeLinuxIntegration(host, '/opt/Moss Studio/mossstudio', Buffer.from('png'))
    expect(result.desktopFile).toBe(join(temp(), 'xdg 数据', 'applications', 'mossstudio.desktop'))
    expect(readFileSync(result.iconFile, 'utf8')).toBe('png')
    const text = readFileSync(result.desktopFile, 'utf8')
    expect(text).toBe(linuxDesktopEntry('/opt/Moss Studio/mossstudio', result.iconFile))
    expect(text).toContain('Exec="/opt/Moss Studio/mossstudio" %U')
    expect(text).toContain(`Icon=${result.iconFile}`)
    expect(text).toContain('StartupWMClass=MossStudio')
  })
})
