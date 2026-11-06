import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path, { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uninstallPlanSchema, type UninstallPlan } from '@shared/install'
import { isWithin, type HostInfo, type OsPlatform } from '@main/install/layout'
import {
  assertPlanContained,
  buildUninstallPlan,
  integrationFiles,
  noteKeptData,
  ownedRootEntries,
  startFinishUninstall,
  uninstallMac,
  type UninstallTarget,
} from '@main/install/uninstall'
import { useTempDir } from '@test/helpers/tempDir'

const W = path.win32

const winHost: HostInfo = {
  platform: 'win32',
  home: 'C:\\Users\\张 三',
  env: { LOCALAPPDATA: 'C:\\Users\\张 三\\AppData\\Local', APPDATA: 'C:\\Users\\张 三\\AppData\\Roaming' },
}
const winRoot = 'C:\\Users\\张 三\\AppData\\Local\\Programs\\MossStudio'
const winTarget: UninstallTarget = {
  host: winHost, platformKey: 'win32-x64', root: winRoot, dataRoot: W.join(winRoot, 'data'), portable: false, desktopDir: 'C:\\Users\\张 三\\Desktop',
  profileDir: 'C:\\Users\\张 三\\AppData\\Roaming\\MossStudio',
}
/** What a real R contains: ours, plus a user's file and the data folder. */
const winNames = ['MossStudio.exe', 'MossStudio.exe.old-abc', 'app-1.9.0', 'app-2.0.0', 'app-2.1.0.partial', 'install.json', 'data', 'my notes.txt', 'Backup']

function expectContained(plan: UninstallPlan, platform: OsPlatform, extras: string[]): void {
  for (const entry of plan.remove) {
    const ok = (isWithin(platform, plan.root, entry) && entry !== plan.root) || isWithin(platform, plan.dataRoot, entry) || extras.includes(entry)
    expect(ok, entry).toBe(true)
  }
}

describe('ownedRootEntries', () => {
  it('keeps only what the install created in R', () => {
    expect(ownedRootEntries('win32', winNames)).toEqual(['MossStudio.exe', 'MossStudio.exe.old-abc', 'app-1.9.0', 'app-2.0.0', 'app-2.1.0.partial', 'install.json'])
    expect(ownedRootEntries('linux', ['mossstudio', 'app-2.0.0', 'portable.json', 'data', 'app-store', 'mossstudio.sh'])).toEqual(['mossstudio', 'app-2.0.0', 'portable.json'])
  })

  it('includes the Updater’s staging and partial folders (Windows/Linux)', () => {
    const names = [
      '.updates', 'app-2.1.0.partial', 'app-2.1.0.partial.delta', 'app-2.2.0-beta.1.update-partial', 'app-2.2.0.update-partial.delta', 'app-2.0.0.replaced-k3',
      '.update-failed', '.update-clean-exit',
      'app-store', 'app-', '.updates-mine', 'updates', 'app-2.1.0.partial.delta.tmp', 'app-2.1.0.backup',
    ]
    // The macOS-only update markers are not owned names in R: the launcher would refuse the plan.
    expect(ownedRootEntries('linux', names)).toEqual([
      '.updates', 'app-2.1.0.partial', 'app-2.1.0.partial.delta', 'app-2.2.0-beta.1.update-partial', 'app-2.2.0.update-partial.delta', 'app-2.0.0.replaced-k3',
    ])
    expect(buildUninstallPlan(winTarget, false, [...winNames, '.updates']).remove).toContain(W.join(winRoot, '.updates'))
  })

  it('includes the launcher’s .moss-trash-* leftovers (a failed delete of an old app-<v>)', () => {
    expect(ownedRootEntries('win32', ['.moss-trash-app-1.8.0-0a1b2c3d', 'app-2.0.0', 'data'])).toEqual(['.moss-trash-app-1.8.0-0a1b2c3d', 'app-2.0.0'])
    const plan = buildUninstallPlan(winTarget, false, [...winNames, '.moss-trash-app-1.8.0-0a1b2c3d'])
    expect(plan.remove).toContain(W.join(winRoot, '.moss-trash-app-1.8.0-0a1b2c3d'))
  })

  it('macOS: only the hidden MossStudio bundles beside the app, never other apps in the folder', () => {
    expect(ownedRootEntries('darwin', [
      'MossStudio.app', 'Safari.app', 'app-2.0.0', 'install.json',
      '.MossStudio-1.9.0.app.previous', '.MossStudio-2.1.0-beta.1.app.partial', '.MossStudio-2.1.0.app', '.MossStudio-old.app.previous', '.MossStudio-x.app',
      '.MossStudio-2.1.0.app.partial.delta', '.MossStudio-updates', '.updates', '.MossStudio-updates-old', 'app-2.1.0.partial',
      '.MossStudio-2.2.0.app.update-partial', '.MossStudio-2.2.0.app.update-partial.delta', '.MossStudio-2.2.0.app.backup',
    ])).toEqual([
      '.MossStudio-1.9.0.app.previous', '.MossStudio-2.1.0-beta.1.app.partial', '.MossStudio-2.1.0.app', '.MossStudio-old.app.previous',
      '.MossStudio-2.1.0.app.partial.delta', '.MossStudio-updates', '.MossStudio-2.2.0.app.update-partial', '.MossStudio-2.2.0.app.update-partial.delta',
    ])
  })
})

