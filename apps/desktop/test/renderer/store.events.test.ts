import { afterEach, describe, expect, it, vi } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import {
  diagnosticFixture,
  downloadFixture,
  engineDownloadFixture,
  engineMissingFixture,
  engineReadyFixture,
  gpuTelemetryFixture,
  jobFixture,
  jobLogFixture,
  launchRowFixture,
  scenario,
  settingsFixture,
  updateAvailableFixture,
  updateDownloadingFixture,
  updateFailedFixture,
  updateReadyFixture,
  updaterStateFixture,
} from '../mocks/backend'
import { flush, loadStore } from '../helpers/renderer'

async function ready(...args: Parameters<typeof loadStore>) {
  const loaded = await loadStore(...args)
  await loaded.store().init()
  loaded.backend.calls.length = 0
  return loaded
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Events.download', () => {
  it('updates a known task in place and appends unknown tasks, never reordering', async () => {
    const { backend, store } = await ready(scenario('ready', {
      downloads: ['a', 'b', 'c'].map((id) => downloadFixture({ id: `model:${id}`, targetId: id, state: 'queued' })),
    }))
    backend.emit(Events.download, downloadFixture({ id: 'model:c', targetId: 'c', state: 'running', bytes: 10 }))
    backend.emit(Events.download, downloadFixture({ id: 'model:a', targetId: 'a', state: 'paused' }))
    backend.emit(Events.download, downloadFixture({ id: 'adapter:x', kind: 'adapter', targetId: 'x', state: 'queued' }))
    expect(store().downloads.map((task) => `${task.id}=${task.state}`)).toEqual([
      'model:a=paused', 'model:b=queued', 'model:c=running', 'adapter:x=queued',
    ])
  })

  // Ported from tools/test-download-queue.mjs (renderer half).
  it('keeps the initial queue order through every state change and later downloads', async () => {
    const initial = ['a', 'b', 'c'].map((id) => downloadFixture({ id: `model:${id}`, targetId: id, label: id, totalBytes: 1000, filesTotal: 2 }))
    const { backend, store } = await ready(scenario('ready', {
      settings: settingsFixture({ onboardingState: 'completed' }),
      downloads: initial,
      catalog: { ...scenario('ready').catalog, models: [], adapters: [] },
    }))
    const ids = () => store().downloads.map((item) => item.id)
    const expected = initial.map((item) => item.id)
    expect(ids()).toEqual(expected)
    for (const [id, state] of [['b', 'running'], ['a', 'running'], ['c', 'running'], ['b', 'paused'], ['b', 'running'], ['c', 'error'], ['a', 'done']] as const) {
      const update = downloadFixture({ id: `model:${id}`, targetId: id, label: id, state, bytes: 500, totalBytes: 1000, filesTotal: 2, updatedAt: '2099-01-01T00:00:00.000Z' })
      backend.emit(Events.download, update)
      expect(ids()).toEqual(expected)
      expect(store().downloads.find((item) => item.id === update.id)).toEqual(update)
    }
    backend.emit(Events.download, downloadFixture({ id: 'model:d', targetId: 'd' }))
    expected.push('model:d')
    expect(ids()).toEqual(expected)
    backend.handle(Ipc.modelDownload, () => downloadFixture({ id: 'model:b', targetId: 'b', state: 'running', bytes: 600 }))
    await store().downloadModel('b')
    expect(ids()).toEqual(expected)
    expect(store().downloads[1]!.bytes).toBe(600)
    backend.handle(Ipc.modelDownload, () => downloadFixture({ id: 'adapter:adapter', kind: 'adapter', targetId: 'adapter' }))
    await store().downloadAdapter('adapter')
    expect(ids()).toEqual([...expected, 'adapter:adapter'])
    expect(store().error).toBeNull()
  })

  it('removes a canceled task without notifying', async () => {
    const { backend, store } = await ready(scenario('ready', { downloads: [downloadFixture({ state: 'running' })] }))
    backend.emit(Events.download, downloadFixture({ state: 'canceled' }))
    expect(store().downloads).toEqual([])
    expect(store().notifications).toEqual([])
  })

  it('refreshes the catalog and notifies once when a task completes', async () => {
    const { backend, store } = await ready(scenario('ready', { downloads: [downloadFixture({ state: 'running' })] }))
    backend.emit(Events.download, downloadFixture({ state: 'done' }))
    backend.emit(Events.download, downloadFixture({ state: 'done' }))
    await flush()
    expect(backend.callsTo(Ipc.modelsCatalog)).toHaveLength(1)
    expect(store().notifications).toHaveLength(1)
    expect(store().notifications[0]).toMatchObject({ tone: 'success', title: '下载完成', message: 'MOSS-Image SFT 已写入本地缓存' })
  })

  it('names the remote host in the completion message', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.download, downloadFixture({ state: 'done', hostId: 'ssh-gpu', hostName: 'Linux GPU' }))
    backend.emit(Events.download, downloadFixture({ id: 'model:x', targetId: 'x', label: 'X', state: 'done', hostId: 'ssh-2' }))
    expect(store().notifications.map((item) => item.message)).toEqual(['X 已下载到 ssh-2', 'MOSS-Image SFT 已下载到 Linux GPU'])
  })

  it('notifies a failure once, falling back to the label when there is no error text', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.download, downloadFixture({ state: 'error', error: 'HTTP 403' }))
    backend.emit(Events.download, downloadFixture({ state: 'error', error: 'HTTP 403' }))
    backend.emit(Events.download, downloadFixture({ id: 'model:y', targetId: 'y', label: 'Y', state: 'error' }))
    expect(store().notifications.map((item) => [item.tone, item.title, item.message])).toEqual([
      ['error', '下载失败', 'Y'],
      ['error', '下载失败', 'HTTP 403'],
    ])
  })

  it('drives a full mock download to an installed catalog entry', async () => {
    const { backend, store } = await ready('engineInstalledModelMissing')
    await store().downloadModel('moss-sft-dit')
    const [task] = backend.state.downloads
    backend.playDownload(task!)
    await flush()
    expect(store().downloads[0]!.state).toBe('done')
    expect(store().catalog!.models.find((model) => model.id === 'moss-sft-dit')!.installed).toBe(true)
  })
})

