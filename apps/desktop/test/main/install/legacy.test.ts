import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { directorySize, findLegacyInstall, isLegacyRoot, legacyProgramEntries, stageLegacyProgramFiles } from '@main/install/legacy'
import { asOsPlatform } from '@main/install/layout'
import type { ExecFile } from '@main/install/registry'
import { useTempDir } from '@test/helpers/tempDir'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), openSync: vi.fn(actual.openSync) }
})

const temp = useTempDir('mossstudio-legacy-')
const platform = asOsPlatform(process.platform)!

const OLD_PROGRAM = [
  'MossStudio.exe', 'ffmpeg.dll', 'libEGL.dll', 'resources.pak', 'chrome_100_percent.pak', 'icudtl.dat', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'LICENSE', 'LICENSES.chromium.html', 'version', 'MossStudio-Setup.exe',
]

/** A 1.0.x folder: Electron files at the top, user data in data\ (with look-alike names inside). */
function makeLegacy(root: string): void {
  mkdirSync(join(root, 'resources'), { recursive: true })
  mkdirSync(join(root, 'locales'))
  mkdirSync(join(root, 'swiftshader'))
  for (const name of OLD_PROGRAM) writeFileSync(join(root, name), name)
  writeFileSync(join(root, 'resources', 'app.asar'), 'asar')
  writeFileSync(join(root, 'locales', 'zh-CN.pak'), 'pak')
  mkdirSync(join(root, 'data', 'resources'), { recursive: true })
  writeFileSync(join(root, 'data', 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(root, 'data', 'evil.dll'), 'user file')
  writeFileSync(join(root, 'data', 'resources', 'app.asar'), 'user copy')
  mkdirSync(join(root, 'data', 'models', 'moss'), { recursive: true })
  writeFileSync(join(root, 'data', 'models', 'moss', 'weights.safetensors'), Buffer.alloc(4096))
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name
      if (name.isDirectory()) walk(join(current, name.name), rel)
      else out[rel] = readFileSync(join(current, name.name), 'latin1')
    }
  }
  walk(dir, '')
  return out
}

describe('isLegacyRoot', () => {
  it('needs the exe, resources/app.asar and data/, and no v2 install.json', () => {
    const root = join(temp(), '旧 版 MossStudio')
    makeLegacy(root)
    expect(isLegacyRoot(platform, root)).toBe(true)
    writeFileSync(join(root, 'install.json'), '{}')
    expect(isLegacyRoot(platform, root)).toBe(false)
    expect(isLegacyRoot(platform, join(temp(), 'missing'))).toBe(false)
  })
})

describe('legacyProgramEntries', () => {
  it('lists exactly the old program files and never data or unknown files', () => {
    const root = join(temp(), 'old')
    makeLegacy(root)
    writeFileSync(join(root, 'my notes.txt'), 'mine')
    writeFileSync(join(root, 'config.json'), 'mine')
    // Look-alikes of Electron files that are not in the known list stay.
    for (const name of ['mylib.dll', 'LICENSE.txt', 'notes.dat', 'cache.bin', 'extra.pak']) writeFileSync(join(root, name), 'mine')
    mkdirSync(join(root, 'app-2.0.0'))
    expect(legacyProgramEntries(root)).toEqual([...OLD_PROGRAM, 'locales', 'resources', 'swiftshader'].sort())
  })
})

