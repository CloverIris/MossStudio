import { describe, expect, it } from 'vitest'
import { compareEngineTags, engineDisplayVersion, engineStampName, engineUpdateStatus, parseEngineStamp } from '@shared/engineUpdate'
import type { MossInferRelease } from '@shared/types'

const release = (tag: string): MossInferRelease => ({ tag, name: tag, publishedAt: null, body: '', assets: [] })

describe('parseEngineStamp', () => {
  it('reads a stable system-CUDA release folder', () => {
    expect(parseEngineStamp('stable-v1.0.3-cu13-system-cuda')).toEqual({
      channel: 'stable',
      tag: 'v1.0.3',
      packageId: 'cu13-system-cuda',
      package: { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'system-cuda' },
    })
  })

  it('reads SM75 and bundled builds and CI artifacts', () => {
    expect(parseEngineStamp('stable-v2.0.0-cu13-sm75')).toMatchObject({
      packageId: 'cu13-sm75',
      package: { arch: 'sm75', runtime: 'bundled' },
    })
    expect(parseEngineStamp('dev-run42-abcdef12-cu12-system-cuda')).toMatchObject({
      channel: 'dev',
      tag: 'run42-abcdef12',
      package: { flavour: 'cu12' },
    })
  })

  it('reads the SM70, Vulkan and HIP packages of v2.2', () => {
    expect(parseEngineStamp('stable-v2.2.0-cu12-sm70-system-cuda')).toMatchObject({ tag: 'v2.2.0', packageId: 'cu12-sm70-system-cuda' })
    expect(parseEngineStamp('stable-v2.2.0-vulkan')).toMatchObject({ tag: 'v2.2.0', package: { kind: 'vulkan' } })
    expect(parseEngineStamp('dev-run7-0123abcd-hip')).toMatchObject({ channel: 'dev', tag: 'run7-0123abcd', package: { kind: 'hip' } })
    expect(engineStampName('stable', 'v2.2.0', { kind: 'cuda', flavour: 'cu13', arch: 'sm75', runtime: 'system-cuda' })).toBe(
      'stable-v2.2.0-cu13-sm75-system-cuda',
    )
  })

  it('returns null for folders it did not write', () => {
    expect(parseEngineStamp('my-engine')).toBeNull()
    expect(parseEngineStamp('v2.1.1')).toBeNull()
  })
})

describe('compareEngineTags', () => {
  it('compares numerically, not as text', () => {
    expect(compareEngineTags('v1.10.0', 'v1.9.3')).toBeGreaterThan(0)
    expect(compareEngineTags('v1.0.3', 'v1.0.3')).toBe(0)
    expect(compareEngineTags('v1.0', 'v1.0.1')).toBeLessThan(0)
  })

  it('treats tags without numbers as equal', () => {
    expect(compareEngineTags('latest', 'v1.0.0')).toBe(0)
  })
})

describe('engineDisplayVersion', () => {
  it('shows the release number without the v', () => {
    expect(engineDisplayVersion({ name: 'stable-v1.0.3-cu13', source: 'managed' })).toBe('1.0.3')
    expect(engineDisplayVersion({ name: 'dev-run7-1234abcd-cu13', source: 'managed' })).toBe('开发版 run7-1234abcd')
    expect(engineDisplayVersion({ name: 'custom · 外部', source: 'external' })).toBe('custom · 外部')
    expect(engineDisplayVersion(null)).toBeNull()
  })
})

describe('engineUpdateStatus', () => {
  const current = { name: 'stable-v1.0.3-cu13-system-cuda', source: 'managed' as const }

  it('offers the newest release when it is newer', () => {
    const status = engineUpdateStatus(current, [release('v1.0.2'), release('v1.1.0'), release('v1.0.3')])
    expect(status).toMatchObject({ kind: 'available', tag: 'v1.0.3', latest: { tag: 'v1.1.0' } })
  })

  it('is current when nothing newer exists', () => {
    expect(engineUpdateStatus(current, [release('v1.0.3')])).toEqual({ kind: 'current', tag: 'v1.0.3' })
    expect(engineUpdateStatus(current, [])).toEqual({ kind: 'current', tag: 'v1.0.3' })
  })

  it('leaves custom engines and CI builds alone', () => {
    expect(engineUpdateStatus({ name: 'x · 外部', source: 'external' }, [release('v9.0.0')]).kind).toBe('unmanaged')
    expect(engineUpdateStatus({ name: 'dev-run1-aaaaaaaa-cu13', source: 'managed' }, [release('v9.0.0')]).kind).toBe('unmanaged')
  })

  it('reports a missing engine', () => {
    expect(engineUpdateStatus(null, [release('v1.0.0')]).kind).toBe('not-installed')
  })
})
