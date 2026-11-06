import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

const resolveServerPath = vi.hoisted(() => vi.fn<(settings: Settings) => string | null>())
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath }))

const dataRoot = useTempDataRoot()
let readiness: typeof import('@main/services/engineReadiness')
let store: typeof import('@main/lib/engineStore')

beforeEach(async () => {
  vi.resetModules()
  resolveServerPath.mockReset().mockReturnValue(null)
  readiness = await import('@main/services/engineReadiness')
  store = await import('@main/lib/engineStore')
})

function server(): string {
  const path = join(dataRoot(), 'mossinfer', 'v1', 'bin', 'moss-server')
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!')
  return path
}

describe('engineReadiness', () => {
  it('reports missing when no server resolves or the resolved path is gone', async () => {
    expect(await readiness.engineReadiness()).toEqual({
      state: 'missing',
      path: null,
      reason: '未找到 moss-server；请下载引擎或设置路径',
      devices: [],
      installing: undefined,
      lastAttempt: undefined,
    })
    resolveServerPath.mockReturnValue(join(dataRoot(), 'nope'))
    readiness.invalidateEngineReadiness()
    expect((await readiness.engineReadiness()).state).toBe('missing')
  })

  it('reports ready with the resolved path', async () => {
    const path = server()
    resolveServerPath.mockReturnValue(path)
    expect(await readiness.engineReadiness()).toMatchObject({ state: 'ready', path })
  })

  it('recomputes when the binary appears or disappears', async () => {
    const path = join(dataRoot(), 'mossinfer', 'v1', 'bin', 'moss-server')
    resolveServerPath.mockReturnValue(path)
    expect((await readiness.engineReadiness()).state).toBe('missing')
    server()
    expect((await readiness.engineReadiness()).state).toBe('ready')
    rmSync(path)
    expect((await readiness.engineReadiness()).state).toBe('missing')
  })

  it('reuses the cached result for the same binary within 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const path = server()
      resolveServerPath.mockReturnValue(path)
      await readiness.engineReadiness()
      const calls = resolveServerPath.mock.calls.length
      await readiness.engineReadiness()
      // The fingerprint lookup resolves once per call; the full calculation is skipped.
      expect(resolveServerPath.mock.calls.length).toBe(calls + 1)
      vi.advanceTimersByTime(30_001)
      await readiness.engineReadiness()
      expect(resolveServerPath.mock.calls.length).toBe(calls + 3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('always reports live install progress and the last attempt', async () => {
    store.setEngineInstallProgress({ phase: 'downloading', percent: 40, version: 'v2' })
    store.writeEngineLastAttempt(join(dataRoot(), 'mossinfer'), { at: '2026-01-01T00:00:00Z', error: 'boom' })
    const first = await readiness.engineReadiness()
    expect(first.installing).toEqual({ phase: 'downloading', percent: 40, version: 'v2' })
    expect(first.lastAttempt).toEqual({ at: '2026-01-01T00:00:00Z', error: 'boom' })
    store.setEngineInstallProgress(null)
    expect((await readiness.engineReadiness()).installing).toBeUndefined()
  })
})
