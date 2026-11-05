import { describe, expect, it } from 'vitest'
import { type GpuLoad, selectAutomaticGpu } from '@shared/gpuScheduling'
import type { GpuInventoryDevice } from '@shared/types'

const GiB = 1024 ** 3

const gpu = (
  uuid: string,
  index: number,
  capability: { major: number; minor: number } | undefined,
  memory: number | undefined,
): GpuInventoryDevice => ({
  uuid,
  index,
  name: `GPU ${uuid}`,
  computeCapability: capability,
  memoryTotalBytes: memory,
})

const devices = [
  gpu('slow', 0, { major: 7, minor: 5 }, 8 * GiB),
  gpu('fast', 1, { major: 8, minor: 9 }, 24 * GiB),
  gpu('middle', 2, { major: 8, minor: 0 }, 16 * GiB),
]
const all = new Set(['slow', 'fast', 'middle'])
const busy = (runningTasks: number, queuedTasks = 0): GpuLoad => ({ runningTasks, queuedTasks })

describe('selectAutomaticGpu', () => {
  it('selects the strongest idle compatible GPU', () => {
    expect(selectAutomaticGpu(devices, all, { fast: busy(1) })?.uuid).toBe('middle')
    expect(selectAutomaticGpu(devices, all, {})?.uuid).toBe('fast')
  })

  it('treats queued work as busy', () => {
    expect(selectAutomaticGpu(devices, all, { fast: busy(0, 1) })?.uuid).toBe('middle')
  })

  it('treats an explicit zero load as idle', () => {
    expect(selectAutomaticGpu(devices, all, { fast: busy(0, 0) })?.uuid).toBe('fast')
  })

  it('excludes unsupported GPUs and prefers the least loaded when all are busy', () => {
    expect(
      selectAutomaticGpu(devices, new Set(['slow', 'fast']), {
        slow: busy(1, 2),
        fast: busy(1, 0),
        middle: busy(0, 0),
      })?.uuid,
    ).toBe('fast')
    expect(
      selectAutomaticGpu(devices, all, { slow: busy(1), fast: busy(2, 3), middle: busy(1, 1) })?.uuid,
    ).toBe('slow')
  })

  it('counts running and queued tasks equally', () => {
    expect(selectAutomaticGpu(devices, new Set(['slow', 'fast']), { slow: busy(0, 1), fast: busy(2, 0) })?.uuid).toBe('slow')
  })

  it('breaks equal-load ties by performance ordering', () => {
    expect(selectAutomaticGpu(devices, new Set(['slow', 'fast']), { slow: busy(1), fast: busy(1) })?.uuid).toBe('fast')
  })

  it('ranks by major, then minor, then memory, then index', () => {
    const ranked = [
      gpu('a', 3, { major: 8, minor: 6 }, 12 * GiB),
      gpu('b', 1, { major: 8, minor: 6 }, 12 * GiB),
      gpu('c', 0, { major: 8, minor: 6 }, 8 * GiB),
      gpu('d', 2, { major: 8, minor: 9 }, 4 * GiB),
    ]
    const ids = new Set(ranked.map((item) => item.uuid))
    const order: string[] = []
    const loads: Record<string, GpuLoad> = {}
    for (let round = 0; round < ranked.length; round += 1) {
      const selected = selectAutomaticGpu(ranked, ids, loads)
      expect(selected).not.toBeNull()
      order.push(selected!.uuid)
      loads[selected!.uuid] = busy(1)
    }
    expect(order).toEqual(['d', 'b', 'a', 'c'])
  })

  it('ranks GPUs with unknown capability and memory last', () => {
    const mixed = [gpu('unknown', 0, undefined, undefined), gpu('known', 1, { major: 6, minor: 1 }, 2 * GiB)]
    expect(selectAutomaticGpu(mixed, new Set(['unknown', 'known']), {})?.uuid).toBe('known')
    expect(selectAutomaticGpu(mixed, new Set(['unknown']), {})?.uuid).toBe('unknown')
  })

  it('returns null when no GPU is confirmed compatible', () => {
    expect(selectAutomaticGpu(devices, new Set(), {})).toBeNull()
    expect(selectAutomaticGpu(devices, new Set(['ghost']), {})).toBeNull()
    expect(selectAutomaticGpu([], all, {})).toBeNull()
  })

  it('does not reorder the caller’s device list', () => {
    const before = devices.map((item) => item.uuid)
    selectAutomaticGpu(devices, all, { slow: busy(1), fast: busy(1), middle: busy(1) })
    expect(devices.map((item) => item.uuid)).toEqual(before)
  })
})
