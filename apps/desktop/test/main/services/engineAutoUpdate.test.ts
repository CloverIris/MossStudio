import { describe, expect, it, vi } from 'vitest'
import {
  failureBackoffMs,
  hasActiveEngineJobs,
  runEngineAutoUpdate,
  stateAfterManualInstall,
  type EngineAutoUpdateDeps,
  type EngineAutoUpdateState,
  type InstallRequest,
} from '@main/services/engineAutoUpdate'
import { activateWhenAllowed } from '@main/lib/engineActivation'
import { engineDownloadFixture, jobFixture, settingsFixture } from '@test/mocks/backend/fixtures'
import type { JobRecord, MossInferRelease } from '@shared/types'

const release = (tag: string): MossInferRelease => ({ tag, name: tag, publishedAt: null, body: '', assets: [] })
const DAY = 24 * 60 * 60_000

function deps(patch: Partial<EngineAutoUpdateDeps> = {}, initial: EngineAutoUpdateState = {}) {
  let state = initial
  const install = vi.fn(async (_request: InstallRequest) => engineDownloadFixture({ phase: 'done' }))
  const value: EngineAutoUpdateDeps = {
    getSettings: () => settingsFixture({ engineAutoUpdate: true }),
    engineReady: async () => true,
    versions: () => [{ id: 'stable-v1.0.3-cu13-sm75-system-cuda', name: 'stable-v1.0.3-cu13-sm75-system-cuda', path: '/e/bin/moss-server', current: true, source: 'managed' }],
    releases: async () => [release('v1.1.0'), release('v1.0.3')],
    jobs: async () => [],
    downloadState: () => null,
    install,
    readState: () => state,
    writeState: (next) => { state = next },
    now: () => 10 * DAY,
    ...patch,
  }
  return { deps: value, install: (patch.install as typeof install | undefined) ?? install, state: () => state }
}

