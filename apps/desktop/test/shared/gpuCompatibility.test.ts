import { describe, expect, it, vi } from 'vitest'
import type { EngineDevice } from '@shared/engineProtocol'
import { mapEngineGpuProbe } from '@shared/gpuCompatibility'
import type { GpuInventoryDevice } from '@shared/types'

const candidate = (overrides: Partial<EngineDevice>): EngineDevice => ({
  index: null,
  name: '',
  supported: null,
  compute: null,
  raw: {},
  ...overrides,
})

const inventory: GpuInventoryDevice[] = [
  { uuid: 'a', index: 0, name: 'GPU A', driverVersion: '581.15' },
  { uuid: 'b', index: 1, name: 'GPU B', driverVersion: '560.10' },
  { uuid: 'c', index: 2, name: 'GPU C' },
]

describe('mapEngineGpuProbe', () => {
  it('maps supported and unsupported devices by index and name', () => {
    const result = mapEngineGpuProbe(
      inventory,
      [
        candidate({ index: 0, name: 'GPU A', supported: true, freeMemoryBytes: 123 }),
        candidate({ index: 1, name: 'GPU B', supported: false, unsupportedReason: 'unsupported SM' }),
      ],
      'moss-server',
      '2.1.1',
      '2026-11-01T00:00:00.000Z',
    )
    expect(result.devices.map(({ uuid, status }) => [uuid, status])).toEqual([
      ['a', 'supported'],
      ['b', 'unsupported'],
      ['c', 'unknown'],
    ])
    expect(result.devices[0]).toEqual({ ...inventory[0], status: 'supported', reason: undefined, freeMemoryBytes: 123 })
    expect(result.devices[1]?.reason).toBe('unsupported SM')
    expect(result.devices[2]?.reason).toBe('引擎 probe 未返回可唯一匹配的 GPU 结果')
    expect(result.enginePath).toBe('moss-server')
    expect(result.engineVersion).toBe('2.1.1')
    expect(result.checkedAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('maps a missing supported verdict to unknown', () => {
    const result = mapEngineGpuProbe([inventory[0]!], [candidate({ index: 0, name: 'GPU A', supported: null })], 'x')
    expect(result.devices[0]?.status).toBe('unknown')
  })

  it('does not guess between GPUs that share a name', () => {
    const result = mapEngineGpuProbe(
      [
        { uuid: 'a', index: 0, name: 'Same GPU' },
        { uuid: 'b', index: 1, name: 'Same GPU' },
      ],
      [candidate({ name: 'Same GPU', index: null, supported: true })],
      'moss-server',
    )
    expect(result.devices.map((device) => device.status)).toEqual(['unknown', 'unknown'])
  })

  it('accepts a name match with a different index when the inventory name is unique', () => {
    const result = mapEngineGpuProbe(
      [{ uuid: 'a', index: 0, name: 'Only GPU' }],
      [candidate({ index: 4, name: 'only   gpu', supported: true })],
      'moss-server',
    )
    expect(result.devices[0]?.status).toBe('supported')
  })

  it('rejects a name match with a different index when the inventory has a twin', () => {
    // Engine reports only one of two identical cards, under a different index.
    const result = mapEngineGpuProbe(
      [
        { uuid: 'a', index: 0, name: 'Twin' },
        { uuid: 'b', index: 1, name: 'Twin' },
      ],
      [candidate({ index: 5, name: 'Twin', supported: true })],
      'moss-server',
    )
    expect(result.devices.map((device) => device.status)).toEqual(['unknown', 'unknown'])
  })

  it('still matches twins whose indexes agree', () => {
    const result = mapEngineGpuProbe(
      [
        { uuid: 'a', index: 0, name: 'Twin' },
        { uuid: 'b', index: 1, name: 'Twin' },
      ],
      [candidate({ index: 0, name: 'Twin', supported: true }), candidate({ index: 1, name: 'Twin', supported: false })],
      'moss-server',
    )
    expect(result.devices.map((device) => device.status)).toEqual(['supported', 'unsupported'])
  })

  it('adds a CUDA 13 driver hint to driver initialisation errors', () => {
    const result = mapEngineGpuProbe(
      [inventory[1]!],
      [candidate({ index: 1, name: 'GPU B', supported: false, unsupportedReason: 'no Nvidia driver is loader' })],
      'moss-server',
    )
    const reason = result.devices[0]?.reason ?? ''
    expect(reason.startsWith('no Nvidia driver is loader。')).toBe(true)
    expect(reason).toMatch(/系统检测到 NVIDIA 驱动 560\.10/)
    expect(reason).toMatch(/R580/)
    expect(reason).not.toMatch(/CUDA 12/)
  })

  it('recognises the other driver failure phrasings', () => {
    for (const message of [
      'CUDA driver version is insufficient for CUDA runtime version',
      'NVIDIA driver not loaded',
      'nvidia driver unavailable',
      'cuda driver too old',
    ]) {
      const result = mapEngineGpuProbe(
        [inventory[2]!],
        [candidate({ index: 2, name: 'GPU C', supported: false, unsupportedReason: message })],
        'moss-server',
      )
      const reason = result.devices[0]?.reason ?? ''
      expect(reason.startsWith(`${message}。`)).toBe(true)
      // No driver version in inventory: the hint falls back to the enumeration wording.
      expect(reason).toContain('系统能枚举到这张 NVIDIA GPU')
    }
  })

  it('leaves unrelated reasons untouched', () => {
    const result = mapEngineGpuProbe(
      [inventory[0]!],
      [candidate({ index: 0, name: 'GPU A', supported: false, unsupportedReason: 'no kernel image is available' })],
      'moss-server',
    )
    expect(result.devices[0]?.reason).toBe('no kernel image is available')
  })

  it('handles an empty inventory and stamps the current time by default', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))
      const result = mapEngineGpuProbe([], [candidate({ index: 0, name: 'GPU', supported: true })], '/engine')
      expect(result).toEqual({ enginePath: '/engine', engineVersion: undefined, checkedAt: '2026-11-04T12:00:00.000Z', devices: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mutate the inventory', () => {
    const copy = structuredClone(inventory)
    mapEngineGpuProbe(inventory, [candidate({ index: 0, name: 'GPU A', supported: true })], 'x')
    expect(inventory).toEqual(copy)
  })
})
