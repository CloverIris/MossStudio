import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Free bytes on the volume that holds `target`; errors mean "unknown", not "zero". */
export async function freeSpace(target: string): Promise<number> {
  try {
    const stats = await statfs(dirname(target))
    return stats.bavail * stats.bsize
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export async function assertFreeSpace(target: string, neededBytes: number, label: string): Promise<void> {
  if (!(neededBytes > 0)) return
  const free = await freeSpace(target)
  if (free === Number.POSITIVE_INFINITY) return
  const required = neededBytes * 1.1
  if (free < required) {
    const fmt = (value: number): string => `${(value / 1024 ** 3).toFixed(1)} GB`
    throw new Error(`磁盘空间不足：${label}需要约 ${fmt(required)}，当前可用 ${fmt(free)}`)
  }
}
