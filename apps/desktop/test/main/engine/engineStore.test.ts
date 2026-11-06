import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanupPromotedInstall,
  engineServerPath,
  getEngineInstallProgress,
  isManagedEngineDirectory,
  promoteInstall,
  readEngineLastAttempt,
  recoverEngineInstall,
  setEngineInstallProgress,
  writeEngineLastAttempt,
} from '@main/lib/engineStore'
import { useTempDir } from '@test/helpers/tempDir'

const tempDir = useTempDir('mossstudio-engine-store-')
const stamp = 'stable-v2.1.1-cu13'

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

async function fixture(): Promise<{ root: string; stagingDir: string; installDir: string }> {
  const root = tempDir()
  const stagingDir = join(root, '.staging', `${stamp}-new`)
  await mkdir(join(stagingDir, 'bin'), { recursive: true })
  await writeFile(join(stagingDir, 'bin', 'moss-server'), 'new')
  return { root, stagingDir, installDir: join(root, stamp) }
}

async function addOldInstall(installDir: string): Promise<void> {
  await mkdir(join(installDir, 'bin'), { recursive: true })
  await writeFile(join(installDir, 'bin', 'moss-server'), 'old')
}

const server = (dir: string): Promise<string> => readFile(join(dir, 'bin', 'moss-server'), 'utf8')

