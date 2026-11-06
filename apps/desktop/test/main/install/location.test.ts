import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asOsPlatform, type HostInfo } from '@main/install/layout'
import { canWrite, checkInstallLocation, inspectDataFolder, inspectInstallFolder, locationRule } from '@main/install/location'
import { useTempDir } from '@test/helpers/tempDir'

const win: HostInfo = {
  platform: 'win32',
  home: 'C:\\Users\\张 三',
  env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\张 三\\AppData\\Local' },
}
const winTemp = 'C:\\Users\\张 三\\AppData\\Local\\Temp'
const linux: HostInfo = { platform: 'linux', home: '/home/张 三', env: {} }
const mac: HostInfo = { platform: 'darwin', home: '/Users/zhang san', env: {} }

const rule = (host: HostInfo, path: string, extra: { payloadDir?: string; volume?: string } = {}) =>
  locationRule(path, { host, tempDir: host.platform === 'win32' ? winTemp : '/tmp', ...extra })

describe('locationRule on Windows', () => {
  it('accepts ordinary folders, including Chinese names with spaces', () => {
    for (const path of ['C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio', 'D:\\我的 程序\\MossStudio', 'D:\\Moss Studio\\', '\\\\nas\\共享\\apps\\Moss']) {
      expect(rule(win, path).problem, path).toBeNull()
    }
    expect(rule(win, 'D:\\Moss Studio\\').path).toBe('D:\\Moss Studio')
  })

  it('refuses relative and drive-relative paths', () => {
    expect(rule(win, 'MossStudio').problem?.code).toBe('E_NOT_ABSOLUTE')
    expect(rule(win, '\\MossStudio').problem?.code).toBe('E_NOT_ABSOLUTE')
    expect(rule(win, '').problem?.code).toBe('E_NOT_ABSOLUTE')
  })

  it('refuses drive and share roots, suggesting a MossStudio subfolder', () => {
    expect(rule(win, 'D:\\')).toMatchObject({ problem: { code: 'E_DRIVE_ROOT' }, suggestion: 'D:\\MossStudio' })
    expect(rule(win, 'E:').problem?.code).toBe('E_NOT_ABSOLUTE')
    expect(rule(win, '\\\\nas\\share').problem?.code).toBe('E_DRIVE_ROOT')
  })

  it('refuses system folders and everything inside them', () => {
    for (const path of ['C:\\Windows', 'c:\\windows\\System32\\Moss', 'C:\\Program Files\\MossStudio', 'C:\\Program Files (x86)\\Moss', 'C:\\ProgramData\\Moss']) {
      expect(rule(win, path).problem?.code, path).toBe('E_SYSTEM_DIR')
    }
  })

  it('refuses the profile and its well-known folders themselves, but not a subfolder', () => {
    expect(rule(win, 'C:\\Users\\张 三')).toMatchObject({ problem: { code: 'E_SYSTEM_DIR' }, suggestion: 'C:\\Users\\张 三\\MossStudio' })
    expect(rule(win, 'C:\\Users\\张 三\\Desktop').problem?.code).toBe('E_SYSTEM_DIR')
    expect(rule(win, 'C:\\Users').problem?.code).toBe('E_SYSTEM_DIR')
    expect(rule(win, 'C:\\Users\\张 三\\Desktop\\MossStudio').problem).toBeNull()
  })

  it('refuses temp and the setup payload', () => {
    expect(rule(win, `${winTemp}\\Moss`).problem?.code).toBe('E_TEMP_DIR')
    expect(rule(win, 'D:\\payload\\x', { payloadDir: 'D:\\payload' }).problem?.code).toBe('E_IN_PAYLOAD')
  })
})

