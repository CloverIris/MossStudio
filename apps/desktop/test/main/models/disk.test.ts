import { afterEach, describe, expect, it, vi } from 'vitest'

const statfs = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, statfs, default: { ...actual, statfs } }
})

import { assertFreeSpace, freeSpace } from '@main/lib/disk'

const GB = 1024 ** 3
afterEach(() => statfs.mockReset())

describe('freeSpace', () => {
  it('multiplies available blocks by block size of the parent directory', async () => {
    statfs.mockResolvedValue({ bavail: 10, bsize: 4096 })
    expect(await freeSpace('/data/models/file.bin')).toBe(40960)
    expect(statfs).toHaveBeenCalledWith('/data/models')
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
