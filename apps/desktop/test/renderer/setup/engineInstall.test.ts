import { describe, expect, it } from 'vitest'
import { engineDownloadActive, engineDownloadLabel, engineDownloadPercent, engineInstallError } from '@renderer/lib/engineInstall'
import { engineDownloadFixture, engineMissingFixture, engineReadyFixture } from '@test/mocks/backend/fixtures'

describe('engine download display', () => {
  it('knows when an install is running', () => {
    expect(engineDownloadActive(null)).toBe(false)
    expect(engineDownloadActive(engineDownloadFixture({ phase: 'extracting' }))).toBe(true)
    expect(engineDownloadActive(engineDownloadFixture({ phase: 'error' }))).toBe(false)
  })

  it('labels progress in plain words', () => {
    expect(engineDownloadLabel(engineDownloadFixture({ bytes: 100 * 1024 ** 2, totalBytes: 300 * 1024 ** 2 }))).toBe(
      '正在下载 100 MB / 300 MB',
    )
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