describe('promoteInstall', () => {
  it('promotes directly when there is no previous install', async () => {
    const { root, stagingDir, installDir } = await fixture()
    const result = await promoteInstall({ root, stagingDir, stamp, currentServerPath: null })
    expect(result).toEqual({ installDir, backupDir: undefined, trashDir: undefined })
    expect(await server(installDir)).toBe('new')
    expect(existsSync(stagingDir)).toBe(false)
    expect(existsSync(join(root, '.pending.json'))).toBe(false)
  })

  it('moves a non-current previous version to trash and cleans it after settings update', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    let shutdownCalled = false
    const result = await promoteInstall({
      root,
      stagingDir,
      stamp,
      currentServerPath: null,
      beforeReplace: async () => {
        shutdownCalled = true
      },
    })
    // Replacing a version that is not running needs no engine shutdown.
    expect(shutdownCalled).toBe(false)
    expect(result.backupDir).toBeUndefined()
    expect(result.trashDir).toContain(join(root, '.trash'))
    expect(await server(result.trashDir!)).toBe('old')
    expect(await server(installDir)).toBe('new')
    await cleanupPromotedInstall(result)
    expect(existsSync(result.trashDir!)).toBe(false)
  })

  it('backs up the current version and shuts the engine down first', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    const order: string[] = []
    const result = await promoteInstall(
      {
        root,
        stagingDir,
        stamp,
        currentServerPath: join(installDir, 'bin', 'moss-server'),
        beforeReplace: async () => {
          order.push('shutdown')
        },
      },
      {
        ops: {
          rename: async (from, to) => {
            order.push(`rename:${from === installDir ? 'old' : 'new'}`)
            await rename(from, to)
          },
        },
      },
    )
    expect(order.filter((step) => step !== 'rename:new').slice(0, 2)).toEqual(['shutdown', 'rename:old'])
    expect(result.backupDir).toContain(join(root, '.backup'))
    expect(result.trashDir).toBeUndefined()
    expect(await server(result.backupDir!)).toBe('old')
    await cleanupPromotedInstall(result)
    expect(existsSync(result.backupDir!)).toBe(false)
  })

  it('rolls back from the backup when replacing the current version fails', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    let shutdownCalled = false
    await expect(
      promoteInstall(
        {
          root,
          stagingDir,
          stamp,
          currentServerPath: join(installDir, 'bin', 'moss-server'),
          beforeReplace: async () => {
            shutdownCalled = true
          },
        },
        {
          retryDelayMs: 0,
          ops: {
            rename: async (from, to) => {
              if (from === stagingDir && to === installDir) throw errno('EPERM', 'locked')
              await rename(from, to)
            },
          },
        },
      ),
    ).rejects.toThrow(/无法替换旧目录/)
    expect(shutdownCalled).toBe(true)
    expect(await server(installDir)).toBe('old')
    expect(existsSync(stagingDir)).toBe(false)
    expect(existsSync(join(root, '.pending.json'))).toBe(false)
  })

  it('cleans staging and leaves installDir untouched after repeated EPERM on the old directory', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    let attempts = 0
    await expect(
      promoteInstall(
        { root, stagingDir, stamp, currentServerPath: join(installDir, 'bin', 'moss-server') },
        {
          retryDelayMs: 0,
          ops: {
            rename: async (from, to) => {
              if (from === installDir) {
                attempts += 1
                throw errno('EPERM', 'in use')
              }
              await rename(from, to)
            },
          },
        },
      ),
    ).rejects.toThrow(/引擎正在使用/)
    expect(attempts).toBe(5)
    expect(await server(installDir)).toBe('old')
    expect(existsSync(stagingDir)).toBe(false)
  })

  it('a transient EBUSY is retried and the promotion succeeds', async () => {
    const { root, stagingDir, installDir } = await fixture()
    let failures = 0
    await promoteInstall(
      { root, stagingDir, stamp, currentServerPath: null },
      {
        retryDelayMs: 0,
        ops: {
          rename: async (from, to) => {
            if (from === stagingDir && failures < 2) {
              failures += 1
              throw errno('EBUSY')
            }
            await rename(from, to)
          },
        },
      },
    )
    expect(failures).toBe(2)
    expect(await server(installDir)).toBe('new')
  })

  it('a non-retryable error fails at once with a generic message', async () => {
    const { root, stagingDir } = await fixture()
    let attempts = 0
    await expect(
      promoteInstall(
        { root, stagingDir, stamp, currentServerPath: null },
        {
          retryDelayMs: 0,
          ops: {
            rename: async (from, to) => {
              if (from === stagingDir) {
                attempts += 1
                throw errno('ENOSPC', 'disk full')
              }
              await rename(from, to)
            },
          },
        },
      ),
    ).rejects.toThrow(/^引擎目录晋升失败：disk full$/)
    expect(attempts).toBe(1)
  })

  it('keeps the journal for startup recovery when the rollback itself fails', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    await expect(
      promoteInstall(
        { root, stagingDir, stamp, currentServerPath: join(installDir, 'bin', 'moss-server') },
        {
          retryDelayMs: 0,
          ops: {
            rename: async (from, to) => {
              if (from === stagingDir) throw errno('EPERM', 'locked')
              if (to === installDir) throw errno('EIO', 'rollback broke')
              await rename(from, to)
            },
          },
        },
      ),
    ).rejects.toThrow(/自动回滚也失败.*rollback broke/)
    expect(existsSync(join(root, '.pending.json'))).toBe(true)
    expect(existsSync(installDir)).toBe(false)
    // Startup recovery restores the backup.
    const recovered = await recoverEngineInstall(root, { retryDelayMs: 0 })
    expect(recovered.restored).toEqual([installDir])
    expect(await server(installDir)).toBe('old')
  })

  it.each(['../evil', '.hidden', '', 'a/b'])('rejects the invalid stamp %j', async (badStamp) => {
    const { root, stagingDir } = await fixture()
    await expect(promoteInstall({ root, stagingDir, stamp: badStamp, currentServerPath: null })).rejects.toThrow(/stamp 无效/)
  })

  it('rejects a staging directory outside .staging or equal to it', async () => {
    const { root } = await fixture()
    await mkdir(join(root, 'elsewhere'))
    await expect(promoteInstall({ root, stagingDir: join(root, 'elsewhere'), stamp, currentServerPath: null })).rejects.toThrow(
      /\.staging 内/,
    )
    await expect(promoteInstall({ root, stagingDir: join(root, '.staging'), stamp, currentServerPath: null })).rejects.toThrow(
      /\.staging 内/,
    )
  })

  it('rejects a missing staging directory', async () => {
    const { root } = await fixture()
    await expect(promoteInstall({ root, stagingDir: join(root, '.staging', 'gone'), stamp, currentServerPath: null })).rejects.toThrow(
      '引擎暂存目录不存在',
    )
  })
})