describe('stageLegacyProgramFiles', () => {
  it('refuses a folder that is not a real 1.0.x root and deletes nothing', () => {
    const root = join(temp(), 'not-old')
    mkdirSync(root)
    for (const name of ['ffmpeg.dll', 'LICENSE', 'resources.pak']) writeFileSync(join(root, name), 'x')
    expect(() => stageLegacyProgramFiles(root, 'x')).toThrow(expect.objectContaining({ code: 'E_NOT_LEGACY' }))
    expect(readdirSync(root).sort()).toEqual(['LICENSE', 'ffmpeg.dll', 'resources.pak'])
  })


  it('moves the old program aside and commit removes it; data is untouched', () => {
    const root = join(temp(), 'old')
    makeLegacy(root)
    writeFileSync(join(root, 'keep.txt'), 'mine')
    const before = snapshot(join(root, 'data'))
    const staged = stageLegacyProgramFiles(root, 'test')
    expect(staged.moved.length).toBe(OLD_PROGRAM.length + 3)
    expect(readdirSync(root).sort()).toEqual(['.moss-legacy-test', 'data', 'keep.txt'])
    staged.commit()
    expect(readdirSync(root).sort()).toEqual(['data', 'keep.txt'])
    expect(snapshot(join(root, 'data'))).toEqual(before)
  })

  it('puts everything back when a file is locked (1.0.x still running), touching no data', () => {
    const root = join(temp(), 'old')
    makeLegacy(root)
    const before = snapshot(root)
    const rename = vi.mocked(fs.renameSync)
    const real = rename.getMockImplementation()!
    rename.mockImplementation((from, to) => {
      if (String(from).endsWith('MossStudio.exe') && String(to).includes('.moss-legacy-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(from, to)
    })
    try {
      expect(() => stageLegacyProgramFiles(root, 'locked')).toThrow(expect.objectContaining({ code: 'E_LEGACY_IN_USE' }))
    } finally {
      rename.mockImplementation(real)
    }
    expect(snapshot(root)).toEqual(before)
    expect(existsSync(join(root, '.moss-legacy-locked'))).toBe(false)
  })
})

describe('stageLegacyProgramFiles: running 1.0.x', () => {
  it('refuses before moving anything when the old exe is locked for writing', () => {
    const root = join(temp(), 'old')
    makeLegacy(root)
    const before = snapshot(root)
    const open = vi.mocked(fs.openSync)
    const real = open.getMockImplementation()!
    open.mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file).endsWith('MossStudio.exe') && flags === 'r+') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(file, flags ?? "r", mode)
    }) as typeof fs.openSync)
    try {
      expect(() => stageLegacyProgramFiles(root, 'running')).toThrow(expect.objectContaining({ code: 'E_LEGACY_IN_USE' }))
    } finally {
      open.mockImplementation(real)
    }
    expect(snapshot(root)).toEqual(before)
  })
})

describe('findLegacyInstall', () => {
  it('uses the old registry InstallLocation (UTF-16 export) on Windows', async () => {
    const root = join(temp(), '张 三', 'Programs', 'MossStudio')
    makeLegacy(root)
    const exported = `Windows Registry Editor Version 5.00\r\n\r\n[HKCU\\x]\r\n"InstallLocation"="${root.replace(/\\/g, '\\\\')}"\r\n"DisplayVersion"="1.0.3"\r\n`
    const exec: ExecFile = async (_file, args) => {
      writeFileSync(args[2]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(exported, 'utf16le')]))
      return { code: 0, stdout: '', stderr: '' }
    }
    const found = await findLegacyInstall({ host: { platform: 'win32', home: temp(), env: {} }, registry: { exec, env: {} } })
    expect(found).toMatchObject({ root, dataDir: expect.stringContaining('data'), version: '1.0.3', source: 'registry', dataBytes: null })
  })

  it('falls back to the old default folder and finds nothing on macOS', async () => {
    const home = temp()
    const host = { platform, home, env: { LOCALAPPDATA: join(home, 'Local'), XDG_DATA_HOME: join(home, 'share') } }
    const fallback = platform === 'win32' ? join(home, 'Local', 'Programs', 'MossStudio') : join(home, 'share', 'MossStudio')
    if (platform !== 'darwin') {
      makeLegacy(fallback)
      expect((await findLegacyInstall({ host, registry: null }))?.source).toBe('default')
    }
    expect(await findLegacyInstall({ host: { platform: 'darwin', home, env: {} } })).toBeNull()
  })
})

describe('directorySize', () => {
  it('sums regular files below a folder', async () => {
    const root = join(temp(), 'old')
    makeLegacy(root)
    expect(await directorySize(join(root, 'data'))).toBe('{"theme":"dark"}'.length + 'user file'.length + 'user copy'.length + 4096)
    expect(await directorySize(join(temp(), 'missing'))).toBe(0)
  })
})
