import { describe, expect, it } from 'vitest'
import { engineDownloadActive, engineDownloadLabel, engineDownloadPercent, engineInstallError, planEngineInstall } from '@renderer/lib/engineInstall'
import { engineDownloadFixture, engineMissingFixture, engineReadyFixture } from '@test/mocks/backend/fixtures'

describe('planEngineInstall', () => {
  it('uses the small system-CUDA package when CUDA is already there', () => {
    expect(planEngineInstall({ supported: true, gpu: 'RTX', cublasLt: ['x'], driverCompatible: true }))
      .toEqual({ kind: 'install', channel: 'stable', architecture: 'auto', variant: 'system-cuda' })
  })

  it('falls back to the self-contained package without asking', () => {
    expect(planEngineInstall({ supported: false, gpu: 'RTX', cublasLt: [] })).toMatchObject({ kind: 'install', variant: 'bundled' })
    expect(planEngineInstall(null)).toMatchObject({ kind: 'install', variant: 'bundled' })
  })

  it('explains an outdated driver instead of installing', () => {
    const plan = planEngineInstall({ supported: false, gpu: 'RTX', cublasLt: [], driverCompatible: false, driverVersion: '531.0' })
    expect(plan.kind).toBe('driver')
    expect(plan.kind === 'driver' && plan.message).toMatch(/531\.0/)
  })
})

describe('engine download display', () => {
  it('knows when an install is running', () => {
    expect(engineDownloadActive(null)).toBe(false)
    expect(engineDownloadActive(engineDownloadFixture({ phase: 'extracting' }))).toBe(true)
    expect(engineDownloadActive(engineDownloadFixture({ phase: 'error' }))).toBe(false)
  })

  it('labels progress in plain words', () => {
    expect(engineDownloadLabel(engineDownloadFixture({ bytes: 100 * 1024 ** 2, totalBytes: 300 * 1024 ** 2 }))).toBe('正在下载 100 MB / 300 MB')
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'querying' }))).toBe('正在查找最新版本')
  })

  it('has a percent only while bytes are measurable', () => {
    expect(engineDownloadPercent(engineDownloadFixture({ percent: 42 }))).toBe(42)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'extracting' }))).toBeNull()
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'done' }))).toBe(100)
  })

  it('reports install errors unless the engine still works', () => {
    expect(engineInstallError(engineMissingFixture(), engineDownloadFixture({ phase: 'error', error: '网络中断' }))).toBe('网络中断')
    expect(engineInstallError(engineMissingFixture({ lastAttempt: { at: '', error: '校验失败' } }), null)).toBe('校验失败')
    expect(engineInstallError(engineReadyFixture({ lastAttempt: { at: '', error: '校验失败' } }), null)).toBeNull()
  })
})