describe('Events.job', () => {
  it('keeps jobs sorted newest first and replaces by id', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.job, jobFixture({ id: 'old', startedAt: '2026-01-01T00:00:00.000Z' }))
    backend.emit(Events.job, jobFixture({ id: 'new', startedAt: '2026-03-01T00:00:00.000Z' }))
    backend.emit(Events.job, jobFixture({ id: 'old', startedAt: '2026-01-01T00:00:00.000Z', state: 'running' }))
    expect(store().jobs.map((job) => `${job.id}:${job.state}`)).toEqual(['new:queued', 'old:running'])
  })

  it('makes the first job active and keeps a chosen active job', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.job, jobFixture({ id: 'first' }))
    expect(store().activeJobId).toBe('first')
    backend.emit(Events.job, jobFixture({ id: 'second' }))
    expect(store().activeJobId).toBe('first')
  })

  it('notifies success once with the instance and size', async () => {
    const { backend, store } = await ready()
    const job = jobFixture({ id: 'j', params: { ...jobFixture().params, width: 768, height: 1344 } })
    backend.playJob(job)
    backend.emit(Events.job, backend.state.jobs[0])
    expect(store().jobs[0]!.state).toBe('succeeded')
    expect(store().notifications).toHaveLength(1)
    expect(store().notifications[0]).toMatchObject({ tone: 'success', title: '生成完成', message: 'MossInfer · 768×1344' })
  })

  it('notifies a failure with the error message or a fallback', async () => {
    const { backend, store } = await ready()
    backend.playJob(jobFixture({ id: 'oom' }), { fail: { code: 'E_OOM', message: 'CUDA out of memory' } })
    backend.emit(Events.job, jobFixture({ id: 'bare', state: 'failed' }))
    expect(store().notifications.map((item) => item.message)).toEqual(['查看诊断页了解原因', 'CUDA out of memory'])
    expect(store().notifications.every((item) => item.tone === 'error' && item.title === '任务失败')).toBe(true)
  })

  it.each([
    ['starting', 'starting'],
    ['running', 'running'],
    ['queued', 'running'],
    ['succeeded', 'stopped'],
    ['canceled', 'stopped'],
    ['failed', 'failed'],
  ] as const)('maps job state %s onto its launch row as %s and persists it', async (jobState, rowState) => {
    vi.useFakeTimers()
    const { backend, useApp, store } = await ready(scenario('ready', { launchRows: [launchRowFixture({ id: 'row', jobId: 'j', state: 'running' })] }))
    const startNextQueued = vi.fn(async (_deviceId: string) => undefined)
    useApp.setState({ startNextQueued })
    backend.emit(Events.job, jobFixture({ id: 'j', state: jobState, error: jobState === 'failed' ? { code: 'E', message: 'boom' } : undefined }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store().launchRows[0]).toMatchObject({ id: 'row', state: rowState })
    expect(backend.callsTo(Ipc.launchQueueUpsert)).toEqual([expect.objectContaining({ id: 'row', state: rowState })])
    await vi.advanceTimersByTimeAsync(150)
    expect(startNextQueued).toHaveBeenCalledTimes(rowState === 'stopped' || rowState === 'failed' ? 1 : 0)
    if (rowState === 'failed') expect(store().launchRows[0]!.error).toBe('boom')
  })

  it('keeps the previous launch-row error when the job carries none', async () => {
    const { backend, store } = await ready(scenario('ready', { launchRows: [launchRowFixture({ jobId: 'j', state: 'running', error: 'earlier' })] }))
    backend.emit(Events.job, jobFixture({ id: 'j', state: 'running' }))
    expect(store().launchRows[0]!.error).toBe('earlier')
  })

  it('ignores a failing launch-queue persist', async () => {
    const { backend, store } = await ready(scenario('ready', { launchRows: [launchRowFixture({ jobId: 'j', state: 'running' })] }))
    backend.fail(Ipc.launchQueueUpsert)
    backend.emit(Events.job, jobFixture({ id: 'j', state: 'running' }))
    await flush()
    expect(store().launchRows[0]!.state).toBe('running')
  })
})

