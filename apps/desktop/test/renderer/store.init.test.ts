import { describe, expect, it, vi } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import {
  announcementFixture,
  downloadFixture,
  jobFixture,
  launchRowFixture,
  scenario,
  settingsFixture,
  diagnosticFixture,
  engineDownloadFixture,
  updateAvailableFixture,
  updateDownloadingFixture,
  updateReadyFixture,
  updaterStateFixture,
} from '../mocks/backend'
import { flush, loadStore } from '../helpers/renderer'

describe('store.init', () => {
  it('loads every slice from the backend and marks the store ready', async () => {
    const { backend, store } = await loadStore('ready')
    await store().init()

    const state = store()
    expect(state.ready).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
    expect(state.settings).toEqual(backend.state.settings)
    expect(state.catalog?.bundles.map((bundle) => bundle.id)).toContain('moss-sft')
    expect(state.devices).toEqual(backend.state.devices)
    expect(state.engineReadiness).toEqual(backend.state.engineReadiness)
    expect(state.env).toEqual(backend.state.env)
    expect(state.update).toEqual(backend.state.update)
    expect(backend.unhandled).toEqual([])
  })

  it('applies appearance: explicit theme, animation from settings, acrylic from the bridge', async () => {
    const { backend, store } = await loadStore(scenario('ready', { settings: settingsFixture({ theme: 'light', uiAnimation: 'off' }) }), {
      bridge: { acrylic: true },
    })
    await store().init()
    expect(backend.bridge.acrylic).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.uiAnimation).toBe('off')
    expect(document.documentElement.dataset.acrylic).toBe('true')
  })

  it('resolves the system theme from prefers-color-scheme', async () => {
    const { store } = await loadStore(scenario('ready', { settings: settingsFixture({ theme: 'system' }) }))
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-color-scheme: dark)',
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    )
    await store().init()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
  })

  it('selects the first running or starting job as the active job', async () => {
    const { store } = await loadStore(
      scenario('ready', {
        jobs: [
          jobFixture({ id: 'done', state: 'succeeded' }),
          jobFixture({ id: 'starting', state: 'starting' }),
          jobFixture({ id: 'running', state: 'running' }),
        ],
      }),
    )
    await store().init()
    expect(store().activeJobId).toBe('starting')
  })

  it('leaves activeJobId empty when no job is in flight', async () => {
    const { store } = await loadStore('jobFailure')
    await store().init()
    expect(store().jobs).toHaveLength(1)
    expect(store().activeJobId).toBeNull()
  })

  it('tolerates individual slice failures and keeps the rest', async () => {
    const { backend, store } = await loadStore('ready')
    backend.fail(Ipc.modelsCatalog)
    backend.fail(Ipc.jobList)
    backend.fail(Ipc.engineStatus)
    await store().init()
    expect(store().ready).toBe(true)
    expect(store().catalog).toBeNull()
    expect(store().jobs).toEqual([])
    expect(store().engineReadiness).toBeNull()
    expect(store().activeJobId).toBeNull()
    expect(store().devices).toHaveLength(1)
  })

  it('reports a settings failure as an error and does not subscribe to events', async () => {
    const { backend, store } = await loadStore('ready')
    backend.fail(Ipc.settingsGet, { message: '设置文件损坏' })
    await store().init()
    expect(store().ready).toBe(false)
    expect(store().loading).toBe(false)
    expect(store().error).toBe('设置文件损坏')
    expect(backend.listenerCount(Events.job)).toBe(0)
  })

  it('is idempotent and ignores a second call while the first is loading', async () => {
    const { backend, store } = await loadStore('ready')
    const held = backend.hold(Ipc.settingsGet)
    const first = store().init()
    const second = store().init()
    expect(store().loading).toBe(true)
    await held.release()
    await Promise.all([first, second])
    await store().init()
    expect(backend.callsTo(Ipc.settingsGet)).toHaveLength(1)
    expect(backend.listenerCount(Events.download)).toBe(1)
  })

  it('subscribes to each event channel exactly once', async () => {
    const { backend, store } = await loadStore('ready')
    await store().init()
    for (const event of [
      Events.download,
      Events.job,
      Events.jobLog,
      Events.diagnostic,
      Events.gpuTelemetry,
      Events.settingsChanged,
      Events.updateState,
      Events.mossInferDownload,
      Events.envProgress,
      Events.gitProgress,
      Events.runtimeLog,
    ]) {
      expect(backend.listenerCount(event), event).toBe(1)
    }
  })

  it('merges download events that arrive before the snapshot and drops canceled tasks', async () => {
    const { backend, store } = await loadStore(
      scenario('ready', {
        downloads: [
          downloadFixture({ id: 'model:a', targetId: 'a', state: 'running' }),
          downloadFixture({ id: 'model:b', targetId: 'b', state: 'running' }),
        ],
      }),
    )
    const held = backend.hold(Ipc.downloadsList)
    const pending = store().init()
    await held.called
    // Live progress for a task the snapshot already knows, a brand-new task, and a cancel.
    backend.emit(Events.download, downloadFixture({ id: 'model:a', targetId: 'a', state: 'running', bytes: 777 }))
    backend.emit(Events.download, downloadFixture({ id: 'model:c', targetId: 'c', state: 'queued' }))
    backend.emit(Events.download, downloadFixture({ id: 'model:b', targetId: 'b', state: 'canceled' }))
    await held.release()
    await pending

    const downloads = store().downloads
    expect(downloads.map((task) => task.id)).toEqual(['model:a', 'model:c'])
    expect(downloads[0]!.bytes).toBe(777)
  })

  it('schedules the queued launch rows of each device once', async () => {
    vi.useFakeTimers()
    try {
      const { useApp, store } = await loadStore(
        scenario('ready', {
          launchRows: [
            launchRowFixture({ id: 'r1', deviceId: 'cuda:0' }),
            launchRowFixture({ id: 'r2', deviceId: 'cuda:0' }),
            launchRowFixture({ id: 'r3', deviceId: 'cuda:1' }),
            launchRowFixture({ id: 'r4', deviceId: 'cuda:2', state: 'running' }),
          ],
        }),
      )
      const startNextQueued = vi.fn(async (_deviceId: string) => undefined)
      useApp.setState({ startNextQueued })
      await store().init()
      expect(startNextQueued).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(800)
      expect(startNextQueued.mock.calls.map(([deviceId]) => deviceId).sort()).toEqual(['cuda:0', 'cuda:1'])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('startup update announcement', () => {
    it('reads the update state (not a new check) and notifies about an available version', async () => {
      const { backend, store } = await loadStore('updateAvailable')
      await store().init()
      expect(backend.callsTo(Ipc.updateState)).toHaveLength(1)
      expect(backend.callsTo(Ipc.updateCheck)).toHaveLength(0)
      expect(store().updatePopoverOpen).toBe(false)
      expect(store().notifications).toHaveLength(1)
      expect(store().notifications[0]).toMatchObject({ tone: 'info', title: '发现新版本', read: false })
      expect(store().notifications[0]!.message).toContain('1.1.0')
    })

    it('surfaces at most three announcements with tone mapping and markdown stripped', async () => {
      const announcements = [
        announcementFixture({ id: 'a', level: 'critical', title: 'A' }),
        announcementFixture({ id: 'b', level: 'warning', title: 'B', body: '' }),
        announcementFixture({ id: 'c', level: 'info', title: 'C', body: `# Title\n\n> ${'x'.repeat(400)}` }),
        announcementFixture({ id: 'd', level: 'info', title: 'D' }),
      ]
      const { store } = await loadStore(scenario('ready', { update: updaterStateFixture({ announcements }) }))
      await store().init()
      const byTitle = Object.fromEntries(store().notifications.map((item) => [item.title, item]))
      expect(Object.keys(byTitle).sort()).toEqual(['A', 'B', 'C'])
      expect(byTitle['A']).toMatchObject({ tone: 'error', message: 'MossStudio 发布了新的 模型。' })
      expect(byTitle['B']).toMatchObject({ tone: 'warning', message: '打开通知面板查看公告详情。' })
      expect(byTitle['C']!.tone).toBe('info')
      expect(byTitle['C']!.message).toHaveLength(180)
      expect(byTitle['C']!.message.startsWith('Title x')).toBe(true)
    })

    it('does not repeat an announcement or version on later checks', async () => {
      const { backend, store } = await loadStore(
        scenario('updateAvailable', {
          update: updateAvailableFixture('1.1.0', { announcements: [announcementFixture()] }),
        }),
      )
      await store().init()
      expect(store().notifications).toHaveLength(2)
      await store().checkForUpdates()
      backend.emit(Events.updateState, backend.state.update)
      await flush()
      expect(store().notifications).toHaveLength(2)
    })
  })

  describe('events that arrive while the startup snapshots are in flight', () => {
    it('keeps an update event over the older update:state answer (a slow envScan holds every snapshot)', async () => {
      const { backend, store } = await loadStore(
        scenario('ready', { update: updateDownloadingFixture('1.0.4', 100, { phase: 'installing' }) }),
      )
      const env = backend.hold(Ipc.envScan)
      const starting = store().init()
      await env.called
      await flush()
      // main finished materializing while envScan was still probing the GPU
      backend.emit(Events.updateState, updateReadyFixture('1.0.4'))
      await env.release()
      await starting
      expect(store().update).toMatchObject({ phase: 'ready', pending: '1.0.4' })
      expect(store().notifications.map((item) => item.title)).toContain('更新已准备好')
    })

    it('still takes the snapshot when no event came in', async () => {
      const { backend, store } = await loadStore(scenario('ready', { update: updateReadyFixture('1.0.4') }))
      const env = backend.hold(Ipc.envScan)
      const starting = store().init()
      await env.called
      await env.release()
      await starting
      expect(store().update).toMatchObject({ phase: 'ready' })
    })

    it('keeps job, diagnostic and engine-download events over their snapshots', async () => {
      const { backend, store } = await loadStore(
        scenario('ready', {
          jobs: [jobFixture({ id: 'job-a', state: 'running' }), jobFixture({ id: 'job-b', state: 'queued' })],
          diagnostics: [diagnosticFixture({ id: 'diag-a', title: 'old' })],
          engineDownload: engineDownloadFixture({ phase: 'downloading', percent: 10 }),
        }),
      )
      const env = backend.hold(Ipc.envScan)
      const starting = store().init()
      await env.called
      await flush()
      backend.emit(Events.job, jobFixture({ id: 'job-a', state: 'succeeded', stage: 'ready' }))
      backend.emit(Events.diagnostic, diagnosticFixture({ id: 'diag-a', title: 'new' }))
      backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'downloading', percent: 80 }))
      await env.release()
      await starting
      expect(store().jobs.find((job) => job.id === 'job-a')!.state).toBe('succeeded')
      expect(store().jobs.find((job) => job.id === 'job-b')!.state).toBe('queued')
      expect(store().jobs).toHaveLength(2)
      expect(store().diagnostics.find((item) => item.id === 'diag-a')!.title).toBe('new')
      expect(store().mossInferDownload!.percent).toBe(80)
      expect(store().engineReadiness!.installing).toMatchObject({ percent: 80 })
      // job-a is done, so the active job is no longer it.
      expect(store().activeJobId).toBeNull()
    })
  })
})
