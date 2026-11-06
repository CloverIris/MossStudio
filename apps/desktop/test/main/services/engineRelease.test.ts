import { describe, expect, it, vi } from 'vitest'

const releaseStaleMossInferRuntimes = vi.hoisted(() => vi.fn(async () => [] as string[]))
vi.mock('@main/services/mossInfer', () => ({ resolveServerPath: () => null, releaseStaleMossInferRuntimes }))

const { releaseAfterSettingsChange } = await import('@main/services/engineInstalls')

describe('settings update → release stale moss-servers (ipc settings:update calls this)', () => {
  it('switching a GPU to another engine frees its old moss-server at once', () => {
    expect(
      releaseAfterSettingsChange(
        { engineDeviceOverrides: {}, mossInferServerPath: null },
        { engineDeviceOverrides: { 'GPU-a': 'vulkan' }, mossInferServerPath: null },
      ),
    ).toBe(true)
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledTimes(1)
    expect(releaseStaleMossInferRuntimes).toHaveBeenCalledWith()
  })

  it('an unrelated settings change releases nothing', () => {
    releaseStaleMossInferRuntimes.mockClear()
    const same = { engineDeviceOverrides: { 'GPU-a': 'cu13' }, mossInferServerPath: '/e/bin/moss-server' }
    expect(releaseAfterSettingsChange(same, { ...same })).toBe(false)
    expect(releaseStaleMossInferRuntimes).not.toHaveBeenCalled()
  })
})