describe('log and diagnostic events', () => {
  it('appends job log lines per job and caps each job at 1500 lines', async () => {
    const { backend, store } = await ready()
    for (const line of jobLogFixture('a', 1502)) backend.emit(Events.jobLog, line)
    backend.emit(Events.jobLog, jobLogFixture('b', 1)[0])
    const lines = store().jobLogs['a']!
    expect(lines).toHaveLength(1500)
    expect(lines[0]!.seq).toBe(2)
    expect(lines.at(-1)!.seq).toBe(1501)
    expect(store().jobLogs['b']).toHaveLength(1)
  })

  it('upserts diagnostics newest first and caps them at 200', async () => {
    const { backend, store } = await ready()
    for (let index = 0; index < 205; index += 1) backend.emit(Events.diagnostic, diagnosticFixture({ id: `d${index}` }))
    backend.emit(Events.diagnostic, diagnosticFixture({ id: 'd100', count: 9 }))
    const diagnostics = store().diagnostics
    expect(diagnostics).toHaveLength(200)
    expect(diagnostics[0]).toMatchObject({ id: 'd100', count: 9 })
    expect(diagnostics.filter((item) => item.id === 'd100')).toHaveLength(1)
    expect(diagnostics.some((item) => item.id === 'd4')).toBe(false)
  })

  it('formats runtime log lines per instance and caps them at 500', async () => {
    const { backend, store } = await ready()
    const at = '2026-11-01T08:09:10.000Z'
    for (let index = 0; index < 502; index += 1) {
      backend.emit(Events.runtimeLog, { runtimeId: 'r', instanceId: 'i', line: `l${index}`, stream: 'stdout', at })
    }
    const lines = store().runtimeLogs['i']!
    expect(lines).toHaveLength(500)
    expect(lines.at(-1)).toBe(`${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}  l501`)
    expect(lines[0]!.endsWith('  l2')).toBe(true)
  })

  it('records GPU telemetry, env scan progress and git progress', async () => {
    const { backend, store } = await ready()
    const telemetry = gpuTelemetryFixture()
    backend.emit(Events.gpuTelemetry, telemetry)
    backend.emit(Events.envProgress, { section: 'network' })
    backend.emit(Events.gitProgress, { message: 'Receiving objects: 42%' })
    expect(store().gpuTelemetry).toEqual(telemetry)
    expect(store().scanSection).toBe('network')
    expect(store().gitMessage).toBe('Receiving objects: 42%')
  })
})

