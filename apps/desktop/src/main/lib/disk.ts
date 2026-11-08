import { stat, statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { freeSpaceNeeded } from '@shared/machineFit'

/**
 * The target itself when it exists, else its nearest existing ancestor: the
 * folder whose disk the target is, or will be, on. A folder that is itself a
 * mount point (a second drive) is read as that drive, not as its parent.
 */
export async function nearestExisting(target: string): Promise<string> {
  let current = resolve(target)
  for (;;) {
    try {
      await stat(current)
      return current
    } catch {
      // Not there yet: its files will land on the disk of the folder above.
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/** Free bytes on the volume that holds `target`; errors mean "unknown", not "zero". */
export async function freeSpace(target: string): Promise<number> {
  try {
    const stats = await statfs(await nearestExisting(target))
    return stats.bavail * stats.bsize
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export async function assertFreeSpace(target: string, neededBytes: number, label: string): Promise<void> {
  if (!(neededBytes > 0)) return
  const free = await freeSpace(target)
  if (free === Number.POSITIVE_INFINITY) return
  const required = freeSpaceNeeded(neededBytes)
  if (free < required) {
    const fmt = (value: number): string => `${(value / 1024 ** 3).toFixed(1)} GB`
    throw new Error(`磁盘空间不足：${label}需要约 ${fmt(required)}，当前可用 ${fmt(free)}`)
  }
}
