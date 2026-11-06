import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureMacPortableRecord } from '@main/install/portable'
import { readInstallRecord, readJsonObject } from '@main/install/record'
import type { RunContext } from '@main/install/runContext'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir()

function context(root: string, patch: Partial<RunContext> = {}): RunContext {
  return {
    mode: 'portable',
    platform: 'darwin',
    platformKey: 'darwin-arm64',
    packaged: true,
    launched: false,
    silent: false,
    root,
    launcher: null,
    appPath: join(root, 'MossStudio.app'),
    recordPath: join(root, 'data', 'install.json'),
    record: null,
    locatorPath: '',
    locator: null,
    portable: true,
    setup: null,
    ...patch,
  }
}

describe('ensureMacPortableRecord', () => {
  const now = new Date('2026-11-05T00:00:00.000Z')

  it('writes install.json on first start (channel from portable.json) and keeps it afterwards', () => {
    const root = join(temp(), 'U 盘', 'MossStudio')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'portable.json'), JSON.stringify({ schema: 1, version: '2.0.0', channel: 'beta' }))
    const ctx = context(root)
    const record = ensureMacPortableRecord(ctx, '2.0.0', now)
    expect(record).toEqual({
      schema: 1,
      platform: 'darwin-arm64',
      root,
      appPath: join(root, 'MossStudio.app'),
      dataRoot: join(root, 'data'),
      portable: true,
      channel: 'beta',
      current: '2.0.0',
      failed: [],
      confirmed: false,
      installedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    expect(ctx.record).toEqual(record)
    expect(readInstallRecord(join(root, 'data', 'install.json'))).toEqual(record)
    expect(ensureMacPortableRecord(context(root), '2.0.0', new Date('2027-01-01T00:00:00.000Z'))?.updatedAt).toBe(now.toISOString())
  })

  it('rebases a moved folder, keeping unknown keys and a data root outside it', () => {
    const root = join(temp(), 'moved')
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(
      join(root, 'data', 'install.json'),
      JSON.stringify({
        schema: 1,
        platform: 'darwin-arm64',
        root: '/Volumes/Old/MossStudio',
        appPath: '/Volumes/Old/MossStudio/MossStudio.app',
        dataRoot: '/Volumes/Old/MossStudio/data',
        portable: true,
        channel: 'stable',
        current: '2.1.0',
        previous: '2.0.0',
        failed: [],
        confirmed: true,
        installedAt: 'a',
        updatedAt: 'b',
        extra: 1,
      }),
    )
    const record = ensureMacPortableRecord(context(root), '2.1.0', now)
    expect(record).toMatchObject({
      root,
      appPath: join(root, 'MossStudio.app'),
      dataRoot: join(root, 'data'),
      current: '2.1.0',
      previous: '2.0.0',
      confirmed: true,
    })
    expect(readJsonObject(join(root, 'data', 'install.json'))?.['extra']).toBe(1)
  })

  it('does nothing outside macOS portable mode', () => {
    expect(ensureMacPortableRecord(context(temp(), { platform: 'linux' }), '2.0.0')).toBeNull()
    expect(ensureMacPortableRecord(context(temp(), { mode: 'installed' }), '2.0.0')).toBeNull()
  })
})