describe('locationRule on Linux and macOS', () => {
  it('Linux: refuses /, system trees, temp and $HOME itself', () => {
    expect(rule(linux, '/').problem?.code).toBe('E_DRIVE_ROOT')
    expect(rule(linux, '/usr/local/MossStudio').problem?.code).toBe('E_SYSTEM_DIR')
    expect(rule(linux, '/tmp/x').problem?.code).toBe('E_TEMP_DIR')
    expect(rule(linux, '/home/张 三')).toMatchObject({ problem: { code: 'E_SYSTEM_DIR' }, suggestion: '/home/张 三/MossStudio' })
    expect(rule(linux, '/home/张 三/.local/share/MossStudio').problem).toBeNull()
    expect(rule(linux, '/opt/MossStudio').problem).toBeNull()
  })

  it('macOS: accepts /Applications and ~/Applications, refuses /System and the DMG', () => {
    expect(rule(mac, '/Applications').problem).toBeNull()
    expect(rule(mac, '/Users/zhang san/Applications').problem).toBeNull()
    expect(rule(mac, '/System/Applications').problem?.code).toBe('E_SYSTEM_DIR')
    expect(rule(mac, '/Volumes/MossStudio 2.0.0/x', { volume: '/Volumes/MossStudio 2.0.0' }).problem?.code).toBe('E_SYSTEM_DIR')
  })
})