describe('buildUninstallPlan (Windows)', () => {
  const now = new Date('2026-11-05T00:00:00.000Z')

  it('lists the app folders, launcher, record, shortcuts, locator and the registry key, keeping data', () => {
    const plan = buildUninstallPlan(winTarget, false, winNames, now)
    expect(uninstallPlanSchema.parse(plan)).toEqual(plan)
    expect(plan.remove).toEqual([
      W.join(winRoot, 'MossStudio.exe'),
      W.join(winRoot, 'MossStudio.exe.old-abc'),
      W.join(winRoot, 'app-1.9.0'),
      W.join(winRoot, 'app-2.0.0'),
      W.join(winRoot, 'app-2.1.0.partial'),
      W.join(winRoot, 'install.json'),
      'C:\\Users\\张 三\\AppData\\Local\\MossStudio\\locator.json',
      'C:\\Users\\张 三\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\MossStudio.lnk',
      'C:\\Users\\张 三\\Desktop\\MossStudio.lnk',
    ])
    expect(plan.registryKeys).toEqual(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MossStudio'])
    expect(plan.removeEmptyDirs).toEqual([winRoot, 'C:\\Users\\张 三\\AppData\\Local\\MossStudio'])
    expect(plan.removeData).toBe(false)
    expect(plan.remove).not.toContain(W.join(winRoot, 'data'))
    expect(plan.remove).not.toContain(W.join(winRoot, 'my notes.txt'))
    expect(plan.remove).not.toContain(winRoot)
    expectContained(plan, 'win32', integrationFiles(winTarget))
    expect(plan.createdAt).toBe(now.toISOString())
  })

  it('adds the data root only when asked', () => {
    const plan = buildUninstallPlan(winTarget, true, winNames, now)
    expect(plan.removeData).toBe(true)
    expect(plan.remove.at(-1)).toBe(W.join(winRoot, 'data'))
    expectContained(plan, 'win32', integrationFiles(winTarget))
  })

  it('removes a data root elsewhere (old 1.0.x data reused), but never one that contains R, the home folder or a drive', () => {
    const elsewhere = buildUninstallPlan({ ...winTarget, dataRoot: 'D:\\旧 版\\data' }, true, winNames, now)
    expect(elsewhere.remove).toContain('D:\\旧 版\\data')
    for (const dataRoot of ['C:\\Users\\张 三\\AppData\\Local\\Programs', 'C:\\Users\\张 三', 'D:\\', 'C:\\Windows\\Temp\\x']) {
      expect(() => buildUninstallPlan({ ...winTarget, dataRoot }, true, winNames, now), dataRoot).toThrow(expect.objectContaining({ code: 'E_UNSAFE_DATA_ROOT' }))
    }
    // Keeping the data is always possible.
    expect(buildUninstallPlan({ ...winTarget, dataRoot: 'C:\\Users\\张 三' }, false, winNames, now).removeData).toBe(false)
  })

  it('portable: no registry, shortcuts or locator', () => {
    const plan = buildUninstallPlan({ ...winTarget, portable: true, root: 'E:\\Moss', dataRoot: 'E:\\Moss\\data' }, false, ['MossStudio.exe', 'app-2.0.0', 'portable.json', 'install.json', 'data'], now)
    expect(plan.registryKeys).toEqual([])
    expect(plan.remove).toEqual(['E:\\Moss\\MossStudio.exe', 'E:\\Moss\\app-2.0.0', 'E:\\Moss\\portable.json', 'E:\\Moss\\install.json'])
    expect(plan.removeEmptyDirs).toEqual(['E:\\Moss'])
  })
})

describe('buildUninstallPlan (Linux and macOS)', () => {
  it('Linux: the .desktop entry and icon, the locator under XDG_CONFIG_HOME', () => {
    const host: HostInfo = { platform: 'linux', home: '/home/张 三', env: { XDG_CONFIG_HOME: '/home/张 三/.config' } }
    const target: UninstallTarget = { host, platformKey: 'linux-x64', root: '/home/张 三/.local/share/MossStudio', dataRoot: '/home/张 三/.local/share/MossStudio/data', portable: false, desktopDir: '', profileDir: '/home/张 三/.config/MossStudio' }
    const plan = buildUninstallPlan(target, true, ['mossstudio', 'app-2.0.0', 'install.json', 'data', 'other'])
    expect(plan.remove).toEqual([
      '/home/张 三/.local/share/MossStudio/mossstudio',
      '/home/张 三/.local/share/MossStudio/app-2.0.0',
      '/home/张 三/.local/share/MossStudio/install.json',
      '/home/张 三/.config/MossStudio/locator.json',
      '/home/张 三/.local/share/applications/mossstudio.desktop',
      '/home/张 三/.local/share/icons/hicolor/512x512/apps/mossstudio.png',
      '/home/张 三/.local/share/MossStudio/data',
    ])
    expect(plan.registryKeys).toEqual([])
    expect(plan.profileDir).toBe('/home/张 三/.config/MossStudio')
    expectContained(plan, 'linux', integrationFiles(target))
  })

  it('macOS: the bundle and install.json in the data root', () => {
    const host: HostInfo = { platform: 'darwin', home: '/Users/z', env: {} }
    const target: UninstallTarget = { host, platformKey: 'darwin-arm64', root: '/Applications', dataRoot: '/Users/z/Library/Application Support/MossStudio', portable: false, desktopDir: '', profileDir: '/Users/z/Library/Application Support/MossStudio' }
    const plan = buildUninstallPlan(target, false, ['MossStudio.app', 'Safari.app', '.MossStudio-1.9.0.app.previous'])
    expect(plan.remove).toEqual([
      '/Applications/.MossStudio-1.9.0.app.previous', '/Applications/MossStudio.app',
      '/Users/z/Library/Application Support/MossStudio/install.json',
      '/Users/z/Library/Application Support/MossStudio/.update-failed',
      '/Users/z/Library/Application Support/MossStudio/.update-clean-exit',
      '/Users/z/Library/Application Support/MossStudio/locator.json',
    ])
  })
})

describe('Electron profile (app.getPath(\'userData\'))', () => {
  it('is in the plan only when the data goes', () => {
    expect(buildUninstallPlan(winTarget, false, winNames).profileDir).toBeUndefined()
    const plan = buildUninstallPlan(winTarget, true, winNames)
    expect(plan.profileDir).toBe('C:\\Users\\张 三\\AppData\\Roaming\\MossStudio')
    expect(uninstallPlanSchema.parse(plan).profileDir).toBe(plan.profileDir)
    expect(plan.remove).not.toContain(plan.profileDir)
  })

  it('is skipped when it is (inside) the data root, or unknown', () => {
    expect(buildUninstallPlan({ ...winTarget, profileDir: W.join(winRoot, 'data') }, true, winNames).profileDir).toBeUndefined()
    expect(buildUninstallPlan({ ...winTarget, profileDir: null }, true, winNames).profileDir).toBeUndefined()
  })

  it('refuses anything but a MossStudio folder outside R and the home folder', () => {
    for (const profileDir of ['C:\\Users\\张 三\\AppData\\Roaming', 'C:\\Users\\张 三\\AppData\\Roaming\\Other', winRoot, W.join(winRoot, 'MossStudio'), 'C:\\MossStudio\\..\\Users']) {
      expect(() => buildUninstallPlan({ ...winTarget, profileDir }, true, winNames), profileDir).toThrow(expect.objectContaining({ code: 'E_UNSAFE_PROFILE' }))
    }
    // C:\\Users\\<name>\\MossStudio would hold no home, but a profile that holds home is refused:
    expect(() => buildUninstallPlan({ ...winTarget, host: { ...winHost, home: 'C:\\MossStudio\\home' }, profileDir: 'C:\\MossStudio' }, true, winNames)).toThrow(expect.objectContaining({ code: 'E_UNSAFE_PROFILE' }))
  })

  it('a plan that keeps the data must not carry it', () => {
    const plan = buildUninstallPlan(winTarget, true, winNames)
    expect(() => assertPlanContained({ ...plan, removeData: false, remove: [] }, [])).toThrow(/配置文件夹/)
    expect(() => assertPlanContained({ ...plan, profileDir: 'C:\\Users\\张 三\\AppData\\Roaming' }, integrationFiles(winTarget))).toThrow(/不合规/)
  })
})

describe('noteKeptData', () => {
  const temp = useTempDir()

  it('leaves kept-data.json beside the locator (Windows/Linux), outside the plan; nothing for portable or macOS', () => {
    const host: HostInfo = { platform: 'linux', home: temp(), env: { XDG_CONFIG_HOME: join(temp(), 'config') } }
    const target: UninstallTarget = { host, platformKey: 'linux-x64', root: join(temp(), 'R'), dataRoot: join(temp(), 'R', 'data'), portable: false, desktopDir: '', profileDir: null }
    const file = noteKeptData(target, '2.0.0', new Date('2026-11-05T09:00:00.000Z'))
    expect(file).toBe(join(temp(), 'config', 'MossStudio', 'kept-data.json'))
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual({ schema: 1, root: join(temp(), 'R'), dataRoot: join(temp(), 'R', 'data'), version: '2.0.0', keptAt: '2026-11-05T09:00:00.000Z' })
    // The launcher's plan never lists it, so it survives the uninstall it describes.
    expect(buildUninstallPlan(target, false, ['mossstudio', 'data']).remove).not.toContain(file)
    expect(noteKeptData({ ...target, portable: true }, '2.0.0')).toBeNull()
    expect(noteKeptData({ ...target, host: { ...host, platform: 'darwin' } }, '2.0.0')).toBeNull()
  })
})

describe('assertPlanContained', () => {
  const base = buildUninstallPlan(winTarget, false, winNames)
  it('rejects anything outside R and the data root that is not a listed extra, and R itself', () => {
    expect(() => assertPlanContained({ ...base, remove: [...base.remove, 'C:\\Users\\张 三\\Documents'] }, integrationFiles(winTarget))).toThrow(/以外/)
    expect(() => assertPlanContained({ ...base, remove: [winRoot] }, [])).toThrow(/整体删除/)
    expect(() => assertPlanContained({ ...base, remove: [`${winRoot}\\..\\Other`] }, [])).toThrow(/以外/)
    expect(() => assertPlanContained({ ...base, remove: [W.join(winRoot, 'data')] }, [])).toThrow(/保留的数据/)
  })
})

describe('startFinishUninstall', () => {
  const temp = useTempDir()
  it('copies the launcher and the plan to a fresh temp folder and starts the copy with an argument array', () => {
    const launcher = join(temp(), '安装 目录', process.platform === 'win32' ? 'MossStudio.exe' : 'mossstudio')
    mkdirSync(join(temp(), '安装 目录'))
    writeFileSync(launcher, 'launcher-binary')
    const plan = buildUninstallPlan(winTarget, false, winNames)
    const spawned: Array<{ file: string; args: string[] }> = []
    const started = startFinishUninstall(plan, launcher, { spawnDetached: (file, args) => { spawned.push({ file, args }) } })
    expect(readFileSync(started.launcher, 'utf8')).toBe('launcher-binary')
    expect(uninstallPlanSchema.parse(JSON.parse(readFileSync(started.plan, 'utf8')))).toEqual(plan)
    expect(spawned).toEqual([{ file: started.launcher, args: [`--finish-uninstall=${started.plan}`] }])
    expect(path.dirname(started.plan)).toBe(started.dir)
  })

  it('passes --moss-silent to the launcher copy only for a silent uninstall', () => {
    const launcher = join(temp(), process.platform === 'win32' ? 'MossStudio.exe' : 'mossstudio')
    writeFileSync(launcher, 'launcher-binary')
    const plan = buildUninstallPlan(winTarget, false, winNames)
    const calls: string[][] = []
    const spawnDetached = (_file: string, args: string[]): void => { calls.push(args) }
    const silent = startFinishUninstall(plan, launcher, { spawnDetached, silent: true })
    const loud = startFinishUninstall(plan, launcher, { spawnDetached, silent: false })
    const plain = startFinishUninstall(plan, launcher, { spawnDetached })
    expect(calls).toEqual([
      [`--finish-uninstall=${silent.plan}`, '--moss-silent'],
      [`--finish-uninstall=${loud.plan}`],
      [`--finish-uninstall=${plain.plan}`],
    ])
  })

  it('fails without a launcher and leaves no temp folder', () => {
    expect(() => startFinishUninstall(buildUninstallPlan(winTarget, false, winNames), join(temp(), 'missing'))).toThrow(expect.objectContaining({ code: 'E_NO_LAUNCHER' }))
  })
})

describe('uninstallMac', () => {
  const temp = useTempDir()
  it('trashes the bundle last, after quitting, and the data only when asked; removes record and locator otherwise', async () => {
    const home = temp()
    const support = join(home, 'Library', 'Application Support', 'MossStudio')
    mkdirSync(support, { recursive: true })
    writeFileSync(join(support, 'install.json'), '{}')
    writeFileSync(join(support, 'locator.json'), '{}')
    writeFileSync(join(support, 'settings.json'), '{}')
    writeFileSync(join(support, '.update-clean-exit'), '')
    const target: UninstallTarget = { host: { platform: 'darwin', home, env: {} }, platformKey: 'darwin-arm64', root: join(home, 'Applications'), dataRoot: support, portable: false, desktopDir: '', profileDir: support }
    const bundle = join(home, 'Applications', 'MossStudio.app')
    const steps: string[] = []
    const deps = {
      trash: async (item: string) => { steps.push(item) },
      trashBundleAfterExit: async (item: string) => {
        // Everything else is done by the time the deferred move is arranged.
        expect(existsSync(join(support, 'locator.json'))).toBe(false)
        steps.push(`after exit: ${item}`)
      },
    }
    const names = ['MossStudio.app', 'Notes.txt', '.MossStudio-1.9.0.app.previous']
    expect(await uninstallMac(target, bundle, false, deps, names)).toEqual([join(home, 'Applications', '.MossStudio-1.9.0.app.previous')])
    expect(steps).toEqual([join(home, 'Applications', '.MossStudio-1.9.0.app.previous'), `after exit: ${bundle}`])
    expect(existsSync(join(support, 'install.json'))).toBe(false)
    expect(existsSync(join(support, 'locator.json'))).toBe(false)
    expect(existsSync(join(support, '.update-clean-exit'))).toBe(false)
    expect(existsSync(join(support, 'settings.json'))).toBe(true)
    steps.length = 0
    await uninstallMac(target, bundle, true, deps, ['MossStudio.app'])
    expect(steps).toEqual([support, `after exit: ${bundle}`])
    steps.length = 0
    const dataElsewhere = join(home, 'Moss 数据')
    await uninstallMac({ ...target, dataRoot: dataElsewhere }, bundle, true, deps, ['MossStudio.app'])
    expect(steps).toEqual([dataElsewhere, support, `after exit: ${bundle}`])
  })
})