describe('runEngineAutoUpdate', () => {
  it('installs the newer release with the build options of the engine in use', async () => {
    const { deps: d, install } = deps()
    await expect(runEngineAutoUpdate(d)).resolves.toBe('updated')
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      packages: [{ kind: 'cuda', flavour: 'cu13', arch: 'sm75', runtime: 'system-cuda' }], releaseTag: 'v1.1.0',
    }))
  })

  it('keeps every installed package kind in use current, once each', async () => {
    const managed = (name: string) => ({ id: name, name, path: `/e/${name}`, current: true, source: 'managed' as const })
    const { deps: d, install } = deps({
      versions: () => [
        managed('stable-v1.0.3-cu13'),
        managed('stable-v1.0.3-cu12-sm70-system-cuda'),
        managed('stable-v1.0.3-vulkan'),
        managed('stable-v1.1.0-hip'),
        { id: 'stable-v1.0.2-cu13', name: 'stable-v1.0.2-cu13', path: '/old', current: false, source: 'managed' },
      ],
    })
    await expect(runEngineAutoUpdate(d)).resolves.toBe('updated')
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]![0].packages).toEqual([
      { kind: 'cuda', flavour: 'cu13', arch: 'standard', runtime: 'bundled' },
      { kind: 'cuda', flavour: 'cu12', arch: 'sm70', runtime: 'system-cuda' },
      { kind: 'vulkan' },
    ])
  })

  it('leaves a CI build in use alone but still updates the stable packages next to it', async () => {
    const { deps: d, install } = deps({
      versions: () => [
        { id: 'dev-run9-abcdef12-cu13', name: 'dev-run9-abcdef12-cu13', path: '/d', current: true, source: 'managed' },
        { id: 'stable-v1.0.3-vulkan', name: 'stable-v1.0.3-vulkan', path: '/v', current: true, source: 'managed' },
      ],
    })
    await expect(runEngineAutoUpdate(d)).resolves.toBe('updated')
    expect(install.mock.calls[0]![0].packages).toEqual([{ kind: 'vulkan' }])
  })

  it('does nothing when the setting is off, before Setup installed an engine, or for a custom engine', async () => {
    await expect(runEngineAutoUpdate(deps({ getSettings: () => settingsFixture({ engineAutoUpdate: false }) }).deps)).resolves.toBe('disabled')
    await expect(runEngineAutoUpdate(deps({ engineReady: async () => false }).deps)).resolves.toBe('not-installed')
    const custom = deps({ versions: () => [{ id: 'external:/x', name: 'x · 外部', path: '/x', current: true, source: 'external' }] })
    await expect(runEngineAutoUpdate(custom.deps)).resolves.toBe('unmanaged')
    expect(custom.install).not.toHaveBeenCalled()
  })

  it('reports current when no newer release exists', async () => {
    await expect(runEngineAutoUpdate(deps({ releases: async () => [release('v1.0.3')] }).deps)).resolves.toBe('current')
  })

  it('waits while jobs run or another install is in progress', async () => {
    await expect(runEngineAutoUpdate(deps({ jobs: async () => [jobFixture({ state: 'running' })] }).deps)).resolves.toBe('busy')
    await expect(runEngineAutoUpdate(deps({ downloadState: () => engineDownloadFixture({ phase: 'downloading' }) }).deps)).resolves.toBe('busy')
    // Training and remote jobs do not use the local engine.
    await expect(runEngineAutoUpdate(deps({ jobs: async () => [jobFixture({ state: 'running', kind: 'training' }), jobFixture({ state: 'running', hostId: 'ssh-gpu' })] }).deps)).resolves.toBe('updated')
  })

  it('does not switch engines under a job that started during the download', async () => {
    let jobs: JobRecord[] = []
    const switched = vi.fn(async () => '/new/bin/moss-server')
    const sleep = vi.fn(async () => { jobs = [jobFixture({ state: 'succeeded' })] })
    const install = vi.fn(async (request: InstallRequest) => {
      // Mid-download a job starts…
      jobs = [jobFixture({ state: 'running' })]
      // …so activation (what downloadMossInfer does with the gate) must wait for it.
      await activateWhenAllowed(switched, { ...request.activation, sleep })
      return engineDownloadFixture({ phase: 'done' })
    })
    const { deps: d } = deps({ jobs: async () => jobs, install })
    await expect(runEngineAutoUpdate(d)).resolves.toBe('updated')
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(switched).toHaveBeenCalledTimes(1)
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(switched.mock.invocationCallOrder[0]!)
  })

  it('skips a release the person pinned by rolling back', async () => {
    const pinned = deps({ versions: () => [{ id: 'stable-v1.0.3-cu13', name: 'stable-v1.0.3-cu13', path: '/e', current: true, source: 'managed' }] }, { pinnedTag: 'v1.0.3' })
    await expect(runEngineAutoUpdate(pinned.deps)).resolves.toBe('pinned')
    expect(pinned.install).not.toHaveBeenCalled()
  })

  it('backs off after a failed install instead of downloading again every check', async () => {
    let now = 10 * DAY
    const failing = deps({ install: vi.fn(async () => engineDownloadFixture({ phase: 'error', error: 'offline' })), now: () => now })
    await expect(runEngineAutoUpdate(failing.deps)).resolves.toBe('failed')
    expect(failing.state().failed).toEqual({ tag: 'v1.1.0', at: 10 * DAY, count: 1 })
    now += 6 * 60 * 60_000
    await expect(runEngineAutoUpdate(failing.deps)).resolves.toBe('backoff')
    now += DAY
    await expect(runEngineAutoUpdate(failing.deps)).resolves.toBe('failed')
    expect(failing.state().failed?.count).toBe(2)
    expect(failing.install).toHaveBeenCalledTimes(2)
  })

  it('tries a newer release right away even after an older one failed', async () => {
    const { deps: d, install, state } = deps({}, { failed: { tag: 'v1.0.9', at: 10 * DAY, count: 3 } })
    await expect(runEngineAutoUpdate(d)).resolves.toBe('updated')
    expect(install).toHaveBeenCalledTimes(1)
    expect(state().failed).toBeUndefined()
  })
})

describe('helpers', () => {
  it('grows the retry gap and caps it at a week', () => {
    expect(failureBackoffMs(1)).toBe(DAY)
    expect(failureBackoffMs(3)).toBe(4 * DAY)
    expect(failureBackoffMs(10)).toBe(7 * DAY)
  })

  it('counts only local engine jobs as active', () => {
    expect(hasActiveEngineJobs([jobFixture({ state: 'queued' })])).toBe(true)
    expect(hasActiveEngineJobs([jobFixture({ state: 'failed' })])).toBe(false)
  })

  it('pins a manual install of an older release and unpins otherwise', () => {
    expect(stateAfterManualInstall({}, 'v1.0.2', 'v1.1.0')).toEqual({ pinnedTag: 'v1.0.2' })
    expect(stateAfterManualInstall({ pinnedTag: 'v1.0.2' }, 'v1.1.0', 'v1.1.0')).toEqual({})
    expect(stateAfterManualInstall({ pinnedTag: 'v1.0.2', failed: { tag: 'v1.1.0', at: 0, count: 2 } }, undefined, null)).toEqual({})
    expect(stateAfterManualInstall({ pinnedTag: 'v1.0.2' }, 'v1.0.1', null)).toEqual({ pinnedTag: 'v1.0.2' })
  })
})