describe('Events.settingsChanged', () => {
  it('applies the new settings and re-reads engine readiness', async () => {
    const { backend, store } = await ready()
    backend.state.engineReadiness = engineMissingFixture()
    backend.emit(Events.settingsChanged, settingsFixture({ theme: 'light', uiAnimation: 'on', sidebarCollapsed: true }))
    await flush()
    expect(store().settings!.sidebarCollapsed).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.uiAnimation).toBe('on')
    expect(store().engineReadiness).toEqual(engineMissingFixture())
  })
})

describe('Events.updateState', () => {
  it('stores a background-discovered release and notifies once, even while onboarding is pending', async () => {
    const { backend, store } = await ready(scenario('ready', { settings: settingsFixture({ onboardingState: 'pending' }) }))
    backend.emit(Events.updateState, updateAvailableFixture('2.0.0'))
    backend.emit(Events.updateState, updateAvailableFixture('2.0.0', { checkedAt: '2026-11-02T00:00:00.000Z' }))
    expect(store().update!.available!.version).toBe('2.0.0')
    expect(store().notifications).toHaveLength(1)
    expect(store().notifications[0]).toMatchObject({ tone: 'info', title: '发现新版本' })
    expect(store().notifications[0]!.message).toContain('2.0.0')
  })

  it('says a new version downloads in the background when 自动下载更新 is on', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.updateState, updateAvailableFixture('2.0.0', { autoDownload: true }))
    expect(store().notifications[0]!.message).toBe('MossStudio 2.0.0 正在后台下载')
  })

  it('stays quiet for progress and notifies once when the update is ready', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.updateState, updateDownloadingFixture('1.1.0', 10))
    backend.emit(Events.updateState, updateDownloadingFixture('1.1.0', 80))
    expect(store().notifications).toEqual([])
    backend.emit(Events.updateState, updateReadyFixture('1.1.0'))
    backend.emit(Events.updateState, updateReadyFixture('1.1.0'))
    expect(store().notifications).toMatchObject([{ tone: 'success', title: '更新已准备好', message: '重启 MossStudio 即可更新到 1.1.0' }])
  })

  it('warns once about a required update and reports a failure once', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.updateState, updateAvailableFixture('1.1.0', { required: true, minimumVersion: '1.1.0' }))
    backend.emit(Events.updateState, updaterStateFixture({ phase: 'error', error: '下载的文件校验失败' }))
    backend.emit(Events.updateState, updaterStateFixture({ phase: 'error', error: '下载的文件校验失败' }))
    const titles = store().notifications.map((item) => item.title)
    expect(titles.filter((title) => title === '必须更新')).toHaveLength(1)
    expect(titles.filter((title) => title === '更新没有完成')).toHaveLength(1)
    expect(store().notifications.find((item) => item.title === '必须更新')!.message).toContain('1.1.0')
  })

  it('says once, plainly, that a new version did not start and opens the popover', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.updateState, updateFailedFixture('1.1.0'))
    backend.emit(Events.updateState, updateFailedFixture('1.1.0'))
    expect(store().notifications).toMatchObject([{
      tone: 'warning', title: '新版本没能启动', message: 'MossStudio 1.1.0 没能正常启动，已经自动回到 1.0.3。你的作品、模型和设置都没有受影响。',
    }])
    expect(store().updatePopoverOpen).toBe(true)
    store().setUpdatePopoverOpen(false)
    // Without the notice (told before, or dismissed) the version stays quiet.
    backend.emit(Events.updateState, updateFailedFixture('1.2.0', { failedNotice: false }))
    expect(store().notifications).toHaveLength(1)
    expect(store().updatePopoverOpen).toBe(false)
  })

  it('does nothing when there is nothing new, and nothing at all for a copy that cannot update', async () => {
    const { backend, store } = await ready()
    backend.emit(Events.updateState, updaterStateFixture({ checkedAt: '2026-11-02T00:00:00.000Z' }))
    expect(store().update!.checkedAt).toBe('2026-11-02T00:00:00.000Z')
    backend.emit(Events.updateState, updateAvailableFixture('3.0.0', { supported: false, unsupportedReason: '开发版本' }))
    expect(store().notifications).toEqual([])
  })
})

