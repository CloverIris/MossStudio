import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNvidiaComputeCapabilities,
  parseNvidiaGpuRows,
  recommendedGpu,
  resolveGpuSelection,
} from '../apps/desktop/src/main/lib/gpuInventory.ts'

test('parses NVIDIA inventory rows with stable UUIDs and optional telemetry', () => {
  const devices = parseNvidiaGpuRows([
    '0, GPU-aaa, NVIDIA GeForce RTX 2080, 8192, 4096, 25, 560.10',
    '1, GPU-bbb, NVIDIA GeForce RTX 4080, 16376, N/A, N/A, 560.10',
    'bad row',
  ].join('\n'))

  assert.equal(devices.length, 2)
  assert.equal(devices[0].uuid, 'GPU-aaa')
  assert.equal(devices[0].memoryTotalBytes, 8192 * 1024 * 1024)
  assert.equal(devices[0].memoryFreeBytes, 4096 * 1024 * 1024)
  assert.equal(devices[0].utilizationPercent, 25)
  assert.equal(devices[1].memoryFreeBytes, undefined)
  assert.equal(devices[1].utilizationPercent, undefined)
})

test('joins compute capabilities by UUID and recommends strongest known card deterministically', () => {
  const capabilities = parseNvidiaComputeCapabilities('GPU-bbb, 8.9\nGPU-aaa, 7.5\nGPU-unknown, N/A')
  const devices = parseNvidiaGpuRows([
    '0, GPU-aaa, RTX 2080, 8192, 4096, 10, 560.10',
    '1, GPU-bbb, RTX 4080, 16376, 8192, 20, 560.10',
    '2, GPU-unknown, Unknown GPU, 32768, 16000, 0, 560.10',
  ].join('\n'))
  for (const device of devices) device.computeCapability = capabilities.get(device.uuid)

  assert.deepEqual(capabilities.get('GPU-aaa'), { major: 7, minor: 5 })
  assert.equal(recommendedGpu(devices)?.uuid, 'GPU-bbb')
  assert.equal(recommendedGpu(devices.filter((device) => !device.computeCapability)), null)
})

test('resolves Canvas GPU UUID to its current ordinal without silently rebinding missing devices', () => {
  const devices = parseNvidiaGpuRows([
    '0, GPU-bbb, RTX 4080, 16376, 8192, 20, 560.10',
    '1, GPU-aaa, RTX 2080, 8192, 4096, 10, 560.10',
  ].join('\n'))

  assert.equal(resolveGpuSelection(devices, 'auto', 'GPU-bbb')?.index, 0)
  assert.equal(resolveGpuSelection(devices, { uuid: 'GPU-aaa' }, 'GPU-bbb')?.uuid, 'GPU-bbb')
  assert.equal(resolveGpuSelection(devices, 'auto', 'GPU-removed'), null)
})
