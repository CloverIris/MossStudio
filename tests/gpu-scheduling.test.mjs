import assert from 'node:assert/strict'
import test from 'node:test'
import { selectAutomaticGpu } from '../apps/desktop/src/shared/gpuScheduling.ts'

const gpu = (uuid, index, capability, memory) => ({
  uuid,
  index,
  name: `GPU ${uuid}`,
  computeCapability: capability,
  memoryTotalBytes: memory,
})

const devices = [
  gpu('slow', 0, { major: 7, minor: 5 }, 8 * 1024 ** 3),
  gpu('fast', 1, { major: 8, minor: 9 }, 24 * 1024 ** 3),
  gpu('middle', 2, { major: 8, minor: 0 }, 16 * 1024 ** 3),
]

test('auto scheduling selects the strongest idle compatible GPU', () => {
  const selected = selectAutomaticGpu(
    devices,
    new Set(['slow', 'fast', 'middle']),
    { fast: { runningTasks: 1, queuedTasks: 0 } },
  )
  assert.equal(selected?.uuid, 'middle')
})

test('auto scheduling excludes unsupported GPUs and prefers least-loaded when all are busy', () => {
  const selected = selectAutomaticGpu(
    devices,
    new Set(['slow', 'fast']),
    {
      slow: { runningTasks: 1, queuedTasks: 2 },
      fast: { runningTasks: 1, queuedTasks: 0 },
      middle: { runningTasks: 0, queuedTasks: 0 },
    },
  )
  assert.equal(selected?.uuid, 'fast')
})

test('auto scheduling uses performance ordering to break equal-load ties', () => {
  const selected = selectAutomaticGpu(
    devices,
    new Set(['slow', 'fast']),
    {
      slow: { runningTasks: 1, queuedTasks: 0 },
      fast: { runningTasks: 1, queuedTasks: 0 },
    },
  )
  assert.equal(selected?.uuid, 'fast')
})

test('auto scheduling returns no GPU when none are confirmed compatible', () => {
  assert.equal(selectAutomaticGpu(devices, new Set(), {}), null)
})
