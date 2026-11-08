import { afterEach, describe, expect, it, vi } from 'vitest'

const statfs = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, statfs, default: { ...actual, statfs } }
})

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertFreeSpace, freeSpace, nearestExisting } from '@main/lib/disk'
import { useTempDir } from '@test/helpers/tempDir'

const GB = 1024 ** 3
afterEach(() => statfs.mockReset())

describe('freeSpace', () => {
  const dir = useTempDir()

  it('reads the folder itself when it exists: a folder that is a mount point is its own drive', async () => {
    const models = join(dir(), 'models')
    mkdirSync(models)
    statfs.mockResolvedValue({ bavail: 10, bsize: 4096 })
    expect(await freeSpace(models)).toBe(40960)
    expect(statfs).toHaveBeenCalledWith(models)
  })

  it('reads the nearest folder that exists for a file or folder not created yet', async () => {
    const models = join(dir(), 'models')
    mkdirSync(models)
    statfs.mockResolvedValue({ bavail: 10, bsize: 4096 })
    await freeSpace(join(models, 'blobs', 'abc.part'))
    expect(statfs).toHaveBeenLastCalledWith(models)
    expect(await nearestExisting(join(dir(), 'a', 'b', 'c'))).toBe(dir())
  })

  it('treats an unknown volume as unlimited, not zero', async () => {
    statfs.mockRejectedValue(new Error('ENOENT'))
    expect(await freeSpace('/missing/x')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('assertFreeSpace', () => {
  it('requires 10% headroom over the requested bytes', async () => {
    statfs.mockResolvedValue({ bavail: 11, bsize: GB })
    await expect(assertFreeSpace('/d/x', 10 * GB, '模型')).resolves.toBeUndefined()
    statfs.mockResolvedValue({ bavail: 10.9, bsize: GB })
    await expect(assertFreeSpace('/d/x', 10 * GB, '模型')).rejects.toThrow('磁盘空间不足：模型需要约 11.0 GB，当前可用 10.9 GB')
  })

  it('skips the check for zero, negative or NaN sizes and unknown volumes', async () => {
    statfs.mockResolvedValue({ bavail: 0, bsize: 4096 })
    for (const bytes of [0, -5, Number.NaN]) await expect(assertFreeSpace('/d/x', bytes, 'x')).resolves.toBeUndefined()
    expect(statfs).not.toHaveBeenCalled()
    statfs.mockRejectedValue(new Error('EPERM'))
    await expect(assertFreeSpace('/d/x', 10 * GB, 'x')).resolves.toBeUndefined()
  })
})
