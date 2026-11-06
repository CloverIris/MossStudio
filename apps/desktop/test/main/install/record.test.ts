import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { confirmHealthFor } from '@main/install/health'
import { readInstallRecord, readJsonObject, readLocator, updateInstallRecord, writeInstallRecord, writeJsonAtomic, writeLocator } from '@main/install/record'
import type { RunContext } from '@main/install/runContext'
import type { InstallRecord } from '@shared/install'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir()

function record(patch: Partial<InstallRecord> = {}): InstallRecord {
  return {
    schema: 1, platform: 'win32-x64', root: 'C:\\Users\\张 三\\MossStudio', dataRoot: 'C:\\Users\\张 三\\MossStudio\\data', portable: false,
    channel: 'stable', current: '2.0.0', failed: [], confirmed: false, installedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...patch,
  }
}

describe('writeJsonAtomic', () => {
  it('writes the JSON, creates the folder, and leaves no temp files behind', () => {
    const file = join(temp(), '新 目录', 'install.json')
    writeJsonAtomic(file, { a: 1 })
    writeJsonAtomic(file, { a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(join(temp(), '新 目录'))).toEqual(['install.json'])
  })
})

describe('install.json', () => {
  it('round-trips a valid record', () => {
    const file = join(temp(), 'install.json')
    writeInstallRecord(file, record())
    expect(readInstallRecord(file)).toEqual(record())
  })

  it('reads missing, corrupt and invalid files as null, and accepts a BOM', () => {
    const file = join(temp(), 'install.json')
    expect(readInstallRecord(file)).toBeNull()
    writeFileSync(file, '{ not json')
    expect(readInstallRecord(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ ...record(), current: 'latest' }))
    expect(readInstallRecord(file)).toBeNull()
    writeFileSync(file, `\uFEFF${JSON.stringify(record())}`)
    expect(readInstallRecord(file)?.current).toBe('2.0.0')
  })

  it('keeps keys it does not know and removes known optional keys that were cleared', () => {
    const file = join(temp(), 'install.json')
    writeFileSync(file, JSON.stringify({ ...record({ pending: '2.1.0', previous: '1.9.0' }), launcherVersion: 3, future: { nested: true } }))
    const next = updateInstallRecord(file, (current) => {
      const { pending: _pending, ...rest } = current
      return { ...rest, current: '2.1.0', previous: '2.0.0' }
    })
    expect(next?.current).toBe('2.1.0')
    const raw = readJsonObject(file)!
    expect(raw['launcherVersion']).toBe(3)
    expect(raw['future']).toEqual({ nested: true })
    expect(raw).not.toHaveProperty('pending')
    expect(raw['previous']).toBe('2.0.0')
  })

  it('never merges into a foreign install.json', () => {
    const file = join(temp(), 'install.json')
    writeFileSync(file, JSON.stringify({ name: 'other app', secret: 1 }))
    writeInstallRecord(file, record())
    expect(readJsonObject(file)).toEqual(record())
  })

  it('refuses to write an invalid record and leaves the file as it was', () => {
    const file = join(temp(), 'install.json')
    writeInstallRecord(file, record())
    expect(() => writeInstallRecord(file, { ...record(), current: 'nope' })).toThrow()
    expect(readInstallRecord(file)?.current).toBe('2.0.0')
  })

  it('updateInstallRecord writes nothing without a valid record', () => {
    const file = join(temp(), 'install.json')
    expect(updateInstallRecord(file, (current) => current)).toBeNull()
    expect(readdirSync(temp())).toEqual([])
  })
})

describe('locator.json', () => {
  it('round-trips and keeps unknown keys', () => {
    const file = join(temp(), 'MossStudio', 'locator.json')
    mkdirSync(join(temp(), 'MossStudio'))
    writeFileSync(file, JSON.stringify({ schema: 1, root: 'D:\\旧', dataRoot: 'D:\\旧\\data', version: '1.9.0', note: 'keep' }))
    writeLocator(file, { schema: 1, root: 'D:\\新 位置', dataRoot: 'D:\\新 位置\\data', version: '2.0.0' })
    expect(readLocator(file)).toEqual({ schema: 1, root: 'D:\\新 位置', dataRoot: 'D:\\新 位置\\data', version: '2.0.0' })
    expect(readJsonObject(file)?.['note']).toBe('keep')
  })
})

describe('confirmHealthFor', () => {
  const contextFor = (recordPath: string | null): RunContext => ({
    mode: 'installed', platform: 'win32', platformKey: 'win32-x64', packaged: true, launched: true, silent: false, root: temp(),
    launcher: null, appPath: '', recordPath, record: null, locatorPath: '', locator: null, portable: false, setup: null,
  })

  it('sets confirmed for the running version only', () => {
    const file = join(temp(), 'install.json')
    writeFileSync(file, JSON.stringify({ ...record(), extra: 1 }))
    expect(confirmHealthFor(contextFor(file), '1.9.0')).toBe(false)
    expect(readInstallRecord(file)?.confirmed).toBe(false)
    expect(confirmHealthFor(contextFor(file), '2.0.0', new Date('2026-11-05T00:00:00.000Z'))).toBe(true)
    const after = readInstallRecord(file)!
    expect(after.confirmed).toBe(true)
    expect(after.updatedAt).toBe('2026-11-05T00:00:00.000Z')
    expect(readJsonObject(file)?.['extra']).toBe(1)
    expect(confirmHealthFor(contextFor(file), '2.0.0')).toBe(true)
  })

  it('does nothing without an install record', () => {
    expect(confirmHealthFor(contextFor(null), '2.0.0')).toBe(false)
    expect(confirmHealthFor(contextFor(join(temp(), 'install.json')), '2.0.0')).toBe(false)
  })
})
