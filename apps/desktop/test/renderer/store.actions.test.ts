import { describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import {
  SFT_BUNDLE_IDS,
  catalogFixture,
  diagnosticFixture,
  downloadFixture,
  engineDownloadFixture,
  engineMissingFixture,
  engineReadyFixture,
  envReportFixture,
  jobFixture,
  jobLogFixture,
  launchDeviceFixture,
  launchRowFixture,
  scenario,
  localAdapterFixture,
  updateAvailableFixture,
  updateReadyFixture,
  updaterStateFixture,
} from '../mocks/backend'
import { flush, loadStore } from '../helpers/renderer'

async function ready(...args: Parameters<typeof loadStore>) {
  const loaded = await loadStore(...args)
  await loaded.store().init()
  loaded.backend.calls.length = 0
  loaded.useApp.setState({ notifications: [] })
  return loaded
}

describe('settings', () => {
  it('saveSettings sends only the patch, stores the answer and re-reads engine readiness', async () => {
    const { backend, store } = await ready()
    backend.state.engineReadiness = engineMissingFixture()
    await store().saveSettings({ uiAnimation: 'off', hfToken: 'hf_secret' })
    expect(backend.callsTo(Ipc.settingsUpdate)).toEqual([{ uiAnimation: 'off', hfToken: 'hf_secret' }])
    expect(store().settings).toMatchObject({ uiAnimation: 'off', hasHfToken: true })
    expect(document.documentElement.dataset.uiAnimation).toBe('off')
    await flush()
    expect(store().engineReadiness).toEqual(engineMissingFixture())
  })

  it('saveSettings rejects and keeps the old settings when the write fails', async () => {
    const { backend, store } = await ready()
    const before = store().settings
    backend.fail(Ipc.settingsUpdate, { code: 'E_WRITE', message: 'disk full' })
    await expect(store().saveSettings({ sidebarCollapsed: true })).rejects.toMatchObject({ code: 'E_WRITE', message: 'disk full' })
    expect(store().settings).toBe(before)
  })

  it('toggleSidebar flips the persisted flag and is a no-op before settings load', async () => {
    const { backend, store, useApp } = await ready()
    await store().toggleSidebar()
    expect(store().settings!.sidebarCollapsed).toBe(true)
    await store().toggleSidebar()
    expect(backend.callsTo(Ipc.settingsUpdate)).toEqual([{ sidebarCollapsed: true }, { sidebarCollapsed: false }])
    useApp.setState({ settings: null })
    await store().toggleSidebar()
    expect(backend.callsTo(Ipc.settingsUpdate)).toHaveLength(2)
  })
})

describe('notifications', () => {
  it('pushes unread notifications newest first with unique ids and timestamps', async () => {
    const { store } = await ready()
    store().pushNotification({ tone: 'info', title: 'one', message: '1' })
    store().pushNotification({ tone: 'error', title: 'two', message: '2' })
    const [latest, earlier] = store().notifications
    expect(latest).toMatchObject({ title: 'two', tone: 'error', read: false })
    expect(earlier!.title).toBe('one')
    expect(latest!.id).not.toBe(earlier!.id)
    expect(Number.isNaN(Date.parse(latest!.createdAt))).toBe(false)
  })

  it('keeps only the 50 most recent notifications', async () => {
    const { store } = await ready()
    for (let index = 0; index < 55; index += 1) store().pushNotification({ tone: 'info', title: `n${index}`, message: '' })
    expect(store().notifications).toHaveLength(50)
    expect(store().notifications[0]!.title).toBe('n54')
    expect(store().notifications.at(-1)!.title).toBe('n5')
  })

  it('marks everything read and toggles the panel', async () => {
    const { store } = await ready()
    store().pushNotification({ tone: 'info', title: 'a', message: '' })
    store().pushNotification({ tone: 'info', title: 'b', message: '' })
    store().markAllNotificationsRead()
    expect(store().notifications.every((item) => item.read)).toBe(true)
    store().toggleNotifications()
    expect(store().notificationsOpen).toBe(true)
    store().toggleNotifications()
    expect(store().notificationsOpen).toBe(false)
    store().setNotificationsOpen(true)
    expect(store().notificationsOpen).toBe(true)
  })
})

describe('environment and catalog refresh', () => {
  it('refreshEnv flags scanning while the scan runs', async () => {
    const { backend, store } = await ready()
    const next = envReportFixture({ scannedAt: '2026-11-03T00:00:00.000Z' })
    const held = backend.hold(Ipc.envScan)
    const pending = store().refreshEnv()
    expect(store()).toMatchObject({ scanning: true, scanSection: 'system' })
    await held.release(next)
    await pending
    expect(store()).toMatchObject({ scanning: false, scanSection: null, env: next })
  })

  it('refreshEnv records a failure and still clears the scanning flag', async () => {
    const { backend, store } = await ready()
    backend.fail(Ipc.envScan, { message: 'scan crashed' })
    await store().refreshEnv()
    expect(store()).toMatchObject({ scanning: false, scanSection: null, error: 'scan crashed' })
  })

  it.each([
    ['refreshCatalog', Ipc.modelsCatalog, 'catalog'],
    ['refreshUpdate', Ipc.updateState, 'update'],
    ['refreshJobs', Ipc.jobList, 'jobs'],
    ['refreshDiagnostics', Ipc.diagnosticsList, 'diagnostics'],
    ['refreshDevices', Ipc.devicesList, 'devices'],
  ] as const)('%s keeps the previous value when the backend fails', async (action, channel, key) => {
    const { backend, store } = await ready('jobFailure')
    const before = store()[key]
    backend.fail(channel)
    await store()[action]()
    expect(store()[key]).toBe(before)
    expect(store().error).toBeNull()
  })

  it('refreshes catalog, jobs, diagnostics and devices from the backend', async () => {
    const { backend, store } = await ready()
    backend.state.catalog = catalogFixture()
    backend.state.jobs = [jobFixture({ id: 'fresh' })]
    backend.state.diagnostics = [diagnosticFixture({ id: 'fresh' })]
    backend.state.devices = [launchDeviceFixture({ id: 'cuda:1' })]
    await Promise.all([store().refreshCatalog(), store().refreshJobs(), store().refreshDiagnostics(), store().refreshDevices()])
    expect(store().catalog!.models.every((model) => !model.installed)).toBe(true)
    expect(store().jobs.map((job) => job.id)).toEqual(['fresh'])
    expect(store().diagnostics.map((item) => item.id)).toEqual(['fresh'])
    expect(store().devices.map((device) => device.id)).toEqual(['cuda:1'])
  })

  it('refreshEngineReadiness returns the fresh value, or the cached one on failure', async () => {
    const { backend, store } = await ready()
    backend.state.engineReadiness = engineMissingFixture()
    expect(await store().refreshEngineReadiness()).toEqual(engineMissingFixture())
    backend.fail(Ipc.engineStatus)
    expect(await store().refreshEngineReadiness()).toEqual(engineMissingFixture())
  })

  it('setMossInferDownload derives installing progress and clears it for terminal phases', async () => {
    const { store } = await ready()
    store().setMossInferDownload(engineDownloadFixture({ phase: 'extracting', percent: 90, version: 'v3' }))
    expect(store().engineReadiness!.installing).toEqual({ phase: 'extracting', percent: 90, version: 'v3' })
    for (const phase of ['done', 'error', 'canceled'] as const) {
      store().setMossInferDownload(engineDownloadFixture({ phase }))
      expect(store().engineReadiness!.installing, phase).toBeUndefined()
    }
    store().setMossInferDownload(null)
    expect(store().mossInferDownload).toBeNull()
    expect(store().engineReadiness).toEqual({ ...engineReadyFixture(), installing: undefined })
  })

  it('setMossInferDownload leaves readiness null when it was never loaded', async () => {
    const { backend, store } = await loadStore('ready')
    backend.fail(Ipc.engineStatus)
    await store().init()
    store().setMossInferDownload(engineDownloadFixture())
    expect(store().engineReadiness).toBeNull()
    expect(store().mossInferDownload!.phase).toBe('downloading')
  })
})

describe('updates', () => {
  it('checkForUpdates stores and announces, returning the state', async () => {
    const { backend, store } = await ready()
    backend.state.update = updateAvailableFixture('1.2.0')
    const result = await store().checkForUpdates()
    expect(result!.available!.version).toBe('1.2.0')
    expect(store().update!.phase).toBe('available')
    expect(store().notifications).toMatchObject([{ title: '发现新版本', message: expect.stringContaining('1.2.0') }])
    // The same version again stays quiet.
    await store().checkForUpdates()
    expect(store().notifications).toHaveLength(1)
  })

  it('checkForUpdates returns null and keeps state on failure', async () => {
    const { backend, store } = await ready()
    const before = store().update
    backend.fail(Ipc.updateCheck)
    expect(await store().checkForUpdates()).toBeNull()
    expect(store().update).toBe(before)
  })

  it('downloadUpdate and cancelUpdateDownload store what main answers', async () => {
    const { backend, store } = await ready('updateAvailable')
    await store().downloadUpdate()
    expect(backend.callsTo(Ipc.updateDownload)).toEqual([undefined])
    expect(store().update).toMatchObject({ phase: 'downloading', progress: { percent: 0 } })
    await store().cancelUpdateDownload()
    expect(store().update).toMatchObject({ phase: 'available', progress: null })
  })

  it('downloadUpdate rejects with main\'s message', async () => {
    const { backend, store } = await ready()
    backend.fail(Ipc.updateDownload, { message: '没有可以下载的新版本' })
    await expect(store().downloadUpdate()).rejects.toThrow('没有可以下载的新版本')
  })

  it('restartToUpdate restarts when nothing is busy', async () => {
    const { backend, store } = await ready(scenario('ready', { update: updateReadyFixture('1.1.0') }))
    expect(await store().restartToUpdate()).toEqual({ status: 'restarting' })
    expect(store().updatePopoverOpen).toBe(false)
    expect(backend.callsTo(Ipc.updateRestart)).toHaveLength(1)
  })

  it('restartToUpdate asks in the popover when work would be interrupted, and 空闲后自动重启 arms it', async () => {
    const { backend, store } = await ready(scenario('ready', {
      update: updateReadyFixture('1.1.0'),
      jobs: [jobFixture({ id: 'job-live', state: 'running' })],
    }))
    const result = await store().restartToUpdate()
    expect(result).toMatchObject({ status: 'busy', busy: [{ kind: 'inference', count: 1 }] })
    expect(store().updatePopoverOpen).toBe(true)
    expect(store().updateBusy).toMatchObject([{ label: '1 个生成任务' }])
    await store().setRestartWhenIdle(true)
    expect(backend.callsTo(Ipc.updateRestartWhenIdle)).toEqual([{ enabled: true }])
    expect(store().update).toMatchObject({ phase: 'waiting-idle', restartWhenIdle: true })
    expect(store().updateBusy).toEqual([])
    await store().setRestartWhenIdle(false)
    expect(store().update).toMatchObject({ phase: 'ready', restartWhenIdle: false })
  })

  it('closing the popover forgets the busy answer', async () => {
    const { store, useApp } = await ready()
    useApp.setState({ updatePopoverOpen: true, updateBusy: [{ kind: 'inference', count: 1, label: '1 个生成任务' }] })
    store().setUpdatePopoverOpen(false)
    expect(store()).toMatchObject({ updatePopoverOpen: false, updateBusy: [] })
    store().setUpdatePopoverOpen(true)
    expect(store().updatePopoverOpen).toBe(true)
  })

  it('rollbackUpdate, channel and auto-download go to main', async () => {
    const { backend, store } = await ready(scenario('ready', { update: updaterStateFixture({ previous: '1.0.2', canRollback: true }) }))
    await store().setUpdateChannel('beta')
    await store().setAutoDownloadUpdates(false)
    expect(backend.callsTo(Ipc.updateSetChannel)).toEqual([{ channel: 'beta' }])
    expect(backend.callsTo(Ipc.updateSetAutoDownload)).toEqual([{ enabled: false }])
    expect(store().update).toMatchObject({ channel: 'beta', autoDownload: false })
    expect(await store().rollbackUpdate()).toEqual({ status: 'restarting' })
  })

  it('unskipUpdate offers the version skipped by a rollback again', async () => {
    const { backend, store } = await ready(scenario('ready', { update: updaterStateFixture({ skippedVersion: '1.1.0' }) }))
    await store().unskipUpdate()
    expect(backend.callsTo(Ipc.updateUnskip)).toEqual([undefined])
    expect(store().update!.skippedVersion).toBeNull()
  })

  it('dismissAnnouncement records the dismissal and refreshes the update state', async () => {
    const { backend, store } = await ready(scenario('ready', {
      update: updaterStateFixture({ announcements: [{ id: 'a1', level: 'info', title: 'A', body: '' }] }),
    }))
    await store().dismissAnnouncement('a1')
    expect(backend.callsTo(Ipc.announcementsDismiss)).toEqual([{ id: 'a1' }])
    expect(store().update!.announcements).toEqual([])
  })
})

describe('downloads and models', () => {
  it('downloadModel and downloadAdapter send kind + id and add the returned task', async () => {
    const { backend, store } = await ready('engineInstalledModelMissing')
    await store().downloadModel('moss-sft-dit')
    await store().downloadAdapter('dmd8-sft')
    expect(backend.callsTo(Ipc.modelDownload)).toEqual([{ kind: 'model', id: 'moss-sft-dit' }, { kind: 'adapter', id: 'dmd8-sft' }])
    expect(store().downloads.map((task) => task.id)).toEqual(['model:moss-sft-dit', 'adapter:dmd8-sft'])
  })

  it('downloadModel replaces an existing task in place', async () => {
    const { backend, store } = await ready(scenario('engineInstalledModelMissing', {
      downloads: [downloadFixture({ id: 'model:a', targetId: 'a' }), downloadFixture({ id: 'model:moss-sft-dit', state: 'error' }), downloadFixture({ id: 'model:c', targetId: 'c' })],
    }))
    await store().downloadModel('moss-sft-dit')
    expect(store().downloads.map((task) => `${task.id}=${task.state}`)).toEqual(['model:a=queued', 'model:moss-sft-dit=queued', 'model:c=queued'])
    expect(backend.state.downloads).toHaveLength(3)
  })

  it('downloadModel surfaces backend errors', async () => {
    const { store } = await ready()
    await expect(store().downloadModel('does-not-exist')).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(store().downloads).toEqual([])
  })

  it('downloadBundle queues every missing component and returns the tasks', async () => {
    const { backend, store } = await ready(scenario('engineInstalledModelMissing', {
      catalog: catalogFixture({ installed: ['qwen35-encoder'] }),
      downloads: [downloadFixture({ id: 'model:other', targetId: 'other' })],
    }))
    const tasks = await store().downloadBundle('moss-sft')
    expect(backend.callsTo(Ipc.modelBundleInstall)).toEqual([{ id: 'moss-sft' }])
    expect(tasks.map((task) => task.targetId)).toEqual(SFT_BUNDLE_IDS.filter((id) => id !== 'qwen35-encoder'))
    expect(store().downloads.map((task) => task.targetId)).toEqual(['other', 'moss-sft-dit', 'flux2-vae-small', 'moss-pipeline'])
  })

  it('downloadBundle returns nothing for an installed bundle and rejects an unknown one', async () => {
    const { store } = await ready('ready')
    expect(await store().downloadBundle('moss-sft')).toEqual([])
    await expect(store().downloadBundle('nope')).rejects.toThrow('模型组合不存在')
  })

  it('pauseDownload asks main and leaves the row to the next event', async () => {
    const { backend, store } = await ready(scenario('ready', { downloads: [downloadFixture({ state: 'running' })] }))
    await store().pauseDownload('model:moss-sft-dit')
    expect(backend.callsTo(Ipc.modelPause)).toEqual([{ taskId: 'model:moss-sft-dit' }])
    expect(store().downloads[0]!.state).toBe('running')
  })

  it('cancelDownload removes the row after main confirms, and keeps it on failure', async () => {
    const { backend, store } = await ready(scenario('ready', { downloads: [downloadFixture({ state: 'running' })] }))
    backend.fail(Ipc.modelCancel, {}, { times: 1 })
    await expect(store().cancelDownload('model:moss-sft-dit')).rejects.toBeTruthy()
    expect(store().downloads).toHaveLength(1)
    await store().cancelDownload('model:moss-sft-dit')
    expect(store().downloads).toEqual([])
  })

  it('deleteModel deletes then refreshes the catalog', async () => {
    const { backend, store } = await ready('ready')
    await store().deleteModel('model', 'moss-sft-dit')
    expect(backend.callsTo(Ipc.modelDelete)).toEqual([{ kind: 'model', id: 'moss-sft-dit' }])
    expect(store().catalog!.models.find((model) => model.id === 'moss-sft-dit')!.installed).toBe(false)
  })

  it('importAdapters returns [] without refreshing when the picker is canceled', async () => {
    const { backend, store } = await ready()
    expect(await store().importAdapters()).toEqual([])
    expect(backend.callsTo(Ipc.modelsCatalog)).toEqual([])
  })

  it('importAdapters refreshes the catalog and returns the imported adapters', async () => {
    const { backend, store } = await ready()
    const adapter = localAdapterFixture()
    backend.handle(Ipc.modelsImportAdapter, (_, { state }) => {
      state.catalog = { ...state.catalog, adapters: [...state.catalog.adapters, adapter] }
      return { canceled: false, adapters: [adapter] }
    })
    expect(await store().importAdapters()).toEqual([adapter])
    expect(store().catalog!.adapters.some((item) => item.id === adapter.id)).toBe(true)
  })
})

describe('jobs', () => {
  it('cancelJob upserts the returned record and ignores a null answer', async () => {
    const { backend, store } = await ready(scenario('ready', { jobs: [jobFixture({ id: 'j', state: 'running' })] }))
    await store().cancelJob('j')
    expect(store().jobs[0]!.state).toBe('canceled')
    await store().cancelJob('missing')
    expect(store().jobs).toHaveLength(1)
    expect(backend.callsTo(Ipc.jobCancel)).toEqual([{ id: 'j' }, { id: 'missing' }])
  })

  it('sendJobInput forwards the text', async () => {
    const { backend, store } = await ready()
    await store().sendJobInput('j', 'y\n')
    expect(backend.callsTo(Ipc.jobInput)).toEqual([{ id: 'j', text: 'y\n' }])
  })

  it('loadJobLogs replaces the job log and ignores failures', async () => {
    const { backend, store, useApp } = await ready(scenario('ready', { jobLogs: { j: jobLogFixture('j', 3) } }))
    useApp.setState({ jobLogs: { j: jobLogFixture('j', 1, 100), other: jobLogFixture('other', 1) } })
    await store().loadJobLogs('j')
    expect(store().jobLogs['j']!.map((line) => line.seq)).toEqual([0, 1, 2])
    expect(store().jobLogs['other']).toHaveLength(1)
    backend.fail(Ipc.jobLogs)
    await store().loadJobLogs('j')
    expect(store().jobLogs['j']).toHaveLength(3)
  })

  it('setActiveJob sets and clears the active job', async () => {
    const { store } = await ready()
    store().setActiveJob('x')
    expect(store().activeJobId).toBe('x')
    store().setActiveJob(null)
    expect(store().activeJobId).toBeNull()
  })
})

describe('diagnostics', () => {
  it('dismissDiagnostic removes only after main confirms', async () => {
    const { backend, store } = await ready(scenario('ready', { diagnostics: [diagnosticFixture({ id: 'a' }), diagnosticFixture({ id: 'b' })] }))
    backend.fail(Ipc.diagnosticsDismiss, {}, { times: 1 })
    await expect(store().dismissDiagnostic('a')).rejects.toBeTruthy()
    expect(store().diagnostics).toHaveLength(2)
    await store().dismissDiagnostic('a')
    expect(store().diagnostics.map((item) => item.id)).toEqual(['b'])
  })

  it('clearDiagnostics empties the list', async () => {
    const { backend, store } = await ready('jobFailure')
    await store().clearDiagnostics()
    expect(store().diagnostics).toEqual([])
    expect(backend.callsTo(Ipc.diagnosticsClear)).toHaveLength(1)
  })
})

describe('launch queue', () => {
  it('startLaunch is retired and always rejects', async () => {
    const { store } = await ready()
    await expect(store().startLaunch({ instanceId: 'i', workspace: 'clover', deviceId: 'cuda:0', profile: 'base' })).rejects.toThrow(/唯一创作入口/)
  })

  it('stopLaunch ignores unknown rows', async () => {
    const { backend, store } = await ready()
    await store().stopLaunch('nope')
    expect(backend.calls).toEqual([])
  })

  it('stopLaunch cancels the job of a running row and persists it as stopped', async () => {
    const { backend, store } = await ready(scenario('ready', {
      jobs: [jobFixture({ id: 'j', state: 'running' })],
      launchRows: [launchRowFixture({ id: 'r', jobId: 'j', state: 'running' })],
    }))
    await store().stopLaunch('r')
    await flush()
    expect(backend.callsTo(Ipc.jobCancel)).toEqual([{ id: 'j' }])
    expect(store().launchRows[0]!.state).toBe('stopped')
    expect(backend.callsTo(Ipc.launchQueueUpsert)).toEqual([expect.objectContaining({ id: 'r', state: 'stopped' })])
  })

  it('stopLaunch removes a queued row, tolerates a failing remove and schedules the next row', async () => {
    const { backend, store, useApp } = await ready(scenario('ready', { launchRows: [launchRowFixture({ id: 'r', deviceId: 'cuda:3' }), launchRowFixture({ id: 'keep' })] }))
    const startNextQueued = vi.fn(async (_deviceId: string) => undefined)
    useApp.setState({ startNextQueued })
    backend.fail(Ipc.launchQueueRemove)
    await store().stopLaunch('r')
    expect(store().launchRows.map((row) => row.id)).toEqual(['keep'])
    expect(backend.callsTo(Ipc.launchQueueRemove)).toEqual([{ id: 'r' }])
    expect(startNextQueued).toHaveBeenCalledWith('cuda:3')
  })

  it('startNextQueued does not call the backend', async () => {
    const { backend, store } = await ready(scenario('ready', { launchRows: [launchRowFixture()] }))
    await store().startNextQueued('cuda:0')
    expect(backend.calls).toEqual([])
  })
})

describe('studio state', () => {
  it('stores the underlay background', async () => {
    const { store } = await ready()
    store().setStudioBackground(null)
    expect(store().studioBackground).toBeNull()
  })

  it('hands a reuse request to Studio exactly once', async () => {
    const { store } = await ready()
    const request = { id: 'r1', createdAt: '2026-11-01T00:00:00.000Z', sourcePath: '/out/a.png', prompt: 'p', seed: 7 }
    store().requestStudioReuse(request)
    expect(store().takeStudioReuseRequest()).toEqual(request)
    expect(store().takeStudioReuseRequest()).toBeNull()
  })

  it('a newer reuse request replaces a pending one', async () => {
    const { store } = await ready()
    store().requestStudioReuse({ id: 'old', createdAt: '', sourcePath: '/a', prompt: 'a' })
    store().requestStudioReuse({ id: 'new', createdAt: '', sourcePath: '/b', prompt: 'b' })
    expect(store().takeStudioReuseRequest()!.id).toBe('new')
  })

  it('drops a malformed reuse request but still clears it', async () => {
    const { store, useApp } = await ready()
    useApp.setState({ studioReuseRequest: { id: 'bad', createdAt: '', sourcePath: '/a', prompt: 'p', width: Number.NaN } })
    expect(store().takeStudioReuseRequest()).toBeNull()
    expect(store().studioReuseRequest).toBeNull()
  })
})
