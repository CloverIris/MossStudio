import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contextDataRoot, portableUserData, recordedDataRoot, resolveDataRoot } from '@main/install/dataRoot'
import type { RunContext } from '@main/install/runContext'
import type { InstallRecord } from '@shared/install'
import { useTempDir } from '@test/helpers/tempDir'

const fallbacks = { userData: () => '/user-data', scratch: () => '/tmp/MossStudio-setup-1' }

function context(patch: Partial<RunContext> = {}): RunContext {
  return {
    mode: 'installed', platform: 'linux', platformKey: 'linux-x64', packaged: true, launched: true, silent: false,
    root: '/opt/R', launcher: '/opt/R/mossstudio', appPath: '/opt/R/app-2.0.0', recordPath: '/opt/R/install.json',
    record: null, locatorPath: '/home/a/.config/MossStudio/locator.json', locator: null, portable: false, setup: null, ...patch,
  }
}

function record(patch: Partial<InstallRecord> = {}): InstallRecord {
  return {
    schema: 1, platform: 'linux-x64', root: '/opt/R', dataRoot: '/srv/我的 数据', portable: false, channel: 'stable',
    current: '2.0.0', failed: [], confirmed: true, installedAt: '', updatedAt: '', ...patch,
  }
}

describe('data root order', () => {
  it('1. MOSSSTUDIO_DATA wins over everything', () => {
    expect(resolveDataRoot(context({ record: record() }), { MOSSSTUDIO_DATA: '  /env/data ' }, fallbacks)).toBe(resolve('/env/data'))
  })

  it('2. then install.json dataRoot', () => {
    expect(resolveDataRoot(context({ record: record() }), { MOSSSTUDIO_DATA: '   ' }, fallbacks)).toBe('/srv/我的 数据')
  })

  it('2. a portable record counts only while R has not moved', () => {
    const portable = { mode: 'portable' as const, portable: true }
    expect(contextDataRoot(context({ ...portable, record: record({ portable: true, dataRoot: '/opt/R/data' }) }), fallbacks)).toBe('/opt/R/data')
    expect(contextDataRoot(context({ ...portable, root: '/media/usb/R', record: record({ portable: true, root: '/opt/R', dataRoot: '/opt/R/data' }) }), fallbacks)).toBe('/media/usb/R/data')
  })

  it('3. then portable R/data', () => {
    expect(contextDataRoot(context({ mode: 'portable', portable: true }), fallbacks)).toBe('/opt/R/data')
  })

  it('4. installed or uninstalling without a readable record: R/data (macOS: the locator data root)', () => {
    expect(contextDataRoot(context(), fallbacks)).toBe('/opt/R/data')
    expect(contextDataRoot(context({ mode: 'uninstall' }), fallbacks)).toBe('/opt/R/data')
    expect(contextDataRoot(context({
      platform: 'darwin', root: '/Applications',
      locator: { schema: 1, root: '/Applications', appPath: '/Applications/MossStudio.app', dataRoot: '/Users/a/Moss', version: '2.0.0' },
    }), fallbacks)).toBe('/Users/a/Moss')
  })

  it('5. setup mode uses a scratch folder, never user data', () => {
    expect(contextDataRoot(context({ mode: 'setup', root: null, recordPath: null }), fallbacks)).toBe('/tmp/MossStudio-setup-1')
  })

  it('6. dev and loose builds use Electron userData', () => {
    expect(contextDataRoot(context({ mode: 'dev', root: null }), fallbacks)).toBe('/user-data')
    expect(contextDataRoot(context({ mode: 'loose', root: null }), fallbacks)).toBe('/user-data')
  })
})

describe('recordedDataRoot (the uninstall plan)', () => {
  it('is install.json’s dataRoot, never MOSSSTUDIO_DATA, and prefers a freshly read record', () => {
    const saved = process.env['MOSSSTUDIO_DATA']
    process.env['MOSSSTUDIO_DATA'] = '/env/data'
    try {
      expect(recordedDataRoot(context({ record: record() }))).toBe('/srv/我的 数据')
      expect(recordedDataRoot(context({ record: record() }), record({ dataRoot: '/moved/data' }))).toBe('/moved/data')
    } finally {
      if (saved === undefined) delete process.env['MOSSSTUDIO_DATA']
      else process.env['MOSSSTUDIO_DATA'] = saved
    }
  })

  it('falls back to R/data (portable: also when the folder moved), and is null without R', () => {
    expect(recordedDataRoot(context())).toBe('/opt/R/data')
    expect(recordedDataRoot(context({ mode: 'portable', portable: true, root: '/media/usb/R', record: record({ portable: true, root: '/opt/R', dataRoot: '/opt/R/data' }) }))).toBe('/media/usb/R/data')
    expect(recordedDataRoot(context({ root: null }))).toBeNull()
  })
})

describe('portableUserData', () => {
  it('puts a portable copy’s Electron profile inside its data root; nothing otherwise', () => {
    expect(portableUserData(context({ mode: 'portable', portable: true }))).toBe('/opt/R/data/.electron')
    expect(portableUserData(context({ mode: 'portable', portable: true, record: record({ portable: true, dataRoot: '/opt/R/elsewhere' }) }))).toBe('/opt/R/elsewhere/.electron')
    expect(portableUserData(context({ mode: 'portable', portable: true, platform: 'darwin', root: '/Volumes/USB/Moss' }))).toBe('/Volumes/USB/Moss/data/.electron')
    expect(portableUserData(context())).toBeNull()
    expect(portableUserData(context({ mode: 'dev', root: null }))).toBeNull()
  })
})

describe('paths.root()', () => {
  const temp = useTempDir()
  let saved: string | undefined
  beforeEach(() => {
    vi.resetModules()
    saved = process.env['MOSSSTUDIO_DATA']
    delete process.env['MOSSSTUDIO_DATA']
  })
  afterEach(() => {
    if (saved === undefined) delete process.env['MOSSSTUDIO_DATA']
    else process.env['MOSSSTUDIO_DATA'] = saved
  })

  it('follows env, then setDataRoot, then the run context', async () => {
    const { resetRunContext } = await import('@main/install/runContext')
    const { root, setDataRoot } = await import('@main/lib/paths')
    const dataRoot = join(temp(), '数据 目录')
    resetRunContext(context({ record: record({ dataRoot }) }))
    expect(root()).toBe(dataRoot)
    setDataRoot(join(temp(), 'override'))
    expect(root()).toBe(join(temp(), 'override'))
    process.env['MOSSSTUDIO_DATA'] = join(temp(), 'env')
    expect(root()).toBe(join(temp(), 'env'))
    setDataRoot(null)
    resetRunContext()
  })
})
