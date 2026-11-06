import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleOf, detectRunContext, getRunContext, resetRunContext, type DetectInput } from '@main/install/runContext'
import type { InstallLocator, InstallRecord } from '@shared/install'

const W = path.win32
const P = path.posix

function record(patch: Partial<InstallRecord> = {}): InstallRecord {
  return {
    schema: 1, platform: 'win32-x64', root: 'C:\\R', dataRoot: 'C:\\R\\data', portable: false, channel: 'stable',
    current: '2.0.0', failed: [], confirmed: false, installedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...patch,
  }
}

/** A fake filesystem: path → file text (null = exists, no readable text). */
function input(patch: Partial<DetectInput> & { files?: Record<string, string | null> }): DetectInput {
  const files = patch.files ?? {}
  return {
    argv: ['MossStudio'],
    env: {},
    execPath: 'C:\\R\\app-2.0.0\\MossStudio.exe',
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    home: 'C:\\Users\\张 三',
    exists: (file) => file in files,
    readText: (file) => files[file] ?? null,
    ...patch,
  }
}

const winLocator = W.join('C:\\Users\\张 三', 'AppData', 'Local', 'MossStudio', 'locator.json')

describe('detectRunContext on Windows', () => {
  it('is dev when not packaged', () => {
    const context = detectRunContext(input({ packaged: false }))
    expect(context.mode).toBe('dev')
    expect(context.root).toBeNull()
    expect(context.locator).toBeNull()
  })

  it('is setup with --moss-setup, even in dev (UI work), and reads the locator', () => {
    const locator: InstallLocator = { schema: 1, root: 'D:\\Moss', dataRoot: 'D:\\Moss\\data', version: '1.9.0' }
    const context = detectRunContext(input({
      argv: ['MossStudio', '--moss-setup=C:\\Temp\\moss-payload 1'],
      execPath: 'C:\\Temp\\moss-payload 1\\app-2.0.0\\MossStudio.exe',
      files: { [winLocator]: JSON.stringify(locator) },
    }))
    expect(context.mode).toBe('setup')
    expect(context.setup).toEqual({ payloadDir: 'C:\\Temp\\moss-payload 1', silent: false, installTo: null, origin: 'stub', volume: null, missingDataRoot: null })
    expect(context.locator).toEqual(locator)
    expect(detectRunContext(input({ packaged: false, argv: ['x', '--moss-setup=C:\\p'] })).mode).toBe('setup')
  })

  it('is a silent setup from an app-<v> folder without --moss-setup; its parent is the payload', () => {
    const context = detectRunContext(input({ argv: ['MossStudio', '--moss-silent', '--moss-install-to=D:\\Moss'] }))
    expect(context.mode).toBe('setup')
    expect(context.setup?.payloadDir).toBe('C:\\R')
  })

  it('is a silent setup with --moss-silent --moss-install-to', () => {
    const context = detectRunContext(input({
      argv: ['MossStudio', '--moss-setup=C:\\p', '--moss-silent', '--moss-install-to=D:\\装 这里'],
    }))
    expect(context.mode).toBe('setup')
    expect(context.silent).toBe(true)
    expect(context.setup?.installTo).toBe('D:\\装 这里')
  })

  it('is installed under MOSSSTUDIO_ROOT with the launcher from MOSSSTUDIO_LAUNCHER', () => {
    const context = detectRunContext(input({
      argv: ['MossStudio', '--moss-launched'],
      env: { MOSSSTUDIO_ROOT: 'C:\\R', MOSSSTUDIO_LAUNCHER: 'C:\\R\\MossStudio.exe' },
      files: { 'C:\\R\\install.json': JSON.stringify(record()) },
    }))
    expect(context.mode).toBe('installed')
    expect(context.launched).toBe(true)
    expect(context.root).toBe('C:\\R')
    expect(context.launcher).toBe('C:\\R\\MossStudio.exe')
    expect(context.recordPath).toBe('C:\\R\\install.json')
    expect(context.record?.current).toBe('2.0.0')
    expect(context.appPath).toBe('C:\\R\\app-2.0.0')
  })

  it('accepts MOSSSTUDIO_ROOT only as exactly R of R/app-<v>/MossStudio.exe, not any ancestor', () => {
    const files = { 'C:\\R\\install.json': JSON.stringify(record()) }
    for (const ancestor of ['C:\\', 'C:\\R\\app-2.0.0']) {
      const context = detectRunContext(input({ env: { MOSSSTUDIO_ROOT: ancestor }, execPath: 'C:\\R\\app-2.0.0\\MossStudio.exe', files }))
      expect(context.root, ancestor).toBe('C:\\R') // found through install.json two levels up instead
    }
    const deep = detectRunContext(input({ env: { MOSSSTUDIO_ROOT: 'C:\\Users' }, execPath: 'C:\\Users\\a\\R\\app-2.0.0\\MossStudio.exe' }))
    expect(deep.mode).toBe('loose')
    expect(detectRunContext(input({ env: { MOSSSTUDIO_ROOT: 'c:\\r\\' }, files })).root).toBe('C:\\R')
  })

  it('ignores MOSSSTUDIO_ROOT / MOSSSTUDIO_LAUNCHER that do not contain this exe / lie outside R', () => {
    const elsewhere = detectRunContext(input({
      env: { MOSSSTUDIO_ROOT: 'D:\\Other', MOSSSTUDIO_LAUNCHER: 'D:\\Other\\MossStudio.exe' },
      files: { 'D:\\Other\\install.json': JSON.stringify(record({ root: 'D:\\Other' })) },
    }))
    expect(elsewhere.mode).toBe('loose')
    expect(elsewhere.root).toBeNull()
    const launcher = detectRunContext(input({
      env: { MOSSSTUDIO_ROOT: 'C:\\R', MOSSSTUDIO_LAUNCHER: 'D:\\evil\\MossStudio.exe' },
      files: { 'C:\\R\\install.json': JSON.stringify(record()), 'C:\\R\\MossStudio.exe': null },
    }))
    expect(launcher.root).toBe('C:\\R')
    expect(launcher.launcher).toBe('C:\\R\\MossStudio.exe')
  })

  it('finds R from install.json two levels up from the exe, and the launcher in R', () => {
    const context = detectRunContext(input({
      files: { 'C:\\R\\install.json': JSON.stringify(record()), 'C:\\R\\MossStudio.exe': null },
    }))
    expect(context.mode).toBe('installed')
    expect(context.root).toBe('C:\\R')
    expect(context.launcher).toBe('C:\\R\\MossStudio.exe')
  })

  it('reads an invalid install.json as no record', () => {
    const context = detectRunContext(input({ files: { 'C:\\R\\install.json': '{"schema":2}' } }))
    expect(context.mode).toBe('installed')
    expect(context.record).toBeNull()
  })

  it('is uninstall with --moss-uninstall, keeping the install facts', () => {
    const context = detectRunContext(input({
      argv: ['MossStudio', '--moss-uninstall'],
      env: { MOSSSTUDIO_ROOT: 'C:\\R' },
      files: { 'C:\\R\\install.json': JSON.stringify(record()) },
    }))
    expect(context.mode).toBe('uninstall')
    expect(context.root).toBe('C:\\R')
    expect(context.record).not.toBeNull()
  })

  it('is portable with portable.json in R, and never reads the locator', () => {
    const context = detectRunContext(input({
      execPath: 'E:\\U 盘\\MossStudio\\app-2.0.0\\MossStudio.exe',
      files: { 'E:\\U 盘\\MossStudio\\portable.json': '{"schema":1,"version":"2.0.0"}', [winLocator]: '{}' },
    }))
    expect(context.mode).toBe('portable')
    expect(context.portable).toBe(true)
    expect(context.root).toBe('E:\\U 盘\\MossStudio')
    expect(context.locator).toBeNull()
  })

  it('is loose for a packaged build outside any install root', () => {
    const context = detectRunContext(input({ execPath: 'C:\\build\\MossStudio-win32-x64\\MossStudio.exe' }))
    expect(context.mode).toBe('loose')
    expect(context.root).toBeNull()
  })
})

