import { describe, expect, it } from 'vitest'
import {
  engineDownloadActive,
  engineDownloadLabel,
  engineDownloadPercent,
  engineInstallError,
  planEngineInstall,
  type SystemCudaCheck,
} from '@renderer/lib/engineInstall'
import type { MossInferDownloadState } from '@shared/types'
import { engineDownloadFixture, engineMissingFixture, engineReadyFixture } from '../../mocks/backend'

const cuda = (patch: Partial<SystemCudaCheck> = {}): SystemCudaCheck => ({ supported: true, gpu: 'RTX 4090', cublasLt: ['cublasLt64_13.dll'], ...patch })

describe('lib/engineInstall planEngineInstall', () => {
  it('uses the small system-CUDA package when CUDA is present', () => {
    expect(planEngineInstall(cuda())).toEqual({ kind: 'install', channel: 'stable', architecture: 'auto', variant: 'system-cuda' })
  })

  it('falls back to the bundled package when CUDA is missing or unknown', () => {
    expect(planEngineInstall(cuda({ supported: false }))).toMatchObject({ kind: 'install', variant: 'bundled' })
    expect(planEngineInstall(null)).toMatchObject({ kind: 'install', variant: 'bundled' })
  })

  it('asks for a driver update when the driver is too old, naming the version when known', () => {
    expect(planEngineInstall(cuda({ driverCompatible: false, driverVersion: '531.18' }))).toEqual({
      kind: 'driver', message: '显卡驱动版本过旧（当前 531.18）。请先到 NVIDIA 官网更新显卡驱动，然后重试。',
    })
    expect(planEngineInstall(cuda({ driverCompatible: false }))).toEqual({
      kind: 'driver', message: '显卡驱动版本过旧。请先到 NVIDIA 官网更新显卡驱动，然后重试。',
    })
    expect(planEngineInstall(cuda({ driverCompatible: true }))).toMatchObject({ kind: 'install' })
  })
})

describe('lib/engineInstall progress helpers', () => {
  const phases: Array<MossInferDownloadState['phase']> = ['querying', 'downloading', 'verifying', 'extracting', 'cuda_libs', 'done', 'error', 'canceled']

  it('only non-terminal phases are active', () => {
    expect(phases.filter((phase) => engineDownloadActive(engineDownloadFixture({ phase })))).toEqual(['querying', 'downloading', 'verifying', 'extracting', 'cuda_libs'])
    expect(engineDownloadActive(null)).toBe(false)
    expect(engineDownloadActive(undefined)).toBe(false)
  })

  it('labels downloads with byte progress and other phases with their name', () => {
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'downloading', bytes: 186 * 1024 ** 2, totalBytes: 290 * 1024 ** 2 }))).toBe('正在下载 186 MB / 290 MB')
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'downloading', totalBytes: 0 }))).toBe('正在下载')
    expect(engineDownloadLabel(engineDownloadFixture({ phase: 'cuda_libs' }))).toBe('正在准备运行库')
    expect(new Set(phases.map((phase) => engineDownloadLabel(engineDownloadFixture({ phase, totalBytes: 0 })))).size).toBe(phases.length)
  })

  it('reports a measurable percent only while downloading, clamped to 0..100', () => {
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: 42 }))).toBe(42)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: 140 }))).toBe(100)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', percent: -3 }))).toBe(0)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'downloading', totalBytes: 0, percent: 50 }))).toBeNull()
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'done', percent: 0 }))).toBe(100)
    expect(engineDownloadPercent(engineDownloadFixture({ phase: 'verifying', percent: 80 }))).toBeNull()
  })

  it('engineInstallError prefers the live download error, then a failed attempt on a missing engine', () => {
    const attempt = { at: '', error: '下载连接中断' }
    expect(engineInstallError(engineReadyFixture(), engineDownloadFixture({ phase: 'error', error: 'boom' }))).toBe('boom')
    expect(engineInstallError(null, engineDownloadFixture({ phase: 'error' }))).toBe('引擎安装失败')
    expect(engineInstallError(engineMissingFixture({ lastAttempt: attempt }), null)).toBe('下载连接中断')
    expect(engineInstallError(engineReadyFixture({ lastAttempt: attempt }), null)).toBeNull()
    expect(engineInstallError(engineMissingFixture(), engineDownloadFixture({ phase: 'downloading' }))).toBeNull()
    expect(engineInstallError(undefined, undefined)).toBeNull()
  })
})
