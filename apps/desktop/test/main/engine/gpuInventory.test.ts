import { describe, expect, it } from 'vitest'
import type { GpuInventoryDevice } from '@shared/types'
import { parseNvidiaComputeCapabilities, parseNvidiaGpuRows, recommendedGpu, resolveGpuSelection } from '@main/lib/gpuInventory'

describe('parseNvidiaGpuRows', () => {
  it('parses NVIDIA inventory rows with stable UUIDs and optional telemetry', () => {
    const devices = parseNvidiaGpuRows(
      [
        '0, GPU-aaa, NVIDIA GeForce RTX 2080, 8192, 4096, 25, 560.10',
        '1, GPU-bbb, NVIDIA GeForce RTX 4080, 16376, N/A, N/A, 560.10',
        'bad row',
      ].join('\n'),
    )

    expect(devices).toHaveLength(2)
    expect(devices[0]!.uuid).toBe('GPU-aaa')
    expect(devices[0]!.memoryTotalBytes).toBe(8192 * 1024 * 1024)
    expect(devices[0]!.memoryFreeBytes).toBe(4096 * 1024 * 1024)
    expect(devices[0]!.utilizationPercent).toBe(25)
    expect(devices[0]!.driverVersion).toBe('560.10')
    expect(devices[1]!.memoryFreeBytes).toBeUndefined()
    expect(devices[1]!.utilizationPercent).toBeUndefined()
  })

  it('handles CRLF, blank lines, missing trailing columns and N/A drivers', () => {
    const devices = parseNvidiaGpuRows('0, GPU-a, A\r\n\r\n1, GPU-b, B, 100, 50, 0, N/A\r\n')
    expect(devices).toEqual([
      {
        index: 0,
        uuid: 'GPU-a',
        name: 'A',
        memoryTotalBytes: undefined,
        memoryFreeBytes: undefined,
        utilizationPercent: undefined,
        driverVersion: undefined,
      },
      {
        index: 1,
        uuid: 'GPU-b',
        name: 'B',
        memoryTotalBytes: 100 * 1024 * 1024,
        memoryFreeBytes: 50 * 1024 * 1024,
        utilizationPercent: 0,
        driverVersion: undefined,
      },
    ])
  })

  it('drops rows without an index, uuid or name and rejects negative memory', () => {
    const devices = parseNvidiaGpuRows(['x, GPU-a, A', '0, , A', '0, GPU-a, ', '2, GPU-c, C, -5, 1'].join('\n'))
    expect(devices).toHaveLength(1)
    expect(devices[0]!.memoryTotalBytes).toBeUndefined()
    expect(devices[0]!.memoryFreeBytes).toBe(1024 * 1024)
  })

  it('returns nothing for empty output', () => {
    expect(parseNvidiaGpuRows('')).toEqual([])
  })
})

describe('compute capabilities and recommendation', () => {
  it('joins compute capabilities by UUID and recommends strongest known card deterministically', () => {
    const capabilities = parseNvidiaComputeCapabilities('GPU-bbb, 8.9\nGPU-aaa, 7.5\nGPU-unknown, N/A')
    const devices = parseNvidiaGpuRows(
      [
        '0, GPU-aaa, RTX 2080, 8192, 4096, 10, 560.10',
        '1, GPU-bbb, RTX 4080, 16376, 8192, 20, 560.10',
        '2, GPU-unknown, Unknown GPU, 32768, 16000, 0, 560.10',
      ].join('\n'),
    )
    for (const device of devices) device.computeCapability = capabilities.get(device.uuid)

    expect(capabilities.get('GPU-aaa')).toEqual({ major: 7, minor: 5 })
    expect(capabilities.has('GPU-unknown')).toBe(false)
    expect(recommendedGpu(devices)?.uuid).toBe('GPU-bbb')
    expect(recommendedGpu(devices.filter((device) => !device.computeCapability))).toBeNull()
  })

  it('breaks capability ties by memory, then by lowest index', () => {
    const device = (index: number, memory: number): GpuInventoryDevice => ({
      index,
      uuid: `GPU-${index}`,
      name: `G${index}`,
      memoryTotalBytes: memory,
      computeCapability: { major: 8, minor: 6 },
    })
    expect(recommendedGpu([device(0, 8), device(1, 24), device(2, 24)])?.uuid).toBe('GPU-1')
    expect(recommendedGpu([device(3, 8), device(2, 8)])?.uuid).toBe('GPU-2')
    expect(recommendedGpu([])).toBeNull()
  })

  it('passes over a card too small for the model when another GPU can run it', () => {
    const GiB = 1024 ** 3
    const mx250: GpuInventoryDevice = {
      index: 0,
      uuid: 'GPU-mx',
      name: 'MX250',
      memoryTotalBytes: 2 * GiB,
      computeCapability: { major: 6, minor: 1 },
    }
    const uhd: GpuInventoryDevice = { index: 1, uuid: 'vk-8086-5917-0', name: 'UHD 620', vendor: 'intel' }
    expect(recommendedGpu([mx250, uhd])?.uuid).toBe('vk-8086-5917-0')
    // Nothing else there: the small card is still the one to use.
    expect(recommendedGpu([mx250])?.uuid).toBe('GPU-mx')
    // A bigger NVIDIA card wins as before.
    expect(recommendedGpu([mx250, { ...mx250, uuid: 'GPU-big', index: 2, memoryTotalBytes: 8 * GiB }, uhd])?.uuid).toBe('GPU-big')
  })

  it('does not mutate the inventory order', () => {
    const devices: GpuInventoryDevice[] = [
      { index: 0, uuid: 'a', name: 'a', computeCapability: { major: 7, minor: 5 } },
      { index: 1, uuid: 'b', name: 'b', computeCapability: { major: 9, minor: 0 } },
    ]
    recommendedGpu(devices)
    expect(devices.map((d) => d.uuid)).toEqual(['a', 'b'])
  })

  it('ignores malformed capability rows', () => {
    expect(parseNvidiaComputeCapabilities('GPU-a, 8\nGPU-b, 8.x\n, 8.6\nGPU-c, 12.0').size).toBe(1)
  })
})

describe('resolveGpuSelection', () => {
  it('resolves Canvas GPU UUID to its current ordinal without silently rebinding missing devices', () => {
    const devices = parseNvidiaGpuRows(
      ['0, GPU-bbb, RTX 4080, 16376, 8192, 20, 560.10', '1, GPU-aaa, RTX 2080, 8192, 4096, 10, 560.10'].join('\n'),
    )

    expect(resolveGpuSelection(devices, 'auto', 'GPU-bbb')?.index).toBe(0)
    expect(resolveGpuSelection(devices, { uuid: 'GPU-aaa' }, 'GPU-bbb')?.uuid).toBe('GPU-bbb')
    expect(resolveGpuSelection(devices, 'auto', 'GPU-removed')).toBeNull()
  })

  it('uses an explicit selection, else the recommended GPU', () => {
    const devices: GpuInventoryDevice[] = [
      { index: 0, uuid: 'a', name: 'a', computeCapability: { major: 7, minor: 5 } },
      { index: 1, uuid: 'b', name: 'b', computeCapability: { major: 8, minor: 9 } },
    ]
    expect(resolveGpuSelection(devices, { uuid: 'a' })?.uuid).toBe('a')
    expect(resolveGpuSelection(devices, { uuid: 'gone' })).toBeNull()
    expect(resolveGpuSelection(devices, 'auto')?.uuid).toBe('b')
    expect(resolveGpuSelection([{ index: 0, uuid: 'x', name: 'x' }], 'auto')).toBeNull()
  })
})