describe('detectRunContext on Linux', () => {
  it('is installed with R/mossstudio as the launcher', () => {
    const context = detectRunContext(input({
      platform: 'linux',
      home: '/home/张三',
      execPath: '/home/张三/.local/share/MossStudio/app-2.0.0/MossStudio',
      files: {
        '/home/张三/.local/share/MossStudio/install.json': JSON.stringify(record({ platform: 'linux-x64', root: '/home/张三/.local/share/MossStudio', dataRoot: '/home/张三/.local/share/MossStudio/data' })),
        '/home/张三/.local/share/MossStudio/mossstudio': null,
      },
    }))
    expect(context.mode).toBe('installed')
    expect(context.platformKey).toBe('linux-x64')
    expect(context.launcher).toBe('/home/张三/.local/share/MossStudio/mossstudio')
    expect(context.locatorPath).toBe('/home/张三/.config/MossStudio/locator.json')
  })

  it('honours XDG_CONFIG_HOME for the locator', () => {
    const context = detectRunContext(input({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/cfg' }, execPath: '/x/MossStudio' }))
    expect(context.locatorPath).toBe('/cfg/MossStudio/locator.json')
  })
})

describe('detectRunContext on macOS', () => {
  const home = '/Users/zhang san'
  const support = P.join(home, 'Library', 'Application Support', 'MossStudio')
  const locatorFile = P.join(support, 'locator.json')
  const mac = (execPath: string, files: Record<string, string | null> = {}, argv = ['MossStudio']) =>
    detectRunContext(input({ platform: 'darwin', arch: 'arm64', home, execPath, files, argv }))
  const installed: InstallLocator = { schema: 1, root: '/Applications', appPath: '/Applications/MossStudio.app', dataRoot: support, version: '2.0.0' }
  const installedFiles = {
    [locatorFile]: JSON.stringify(installed),
    [P.join(support, 'install.json')]: JSON.stringify(record({ platform: 'darwin-arm64', root: '/Applications', appPath: '/Applications/MossStudio.app', dataRoot: support })),
  }

  it('finds the bundle of the executable', () => {
    expect(bundleOf('/Applications/MossStudio.app/Contents/MacOS/MossStudio')).toBe('/Applications/MossStudio.app')
    expect(bundleOf('/usr/local/bin/MossStudio')).toBeNull()
  })

  it('is setup from a DMG, with the volume to eject', () => {
    const context = mac('/Volumes/MossStudio 2.0.0/MossStudio.app/Contents/MacOS/MossStudio')
    expect(context.mode).toBe('setup')
    expect(context.setup).toMatchObject({ origin: 'dmg', volume: '/Volumes/MossStudio 2.0.0', payloadDir: null })
    expect(context.appPath).toBe('/Volumes/MossStudio 2.0.0/MossStudio.app')
  })

  it('is setup when translocated or anywhere that is not the located bundle', () => {
    expect(mac('/private/var/folders/x/AppTranslocation/ABC/d/MossStudio.app/Contents/MacOS/MossStudio').setup?.origin).toBe('translocated')
    const elsewhere = mac(`${home}/Downloads/MossStudio.app/Contents/MacOS/MossStudio`, installedFiles)
    expect(elsewhere.mode).toBe('setup')
    expect(elsewhere.setup?.origin).toBe('unlocated')
    expect(elsewhere.locator).toEqual(installed)
  })

  it('is installed when the locator points at this bundle and its record exists', () => {
    const context = mac('/Applications/MossStudio.app/Contents/MacOS/MossStudio', installedFiles)
    expect(context.mode).toBe('installed')
    expect(context.root).toBe('/Applications')
    expect(context.recordPath).toBe(P.join(support, 'install.json'))
    expect(context.launcher).toBeNull()
  })

  it('names a missing data root when the locator points at this bundle but its data folder is gone (drive not connected)', () => {
    const external = '/Volumes/作品盘/MossStudio'
    const locator = JSON.stringify({ ...installed, dataRoot: external })
    const bin = '/Applications/MossStudio.app/Contents/MacOS/MossStudio'
    const context = mac(bin, { [locatorFile]: locator })
    expect(context).toMatchObject({ mode: 'setup', setup: { origin: 'unlocated', missingDataRoot: external } })
    // The folder is there (only install.json is not): an ordinary setup, as before.
    expect(mac(bin, { [locatorFile]: locator, [external]: null }).setup?.missingDataRoot).toBeNull()
    // Another bundle, or an explicit --moss-setup: not this install's question.
    expect(mac(`${home}/Downloads/MossStudio.app/Contents/MacOS/MossStudio`, { [locatorFile]: locator }).setup?.missingDataRoot).toBeNull()
    expect(mac(bin, { [locatorFile]: locator }, ['MossStudio', '--moss-setup=/tmp/x']).setup?.missingDataRoot).toBeNull()
    // Connected again: installed as usual.
    expect(mac(bin, { [locatorFile]: locator, [external]: null, [P.join(external, 'install.json')]: JSON.stringify(record({ platform: 'darwin-arm64', root: '/Applications', appPath: '/Applications/MossStudio.app', dataRoot: external })) }).mode).toBe('installed')
  })

  it('is a (silent) uninstall with --moss-uninstall, even with --moss-silent', () => {
    const bin = '/Applications/MossStudio.app/Contents/MacOS/MossStudio'
    expect(mac(bin, installedFiles, ['MossStudio', '--moss-uninstall', '--moss-silent'])).toMatchObject({ mode: 'uninstall', silent: true, root: '/Applications' })
    expect(mac(bin, installedFiles, ['MossStudio', '--moss-silent']).mode).toBe('setup')
  })

  it('is portable with portable.json beside the bundle; install.json lives in its data folder', () => {
    const context = mac('/Volumes/USB/Moss/MossStudio.app/Contents/MacOS/MossStudio', { '/Volumes/USB/Moss/portable.json': null })
    expect(context.mode).toBe('portable')
    expect(context.root).toBe('/Volumes/USB/Moss')
    expect(context.recordPath).toBe('/Volumes/USB/Moss/data/install.json')
  })
})

describe('getRunContext', () => {
  it('memoizes until reset', () => {
    resetRunContext()
    const first = getRunContext()
    expect(getRunContext()).toBe(first)
    expect(first.mode).toBe('dev')
    resetRunContext()
    expect(getRunContext()).not.toBe(first)
    resetRunContext()
  })
})
