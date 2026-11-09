import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isLockedError, renameWithRetry, writeFileAtomic } from '@main/lib/atomicWrite'
import { useTempDir } from '@test/helpers/tempDir'

const errno = (code: string): Error => Object.assign(new Error(code), { code })

describe('renameWithRetry', () => {
  it('retries while Windows briefly locks the file, then renames', async () => {
    const attempts = vi.fn(async (_from: string, _to: string) => undefined)
    attempts.mockRejectedValueOnce(errno('EPERM')).mockRejectedValueOnce(errno('EBUSY')).mockRejectedValueOnce(errno('EACCES'))
    await renameWithRetry('a', 'b', { rename: attempts, delayMs: 0 })
    expect(attempts).toHaveBeenCalledTimes(4)
  })

  it('gives up after its attempts with the last error, and never retries another kind of error', async () => {
    const locked = vi.fn(async () => {
      throw errno('EBUSY')
    })
    await expect(renameWithRetry('a', 'b', { rename: locked, delayMs: 0, attempts: 3 })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(locked).toHaveBeenCalledTimes(3)
    const missing = vi.fn(async () => {
      throw errno('ENOENT')
    })
    await expect(renameWithRetry('a', 'b', { rename: missing, delayMs: 0 })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(missing).toHaveBeenCalledTimes(1)
  })

  it('knows the lock codes only', () => {
    expect(['EBUSY', 'EPERM', 'EACCES'].map((code) => isLockedError(errno(code)))).toEqual([true, true, true])
    expect(isLockedError(errno('ENOENT'))).toBe(false)
    expect(isLockedError(new Error('no code'))).toBe(false)
  })
})

describe('writeFileAtomic', () => {
  const dir = useTempDir()

  it('replaces the file through a temp file next to it', async () => {
    const file = join(dir(), 'list.json')
    writeFileSync(file, 'old')
    await writeFileAtomic(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('keeps the old file and removes the temp file when the rename fails', async () => {
    const file = join(dir(), 'list.json')
    writeFileSync(file, 'old')
    await expect(
      writeFileAtomic(file, 'new', {
        rename: async () => {
          throw errno('EPERM')
        },
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('a rename locked for a moment still lands', async () => {
    const file = join(dir(), 'list.json')
    let locked = 2
    await writeFileAtomic(file, 'new', {
      rename: async (from, to) => {
        if (locked-- > 0) throw errno('EBUSY')
        await rename(from, to)
      },
      delayMs: 0,
    })
    expect(readFileSync(file, 'utf8')).toBe('new')
  })
})