describe('recoverEngineInstall', () => {
  it('restores the old engine when installDir is missing and a backup exists', async () => {
    const { root, stagingDir, installDir } = await fixture()
    const backupDir = join(root, '.backup', `${stamp}-old`)
    await addOldInstall(backupDir)
    await writeFile(
      join(root, '.pending.json'),
      JSON.stringify({ schemaVersion: 1, stamp, installDir, stagingDir, previousDir: backupDir }),
    )
    const result = await recoverEngineInstall(root, { retryDelayMs: 0 })
    expect(result.restored).toEqual([installDir])
    expect(await server(installDir)).toBe('old')
    expect(existsSync(join(root, '.pending.json'))).toBe(false)
    expect(existsSync(stagingDir)).toBe(false)
  })

  it('drops the previous dir when the new install already landed', async () => {
    const { root, stagingDir, installDir } = await fixture()
    await addOldInstall(installDir)
    const trashDir = join(root, '.trash', `${stamp}-old`)
    await addOldInstall(trashDir)
    await writeFile(join(root, '.pending.json'), JSON.stringify({ schemaVersion: 1, stamp, installDir, stagingDir, previousDir: trashDir }))
    const result = await recoverEngineInstall(root, { retryDelayMs: 0 })
    expect(result.restored).toEqual([])
    expect(result.cleaned).toEqual(expect.arrayContaining([trashDir, stagingDir]))
    expect(existsSync(trashDir)).toBe(false)
    expect(await server(installDir)).toBe('old')
  })

  it('refuses a journal pointing outside the engine root', async () => {
    const { root, stagingDir } = await fixture()
    await writeFile(
      join(root, '.pending.json'),
      JSON.stringify({ schemaVersion: 1, stamp, installDir: join(root, '..', 'victim'), stagingDir }),
    )
    await expect(recoverEngineInstall(root)).rejects.toThrow(/越界路径/)
    expect(existsSync(join(root, '.pending.json'))).toBe(true)
  })

  it('refuses a journal whose installDir is the root itself', async () => {
    const { root, stagingDir } = await fixture()
    await writeFile(join(root, '.pending.json'), JSON.stringify({ schemaVersion: 1, stamp, installDir: root, stagingDir }))
    await expect(recoverEngineInstall(root)).rejects.toThrow(/越界路径/)
  })

  it('discards a corrupt journal and sweeps leftover work directories', async () => {
    const { root } = await fixture()
    await writeFile(join(root, '.pending.json'), '{not json')
    await mkdir(join(root, '.trash', 'x'), { recursive: true })
    await mkdir(join(root, '.backup', 'y'), { recursive: true })
    await mkdir(join(root, 'stable-v1-cu13'), { recursive: true })
    const result = await recoverEngineInstall(root)
    expect(result.restored).toEqual([])
    expect(result.cleaned.sort()).toEqual([join(root, '.backup'), join(root, '.staging'), join(root, '.trash')].sort())
    expect(await readdir(root)).toEqual(['stable-v1-cu13'])
  })

  it('creates a missing root and reports nothing to do', async () => {
    const root = join(tempDir(), 'fresh')
    expect(await recoverEngineInstall(root)).toEqual({ restored: [], cleaned: [] })
    expect(existsSync(root)).toBe(true)
  })
})

describe('helpers', () => {
  it('lists only non-dot directories as versions', async () => {
    const { root } = await fixture()
    await mkdir(join(root, '.trash'), { recursive: true })
    await mkdir(join(root, '.backup'), { recursive: true })
    await mkdir(join(root, 'stable-v2.1.1-cu13'), { recursive: true })
    const visible = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isManagedEngineDirectory(entry.name))
      .map((entry) => entry.name)
    expect(visible).toEqual(['stable-v2.1.1-cu13'])
  })

  it('round-trips the last install attempt and ignores invalid files', async () => {
    const root = join(tempDir(), 'engine')
    expect(readEngineLastAttempt(root)).toBeNull()
    writeEngineLastAttempt(root, { at: '2026-01-01T00:00:00.000Z', version: 'v1', error: 'boom' })
    expect(readEngineLastAttempt(root)).toEqual({ at: '2026-01-01T00:00:00.000Z', version: 'v1', error: 'boom' })
    expect(existsSync(join(root, 'last-attempt.json.tmp'))).toBe(false)
    await writeFile(join(root, 'last-attempt.json'), JSON.stringify({ version: 'v2' }))
    expect(readEngineLastAttempt(root)).toBeNull()
    await writeFile(join(root, 'last-attempt.json'), 'garbage')
    expect(readEngineLastAttempt(root)).toBeNull()
  })

  it('tracks the active install progress', () => {
    setEngineInstallProgress({ phase: 'downloading', percent: 12 })
    expect(getEngineInstallProgress()).toEqual({ phase: 'downloading', percent: 12 })
    setEngineInstallProgress(null)
    expect(getEngineInstallProgress()).toBeNull()
  })

  it('places the server binary under bin/', () => {
    const name = process.platform === 'win32' ? 'moss-server.exe' : 'moss-server'
    expect(engineServerPath('/x')).toBe(join('/x', 'bin', name))
  })
})
