import { describe, expect, it } from 'vitest'
import { describeEngineReadiness } from '@shared/engineReadiness'

describe('describeEngineReadiness', () => {
  it('does not contradict itself when ready and the last update failed', () => {
    expect(
      describeEngineReadiness({
        state: 'ready',
        path: 'moss-server',
        lastAttempt: { at: '2026-11-01T00:00:00.000Z', error: 'download failed' },
      }),
    ).toBe('MossInfer 已就绪 · 上次更新失败')
  })

  it('shows a rounded percentage while installing', () => {
    expect(
      describeEngineReadiness({
        state: 'missing',
        path: null,
        installing: { phase: 'downloading', percent: 42.4, version: 'v2.1.1' },
      }),
    ).toBe('正在安装 v2.1.1 · 42%')
    expect(
      describeEngineReadiness({ state: 'missing', path: null, installing: { phase: 'downloading', percent: 42.5, version: 'v2' } }),
    ).toBe('正在安装 v2 · 43%')
  })

  it('clamps the install percentage to 0–100', () => {
    const at = (percent: number) =>
      describeEngineReadiness({ state: 'missing', path: null, installing: { phase: 'extracting', percent, version: 'v1' } })
    expect(at(-12)).toBe('正在安装 v1 · 0%')
    expect(at(0)).toBe('正在安装 v1 · 0%')
    expect(at(100)).toBe('正在安装 v1 · 100%')
    expect(at(250)).toBe('正在安装 v1 · 100%')
  })

  it('names the engine when the install has no version yet', () => {
    expect(
      describeEngineReadiness({ state: 'missing', path: null, installing: { phase: 'querying', percent: 3 } }),
    ).toBe('正在安装 MossInfer · 3%')
  })

  it('reports installing even when an engine is already ready', () => {
    expect(
      describeEngineReadiness({
        state: 'ready',
        path: 'moss-server',
        installing: { phase: 'verifying', percent: 99, version: 'v3' },
        lastAttempt: { at: '2026-11-01T00:00:00.000Z', error: 'x' },
      }),
    ).toBe('正在安装 v3 · 99%')
  })

  it('shows plain ready without extra verification steps', () => {
    expect(describeEngineReadiness({ state: 'ready', path: 'moss-server' })).toBe('MossInfer 已就绪')
    expect(
      describeEngineReadiness({ state: 'ready', path: 'moss-server', lastAttempt: { at: '2026-11-01T00:00:00.000Z' } }),
    ).toBe('MossInfer 已就绪')
  })

  it('ignores a reason once the engine is ready', () => {
    expect(describeEngineReadiness({ state: 'ready', path: 'moss-server', reason: 'stale reason' })).toBe('MossInfer 已就绪')
  })

  it('offers a preparation action when missing, or the specific reason when known', () => {
    expect(describeEngineReadiness({ state: 'missing', path: null })).toMatch(/下载或选择自定义引擎目录/)
    expect(describeEngineReadiness({ state: 'missing', path: '/x', reason: '引擎文件已损坏' })).toBe('引擎文件已损坏')
  })
})
