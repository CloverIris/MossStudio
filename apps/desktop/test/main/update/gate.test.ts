import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requiredUpdateMessage } from '@shared/update'
import { useTempDataRoot } from '@test/helpers/tempDir'

const startEngineJob = vi.hoisted(() => vi.fn())
const resolveCanvasAdapters = vi.hoisted(() => vi.fn())
vi.mock('@main/services/supervisor', () => ({ startEngineJob }))
vi.mock('@main/services/engineFeatures', () => ({ getEngineFeatures: vi.fn() }))
vi.mock('@main/services/adapterResolution', () => ({ resolveCanvasAdapters }))

useTempDataRoot()

beforeEach(() => {
  vi.resetModules()
  startEngineJob.mockReset().mockResolvedValue({ id: 'job-1' })
  resolveCanvasAdapters.mockReset().mockResolvedValue([])
})

const request = { prompt: 'a cat', width: 1024, height: 1024, steps: 20, cfg: 4, seed: 1 }

describe('minimumVersion gate in the job start path', () => {
  it('refuses to start a generation while an update is required, before anything is queued', async () => {
    const gate = await import('@main/update/gate')
    const { startRequestedEngineJob } = await import('@main/services/engineJobStart')
    gate.setMinimumVersion('1.1.0', '1.0.3')
    expect(gate.updateRequired()).toEqual({ required: true, minimumVersion: '1.1.0' })
    await expect(startRequestedEngineJob(request)).rejects.toMatchObject({
      code: 'E_UPDATE_REQUIRED',
      message: requiredUpdateMessage('1.1.0'),
    })
    expect(startEngineJob).not.toHaveBeenCalled()
  })

  it('starts normally once the running version meets the minimum, or without one', async () => {
    const gate = await import('@main/update/gate')
    const { startRequestedEngineJob } = await import('@main/services/engineJobStart')
    gate.setMinimumVersion('1.0.3', '1.0.3')
    await startRequestedEngineJob(request)
    gate.setMinimumVersion(null, '1.0.3')
    await startRequestedEngineJob(request)
    gate.setMinimumVersion('1.1.0-beta.1', '1.1.0')
    await startRequestedEngineJob(request)
    expect(startEngineJob).toHaveBeenCalledTimes(3)
  })

  it('treats a prerelease of the minimum as too old', async () => {
    const gate = await import('@main/update/gate')
    gate.setMinimumVersion('1.1.0', '1.1.0-rc.1')
    expect(() => gate.assertGenerationAllowed()).toThrow('必须更新')
  })
})