// The test folders live in the OS temp folder, which the rules refuse on purpose, so the
// filesystem half is exercised directly; checkInstallLocation itself is checked on top.
describe('inspectInstallFolder on this machine', () => {
  const temp = useTempDir()
  const check = (path: string, requiredBytes = 1024) => inspectInstallFolder(asOsPlatform(process.platform)!, path, requiredBytes)

  it('checkInstallLocation applies the rules before touching the disk', () => {
    const host: HostInfo = { platform: asOsPlatform(process.platform)!, home: join(temp(), 'home'), env: {} }
    expect(checkInstallLocation(join(temp(), 'x'), { host, tempDir: temp(), requiredBytes: 0 }).problem?.code).toMatch(/^E_(TEMP|SYSTEM)_DIR$/)
    expect(checkInstallLocation('relative', { host, tempDir: temp(), requiredBytes: 0 }).problem?.code).toBe('E_NOT_ABSOLUTE')
  })

  it('accepts a missing folder with a Chinese name and spaces, reporting free space', () => {
    const result = check(join(temp(), '安装 目录', 'MossStudio'))
    expect(result).toMatchObject({ ok: true, kind: 'missing', problem: null })
    expect(result.freeBytes).toBeGreaterThan(0)
  })

  it('accepts an empty folder', () => {
    mkdirSync(join(temp(), 'empty'))
    expect(check(join(temp(), 'empty'))).toMatchObject({ ok: true, kind: 'empty' })
  })

  it('refuses a non-empty folder and offers <chosen>/MossStudio (Windows/Linux)', () => {
    if (process.platform === 'darwin') {
      // macOS installs MossStudio.app into the folder, so a non-empty folder is fine there.
      mkdirSync(join(temp(), 'apps'))
      writeFileSync(join(temp(), 'apps', 'Other.txt'), '')
      expect(check(join(temp(), 'apps')).ok).toBe(true)
      return
    }
    mkdirSync(join(temp(), 'stuff'))
    writeFileSync(join(temp(), 'stuff', 'notes.txt'), '')
    expect(check(join(temp(), 'stuff'))).toMatchObject({ ok: false, kind: 'occupied', problem: { code: 'E_NOT_EMPTY' }, suggestion: join(temp(), 'stuff', 'MossStudio') })
  })

  it('accepts an existing MossStudio root and an old 1.0.x folder', () => {
    if (process.platform === 'darwin') return
    mkdirSync(join(temp(), 'R'))
    writeFileSync(join(temp(), 'R', 'install.json'), JSON.stringify({
      schema: 1, platform: 'linux-x64', root: join(temp(), 'R'), dataRoot: join(temp(), 'R', 'data'), portable: false, channel: 'stable',
      current: '2.0.0', failed: [], confirmed: true, installedAt: '', updatedAt: '',
    }))
    expect(check(join(temp(), 'R'))).toMatchObject({ ok: true, kind: 'install' })
    const old = join(temp(), '旧 版')
    mkdirSync(join(old, 'resources'), { recursive: true })
    mkdirSync(join(old, 'data'))
    writeFileSync(join(old, 'MossStudio.exe'), '')
    writeFileSync(join(old, 'resources', 'app.asar'), '')
    expect(check(old)).toMatchObject({ ok: true, kind: 'legacy' })
  })

  it('accepts a folder an uninstall left with the data kept (user files may stay), but not a data/ that is not ours', () => {
    if (process.platform === 'darwin') return
    const left = join(temp(), '保留 的')
    mkdirSync(join(left, 'data', 'instances'), { recursive: true })
    writeFileSync(join(left, 'data', 'settings.json'), '{}')
    writeFileSync(join(left, 'my notes.txt'), 'mine')
    expect(check(left)).toMatchObject({ ok: true, kind: 'data', problem: null })
    const other = join(temp(), 'other')
    mkdirSync(join(other, 'data'), { recursive: true })
    writeFileSync(join(other, 'data', 'photo.jpg'), '')
    expect(check(other)).toMatchObject({ ok: false, kind: 'occupied', problem: { code: 'E_NOT_EMPTY' } })
    // A project folder whose data/ merely has a models/ or a settings.json is not ours.
    const project = join(temp(), 'ml project')
    mkdirSync(join(project, 'data', 'models'), { recursive: true })
    writeFileSync(join(project, 'data', 'settings.json'), '{}')
    expect(check(project)).toMatchObject({ ok: false, kind: 'occupied' })
    // The launcher's log alone identifies our data (settings.json is only written once changed).
    const logged = join(temp(), 'logged')
    mkdirSync(join(logged, 'data', 'logs'), { recursive: true })
    writeFileSync(join(logged, 'data', 'logs', 'launcher.log'), 'started')
    expect(check(logged)).toMatchObject({ ok: true, kind: 'data' })
    // A data file instead of a folder, or a foreign install.json beside the data: not ours either.
    const file = join(temp(), 'file')
    mkdirSync(file)
    writeFileSync(join(file, 'data'), 'x')
    expect(check(file)).toMatchObject({ ok: false, kind: 'occupied' })
    writeFileSync(join(left, 'install.json'), '{"x":1}')
    expect(check(left)).toMatchObject({ ok: false, kind: 'occupied' })
  })

  it('counts install.json / portable.json only when they really are ours', () => {
    // (macOS installs MossStudio.app into a folder, so other files there never block it.)
    for (const [name, text] of process.platform === 'darwin' ? [] : [['install.json', '{}'], ['install.json', '{"schema":1}'], ['portable.json', '{"app":"other"}'], ['install.json', 'not json']]) {
      const dir = join(temp(), `foreign-${name}-${text.length}`)
      mkdirSync(dir)
      writeFileSync(join(dir, name!), text!)
      expect(check(dir), `${name} ${text}`).toMatchObject({ ok: false, kind: 'occupied', problem: { code: 'E_NOT_EMPTY' }, suggestion: join(dir, 'MossStudio') })
    }
    const portable = join(temp(), 'portable')
    mkdirSync(portable)
    writeFileSync(join(portable, 'portable.json'), JSON.stringify({ schema: 1, version: '2.0.0' }))
    expect(check(portable)).toMatchObject({ ok: false, problem: { code: 'E_PORTABLE_ROOT' }, suggestion: null })
  })

  it('refuses a file, a full disk and an unwritable location', () => {
    writeFileSync(join(temp(), 'file'), '')
    expect(check(join(temp(), 'file')).problem?.code).toBe('E_NOT_DIRECTORY')
    expect(check(join(temp(), 'big'), Number.MAX_SAFE_INTEGER).problem?.code).toBe('E_NO_SPACE')
    expect(canWrite(join(temp(), 'file', 'below'))).toBe(false)
    expect(canWrite(join(temp(), 'new', 'deeper'))).toBe(true)
  })
})

describe('inspectDataFolder', () => {
  const temp = useTempDir()
  const check = (path: string) => inspectDataFolder(asOsPlatform(process.platform)!, path)

  it('accepts missing, empty and existing MossStudio data; refuses other non-empty folders', () => {
    expect(check(join(temp(), '数据'))).toMatchObject({ ok: true, kind: 'missing' })
    mkdirSync(join(temp(), 'existing'))
    writeFileSync(join(temp(), 'existing', 'settings.json'), '{}')
    expect(check(join(temp(), 'existing'))).toMatchObject({ ok: true, kind: 'data' })
    mkdirSync(join(temp(), 'other'))
    writeFileSync(join(temp(), 'other', 'a.txt'), '')
    expect(check(join(temp(), 'other'))).toMatchObject({ ok: false, problem: { code: 'E_NOT_EMPTY' }, suggestion: join(temp(), 'other', 'MossStudio') })
  })
})