describe('Events.mossInferDownload', () => {
  it('mirrors in-flight progress into engineReadiness.installing', async () => {
    const { backend, store } = await ready('firstRun')
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'downloading', percent: 37 }))
    expect(store().mossInferDownload!.percent).toBe(37)
    expect(store().engineReadiness!.installing).toEqual({ phase: 'downloading', percent: 37, version: 'v2.1.1' })
    expect(store().notifications).toEqual([])
  })

  it('refreshes readiness then announces a finished install once', async () => {
    const { backend, store } = await ready('firstRun')
    backend.state.engineReadiness = engineReadyFixture()
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'done', percent: 100 }))
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'done', percent: 100 }))
    await flush()
    expect(store().engineReadiness).toEqual(engineReadyFixture())
    expect(store().notifications).toHaveLength(1)
    expect(store().notifications[0]).toMatchObject({ tone: 'success', title: 'MossInfer 引擎已就绪', message: 'v2.1.1 已安装并设为当前版本' })
  })

  it('uses a generic success message when the version is unknown', async () => {
    const { backend, store } = await ready('firstRun')
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'done', version: undefined }))
    await flush()
    expect(store().notifications[0]!.message).toBe('引擎已安装并设为当前版本')
  })

  it('reports a failed first install as an error', async () => {
    const { backend, store } = await ready('firstRun')
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'error', error: '下载连接中断' }))
    await flush()
    expect(store().engineReadiness!.installing).toBeUndefined()
    expect(store().notifications[0]).toMatchObject({ tone: 'error', title: 'MossInfer 引擎安装失败', message: '下载连接中断' })
  })

  it('reports a failed update over a working engine as a warning', async () => {
    const { backend, store } = await ready('ready')
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'error', error: '校验失败' }))
    await flush()
    expect(store().notifications[0]).toMatchObject({ tone: 'warning', title: 'MossInfer 引擎更新失败', message: '当前引擎仍可用 · 校验失败' })
  })

  it('falls back to the cached readiness when the refresh fails', async () => {
    const { backend, store } = await ready('ready')
    backend.fail(Ipc.engineStatus)
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'error' }))
    await flush()
    expect(store().notifications[0]).toMatchObject({ tone: 'warning', message: '当前引擎仍可用 · 上次更新未完成' })
  })

  it('warns when an install is canceled and refreshes readiness', async () => {
    const { backend, store } = await ready('firstRun')
    backend.emit(Events.mossInferDownload, engineDownloadFixture({ phase: 'canceled', version: undefined }))
    await flush()
    expect(backend.callsTo(Ipc.engineStatus)).toHaveLength(1)
    expect(store().notifications[0]).toMatchObject({ tone: 'warning', title: 'MossInfer 引擎安装已取消', message: '安装任务已停止' })
  })
})
