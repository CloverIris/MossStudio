/**
 * A data-driven fake of the main process as the renderer sees it.
 *
 * The renderer talks to main only through `window.clover` (preload/index.ts):
 * `invoke(channel, payload)` resolving to an IpcResult, and `on(event, cb)`.
 * `createMockBackend()` builds that bridge over a mutable `MockBackendState`
 * so tests (unit now, E2E later) can:
 *
 *   const backend = createMockBackend('firstRun')   // or a state object
 *   backend.install()                               // sets window.clover
 *   backend.fail(Ipc.settingsUpdate, { code: 'E_WRITE' })
 *   const held = backend.hold(Ipc.jobList)          // resolve later
 *   backend.emit(Events.download, task)             // push a main→renderer event
 *   backend.playJob(job)                            // emit a whole job lifecycle
 *   backend.calls / backend.callsTo(Ipc.modelDownload)
 *
 * Channels without a handler answer `{ ok: false, code: 'E_MOCK_UNHANDLED' }`
 * and are listed in `backend.unhandled`, unless `fallback: 'empty'` is passed
 * (the legacy UI-harness behaviour: `[]`, or `null` for appInfo/envScan).
 */
import { Events, Ipc } from '@shared/channels'
import type { AiChatInput, AiConversationInfo, AiMessage } from '@shared/ai'
import type { WebAccessInfo } from '@shared/backend'
import type { EngineHello } from '@shared/engineProtocol'
import type { UpdateBusyReason, UpdateRestartResult, UpdaterState } from '@shared/update'
import type {
  DownloadTask,
  EngineGpuProbeSnapshot,
  IpcError,
  IpcResult,
  JobRecord,
  LaunchRow,
  ManagedHost,
  OnboardingStatus,
  OnboardingStep,
  ProjectDocument,
  ProjectSummary,
  Settings,
  TrainingHost,
} from '@shared/types'
import {
  ENGINE_JOBS_CHANNEL,
  ENGINE_PATH,
  FIXTURE_NOW,
  controlAdapterFixture,
  localHostFixture,
  downloadFixture,
  jobLifecycle,
  submittedJobFixture,
  type JobLifecycleOptions,
} from './fixtures'
import { scenario, type MockBackendState, type ScenarioName } from './scenarios'
import { addInstallHandlers } from './install'

export * from './fixtures'
export * from './scenarios'
export * from './install'

export type CloverBridge = Window['clover']

export interface HandlerContext {
  state: MockBackendState
  emit: (event: string, data: unknown) => void
}

export type Handler = (payload: unknown, context: HandlerContext) => unknown

/** Throw from a handler to answer `{ ok: false, error }`. */
export class MockIpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface HeldCall {
  channel: string
  payload: unknown
  /** Resolve with the handler's answer (default) or an explicit value. */
  release(data?: unknown): Promise<void>
  reject(error?: Partial<IpcError>): Promise<void>
  /** Resolves once the renderer has actually made the held call. */
  called: Promise<void>
}

export interface MockBackendOptions {
  fallback?: 'error' | 'empty'
  bridge?: Partial<Pick<CloverBridge, 'platform' | 'version' | 'acrylic' | 'windowKind' | 'channel'>>
}

export interface MockBackend {
  state: MockBackendState
  readonly bridge: CloverBridge
  readonly calls: Array<{ channel: string; payload: unknown }>
  readonly unhandled: string[]
  callsTo(channel: string): unknown[]
  handle(channel: string, handler: Handler): void
  fail(channel: string, error?: Partial<IpcError>, options?: { times?: number }): void
  hold(channel: string): HeldCall
  emit(event: string, data: unknown): void
  listenerCount(event: string): number
  /** Emit `jobLifecycle(job, options)` on Events.job (queue places, preview frames…), keeping state.jobs in sync. */
  playJob(job: JobRecord, options?: JobLifecycleOptions): JobRecord[]
  /** Emit queued → running → verifying → done (or error) for a download task. */
  playDownload(task: DownloadTask, options?: { error?: string }): DownloadTask[]
  install(target?: { clover?: CloverBridge }): () => void
  reset(next?: ScenarioName | MockBackendState): void
}

function deepClone<T>(value: T): T {
  return structuredClone(value)
}

function onboardingStatus(state: MockBackendState, hostId: string): OnboardingStatus {
  const local = hostId === 'local'
  const host = state.hosts.find((item) => item.id === hostId)
  if (!local && !host) throw new MockIpcError('E_HOST', 'SSH 主机已移除，请重新选择准备位置')
  const gpu = state.devices.find((device) => device.kind === 'cuda' && device.available)
  const deviceReady = local ? Boolean(gpu) : host?.status === 'ok'
  const engineReady = local ? state.engineReadiness.state === 'ready' : false
  const installed = new Set(local ? state.catalog.models.filter((model) => model.installed).map((model) => model.id) : [])
  const bundle = [...state.catalog.bundles].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)))[0]
  const modelIds = bundle ? [...Object.values(bundle.components), bundle.support] : []
  const count = modelIds.filter((id) => installed.has(id)).length
  const partial = count > 0 || modelIds.some((id) => state.catalog.models.find((model) => model.id === id)?.installState === 'partial')
  const modelReady = modelIds.length > 0 && count === modelIds.length
  const steps: OnboardingStep[] = [
    { id: 'device', status: deviceReady ? 'ok' : 'missing', title: '推理设备', detail: gpu?.name ?? '需要可用的 NVIDIA GPU；也可以添加 Linux NVIDIA SSH 主机', action: 'devices' },
    { id: 'engine', status: engineReady ? 'ok' : 'missing', title: 'MossInfer 引擎', detail: engineReady ? 'MossInfer 已就绪' : '尚未准备 MossInfer 引擎；请下载或选择自定义引擎目录', action: 'engines' },
    {
      id: 'model', title: '模型', action: 'models', modelIds,
      status: modelReady ? 'ok' : partial ? 'partial' : 'missing',
      detail: modelReady ? `${bundle?.name} 已就绪` : `${bundle?.name ?? 'MOSS-Image'} · ${count}/${modelIds.length || 4} 个组件已就绪，需准备主模型、文本编码器、VAE 与配置`,
      sizeBytes: state.catalog.models.filter((model) => modelIds.includes(model.id) && !installed.has(model.id)).reduce((sum, model) => sum + model.sizeBytes, 0),
    },
  ]
  return { hostId, bundleId: bundle?.id, bundleName: bundle?.name, ready: steps.every((step) => step.status === 'ok'), steps, checkedAt: FIXTURE_NOW }
}

function projectSummary(project: ProjectDocument): ProjectSummary {
  const canvas = project.canvases.find((item) => item.id === project.selectedCanvasId) ?? project.canvases[0]
  return {
    id: project.id, name: project.name, width: canvas?.width ?? 1024, height: canvas?.height ?? 1024,
    layerCount: canvas?.layers.length ?? 0, seriesId: project.seriesId, page: project.page, updatedAt: project.updatedAt,
  }
}

/** Default handlers: the subset of main/ipc.ts the renderer relies on, backed by state. */
function defaultHandlers(): Map<string, Handler> {
  const h = new Map<string, Handler>()
  const p = <T>(payload: unknown) => (payload ?? {}) as T

  h.set(Ipc.appInfo, () => ({
    name: 'MossStudio', version: '1.0.3', electron: '44.9.0', chrome: '140', node: '24', platform: 'win32', arch: 'x64',
    dataPath: '/fixture/data', modelsPath: '/fixture/data/models',
    modelDirectories: { dit: '/fixture/data/models/moss', textEncoder: '/fixture/data/models/text-encoder', vae: '/fixture/data/models/vae', support: '/fixture/data/models/support', adapters: '/fixture/data/models/adapters' },
    acrylic: false,
  }))
  h.set(Ipc.backendInfo, () => ({ ready: true, url: 'http://studio-fixture', token: 'fixture' }))

  // Settings
  h.set(Ipc.settingsGet, (_, { state }) => state.settings)
  h.set(Ipc.settingsUpdate, (payload, { state }) => {
    const patch = p<Partial<Settings> & { hfToken?: string | null }>(payload)
    const { hfToken, ...rest } = patch
    state.settings = {
      ...state.settings,
      ...rest,
      modelDirectories: { ...state.settings.modelDirectories, ...rest.modelDirectories },
      ...(hfToken !== undefined ? { hasHfToken: Boolean(hfToken) } : {}),
    }
    return state.settings
  })

  // Environment & updates
  h.set(Ipc.envScan, (_, { state }) => state.env)

  // App updates (main/update): every call answers the whole UpdaterState, and
  // each change is also pushed on Events.updateState, as main does.
  const pushUpdate = (context: HandlerContext, patch: Partial<UpdaterState>): UpdaterState => {
    context.state.update = { ...context.state.update, ...patch }
    context.emit(Events.updateState, context.state.update)
    return context.state.update
  }
  /** What a restart would interrupt: running generation/training jobs and model downloads. */
  const updateBusy = (state: MockBackendState): UpdateBusyReason[] => {
    const active = state.jobs.filter((job) => ['queued', 'starting', 'running'].includes(job.state))
    const inference = active.filter((job) => job.kind !== 'training').length
    const training = active.length - inference
    const downloads = state.downloads.filter((task) => ['queued', 'running', 'verifying'].includes(task.state)).length
    const engine = Boolean(state.engineDownload && !['done', 'error', 'canceled'].includes(state.engineDownload.phase))
    return [
      ...(inference ? [{ kind: 'inference' as const, count: inference, label: `${inference} 个生成任务` }] : []),
      ...(training ? [{ kind: 'training' as const, count: training, label: `${training} 个训练任务` }] : []),
      ...(downloads ? [{ kind: 'model-download' as const, count: downloads, label: `${downloads} 个模型下载` }] : []),
      ...(engine ? [{ kind: 'engine-download' as const, count: 1, label: '推理引擎下载或安装' }] : []),
    ]
  }
  h.set(Ipc.updateState, (_, { state }) => state.update)
  h.set(Ipc.updateCheck, (_, context) => pushUpdate(context, { checkedAt: FIXTURE_NOW }))
  h.set(Ipc.updateDownload, (_, context) => {
    const available = context.state.update.available
    if (!available) throw new MockIpcError('E_UPDATE', '没有可以下载的新版本')
    return pushUpdate(context, { phase: 'downloading', error: null, progress: { bytes: 0, totalBytes: available.downloadSize, speedBps: 0, percent: 0 } })
  })
  h.set(Ipc.updateCancel, (_, context) => pushUpdate(context, { phase: context.state.update.available ? 'available' : 'idle', progress: null }))
  const restartInto = (context: HandlerContext): UpdateRestartResult => {
    const busy = updateBusy(context.state)
    if (busy.length) {
      pushUpdate(context, { busy })
      return { status: 'busy', busy }
    }
    pushUpdate(context, { phase: 'restarting', busy: [] })
    return { status: 'restarting' }
  }
  h.set(Ipc.updateRestart, (_, context) => {
    const update = context.state.update
    if (!update.supported) return { status: 'unsupported', reason: update.unsupportedReason ?? '不能在这里更新' }
    if (!update.pending || !['ready', 'waiting-idle'].includes(update.phase)) return { status: 'nothing-pending' }
    return restartInto(context)
  })
  h.set(Ipc.updateRestartWhenIdle, (payload, context) => {
    const { enabled } = p<{ enabled: boolean }>(payload)
    // Like main: no pending needed; a running download is waited for, then idle.
    return pushUpdate(context, enabled
      ? { restartWhenIdle: true, phase: 'waiting-idle', busy: updateBusy(context.state) }
      : { restartWhenIdle: false, phase: 'ready', busy: [] })
  })
  h.set(Ipc.updateRollback, (_, context) => {
    const update = context.state.update
    if (!update.supported) return { status: 'unsupported', reason: update.unsupportedReason ?? '不能在这里更新' }
    if (!update.canRollback || !update.previous) return { status: 'nothing-pending' } satisfies UpdateRestartResult
    return restartInto(context)
  })
  h.set(Ipc.updateSetChannel, (payload, context) => pushUpdate(context, { channel: p<{ channel: UpdaterState['channel'] }>(payload).channel }))
  h.set(Ipc.updateSetAutoDownload, (payload, context) => pushUpdate(context, { autoDownload: p<{ enabled: boolean }>(payload).enabled }))
  h.set(Ipc.updateUnskip, (_, context) => {
    context.state.settings = { ...context.state.settings, skippedUpdateVersion: null }
    return pushUpdate(context, { skippedVersion: null })
  })
  h.set(Ipc.announcementsDismiss, (payload, { state }) => {
    const { id } = p<{ id: string }>(payload)
    state.settings = { ...state.settings, dismissedAnnouncements: [...state.settings.dismissedAnnouncements, id] }
    state.update = { ...state.update, announcements: state.update.announcements.filter((item) => item.id !== id) }
    return null
  })

  // Models & downloads
  h.set(Ipc.modelsCatalog, (_, { state }) => state.catalog)
  h.set(Ipc.downloadsList, (_, { state }) => state.downloads)
  const beginDownload = (state: MockBackendState, kind: 'model' | 'adapter', id: string): DownloadTask => {
    const entry = kind === 'model' ? state.catalog.models.find((item) => item.id === id) : state.catalog.adapters.find((item) => item.id === id)
    if (!entry) throw new MockIpcError('E_NOT_FOUND', `未知${kind === 'model' ? '模型' : '适配器'} ${id}`)
    const existing = state.downloads.find((task) => task.id === `${kind}:${id}`)
    if (existing && !['done', 'error', 'canceled'].includes(existing.state)) return existing
    const task = downloadFixture({ id: `${kind}:${id}`, kind, targetId: id, label: entry.name, totalBytes: entry.sizeBytes, filesTotal: entry.files?.length ?? 1 })
    state.downloads = [...state.downloads.filter((item) => item.id !== task.id), task]
    return task
  }
  h.set(Ipc.modelDownload, (payload, { state }) => {
    const { kind, id } = p<{ kind: 'model' | 'adapter'; id: string }>(payload)
    return beginDownload(state, kind, id)
  })
  // Mirrors models.ts installBundle: one task per component that is not installed yet.
  h.set(Ipc.modelBundleInstall, (payload, { state }) => {
    const { id } = p<{ id: string }>(payload)
    const bundle = state.catalog.bundles.find((item) => item.id === id)
    if (!bundle) throw new MockIpcError('E_NOT_FOUND', '模型组合不存在')
    const tasks: DownloadTask[] = []
    for (const componentId of [...Object.values(bundle.components), bundle.support]) {
      const model = state.catalog.models.find((item) => item.id === componentId)
      if (!model) throw new MockIpcError('E_NOT_FOUND', `组合缺少组件：${componentId}`)
      if (!model.installed) tasks.push(beginDownload(state, 'model', componentId))
    }
    return tasks
  })
  h.set(Ipc.modelPause, (payload, { state }) => {
    const { taskId } = p<{ taskId: string }>(payload)
    state.downloads = state.downloads.map((task) => task.id === taskId ? { ...task, state: 'paused', speedBps: 0 } : task)
    return null
  })
  h.set(Ipc.modelCancel, (payload, { state }) => {
    const { taskId } = p<{ taskId: string }>(payload)
    state.downloads = state.downloads.filter((task) => task.id !== taskId)
    return null
  })
  h.set(Ipc.modelDelete, (payload, { state }) => {
    const { kind, id } = p<{ kind: 'model' | 'adapter'; id: string }>(payload)
    if (kind === 'model') state.catalog = { ...state.catalog, models: state.catalog.models.map((model) => model.id === id ? { ...model, installed: false, installState: 'missing', installedBytes: 0 } : model) }
    else state.catalog = { ...state.catalog, adapters: state.catalog.adapters.map((adapter) => adapter.id === id ? { ...adapter, installed: false, installedBytes: 0 } : adapter) }
    return null
  })
  h.set(Ipc.modelsImportAdapter, () => ({ canceled: true, adapters: [] }))
  h.set(Ipc.modelsRemoteInventory, () => ({ root: '/fixture/models', files: 0, models: [], adapters: [] }))
  h.set(Ipc.modelsRemoteDelete, (payload) => ({ removed: p<{ ids: string[] }>(payload).ids.map((id) => `/fixture/models/${id}`), kept: [] }))

  // Jobs
  h.set(Ipc.jobList, (_, { state }) => state.jobs)
  h.set(Ipc.jobGet, (payload, { state }) => state.jobs.find((job) => job.id === p<{ id: string }>(payload).id) ?? null)
  h.set(Ipc.jobCancel, (payload, { state }) => {
    const { id } = p<{ id: string }>(payload)
    const job = state.jobs.find((item) => item.id === id)
    if (!job) return null
    const canceled: JobRecord = { ...job, state: 'canceled', endedAt: FIXTURE_NOW }
    state.jobs = state.jobs.map((item) => item.id === id ? canceled : item)
    return canceled
  })
  h.set(Ipc.jobInput, () => null)
  h.set(Ipc.jobLogs, (payload, { state }) => state.jobLogs[p<{ id: string }>(payload).id] ?? [])

  // Diagnostics
  h.set(Ipc.diagnosticsList, (_, { state }) => state.diagnostics)
  h.set(Ipc.diagnosticsDismiss, (payload, { state }) => {
    state.diagnostics = state.diagnostics.filter((item) => item.id !== p<{ id: string }>(payload).id)
    return null
  })
  h.set(Ipc.diagnosticsClear, (_, { state }) => { state.diagnostics = []; return null })

  // Devices, GPU, launch queue
  h.set(Ipc.devicesList, (_, { state }) => state.devices)
  h.set(Ipc.gpuInventory, (_, { state }) => state.gpuInventory)
  h.set(Ipc.gpuInventoryRefresh, (_, { state }) => state.gpuInventory)
  h.set(Ipc.launchQueueList, (_, { state }) => state.launchRows)
  h.set(Ipc.launchQueueUpsert, (payload, { state }) => {
    const row = payload as LaunchRow
    state.launchRows = [row, ...state.launchRows.filter((item) => item.id !== row.id)]
    return row
  })
  h.set(Ipc.launchQueueRemove, (payload, { state }) => {
    state.launchRows = state.launchRows.filter((item) => item.id !== p<{ id: string }>(payload).id)
    return null
  })

  // Engine
  h.set(Ipc.engineStatus, (_, { state }) => state.engineReadiness)
  h.set(Ipc.engineVersions, (_, { state }) => state.engineVersions)
  h.set(Ipc.engineVersionSelect, (payload, { state }) => {
    const { id } = p<{ id: string }>(payload)
    const selected = state.engineVersions.find((version) => version.id === id)
    if (!selected) throw new MockIpcError('E_NOT_FOUND', `引擎版本 ${id} 不存在`)
    state.engineVersions = state.engineVersions.map((version) => ({ ...version, current: version.id === id }))
    state.engineReadiness = { ...state.engineReadiness, state: 'ready', path: selected.path }
    return null
  })
  h.set(Ipc.engineVersionRemove, (payload, { state }) => {
    const { id } = p<{ id: string }>(payload)
    state.engineVersions = state.engineVersions.filter((version) => version.id !== id)
    if (!state.engineVersions.some((version) => version.current)) state.engineReadiness = { state: 'missing', path: null }
    return null
  })
  h.set(Ipc.mossInferDownloadState, (_, { state }) => state.engineDownload)
  h.set(Ipc.mossInferDownload, (payload, { state }) => {
    const input = p<{ channel?: 'stable' | 'dev' }>(payload)
    state.engineDownload = { channel: input.channel ?? 'stable', phase: 'querying', bytes: 0, totalBytes: 0, percent: 0, speedBps: 0, updatedAt: FIXTURE_NOW }
    return state.engineDownload
  })
  h.set(Ipc.mossInferDownloadCancel, (_, { state }) => {
    if (state.engineDownload) state.engineDownload = { ...state.engineDownload, phase: 'canceled' }
    return state.engineDownload
  })
  h.set(Ipc.engineRemoteStatus, () => ({ online: true, available: false, path: '/fixture/engine/bin/moss-server', root: '/fixture/engine', gpu: 'Fixture GPU', checkedAt: '' }))
  h.set(Ipc.engineSystemCuda, () => ({ supported: false, gpu: 'Fixture GPU', cublasLt: [], preferredFlavour: 'cu13', error: 'Fixture missing CUDA' }))

  h.set(Ipc.mossInferReleases, (_, { state }) => state.engineReleases)
  // Same shape as main's probeLocalEngine(): the hello plus one GPU verdict per inventory device.
  h.set(Ipc.engineProbe, (_, { state }) => {
    if (state.engineReadiness.state !== 'ready') throw new MockIpcError('E_ENGINE_MISSING', '未找到 moss-server；请下载引擎或设置路径')
    const version = state.engineVersions.find((item) => item.current)?.name ?? 'v2.1.1'
    const hello: EngineHello = { protocol: 2, server: 'moss-server', version, capabilities: {}, values: {}, raw: {} }
    const gpuCompatibility: EngineGpuProbeSnapshot = {
      enginePath: state.engineReadiness.path ?? ENGINE_PATH,
      engineVersion: version,
      checkedAt: FIXTURE_NOW,
      devices: state.gpuInventory.devices.map((device) => ({ uuid: device.uuid, index: device.index, name: device.name, status: 'supported', freeMemoryBytes: device.memoryFreeBytes })),
    }
    return { hello, gpuCompatibility }
  })

  // LAN web access follows the feature switch.
  h.set(Ipc.webAccessInfo, (_, { state }): WebAccessInfo => state.settings.lanWebEnabled
    ? { ready: true, urls: ['http://192.168.1.20:7860/?token=fixture'], token: 'fixture', port: 7860, instanceId: 'fixture' }
    : { ready: false, urls: [], token: null, port: null, instanceId: null })

  // Trainer: the local host always, SSH hosts only while remote hosts are enabled.
  h.set(Ipc.trainerHosts, (_, { state }): TrainingHost[] => [
    { ...localHostFixture(), versions: state.trainerVersions.filter((version) => version.hostId === 'local') },
    ...(state.settings.remoteHostsEnabled
      ? state.hosts.map((host) => ({ ...host, versions: state.trainerVersions.filter((version) => version.hostId === host.id) }))
      : []),
  ])
  h.set(Ipc.trainerAllVersions, (_, { state }) => state.trainerVersions)

  // Hosts
  h.set(Ipc.hostsList, (_, { state }) => state.hosts)
  h.set(Ipc.hostsSave, (payload, { state, emit }) => {
    const { password, ...config } = p<Partial<ManagedHost> & { password?: string }>(payload)
    const host = { status: 'unchecked', devices: [], ...config, id: config.id ?? 'fixture-ssh', kind: 'ssh', hasPassword: config.authMethod === 'password' && Boolean(password) } as ManagedHost
    state.hosts = [...state.hosts.filter((item) => item.id !== host.id), host]
    emit(Events.hostsChanged, state.hosts)
    return host
  })
  h.set(Ipc.hostsRemove, (payload, { state, emit }) => {
    state.hosts = state.hosts.filter((item) => item.id !== p<{ id: string }>(payload).id)
    emit(Events.hostsChanged, state.hosts)
    return null
  })
  h.set(Ipc.hostsTest, (payload, { state }) => {
    const host = state.hosts.find((item) => item.id === p<{ id: string }>(payload).id) ?? state.hosts[0]
    if (!host) throw new MockIpcError('E_NOT_FOUND', '主机不存在')
    return { ...host, status: 'ok', lastCheckedAt: FIXTURE_NOW }
  })
  h.set(Ipc.onboardingStatus, (payload, { state }) => onboardingStatus(state, p<{ hostId?: string }>(payload).hostId ?? 'local'))

  // Gallery
  h.set(Ipc.galleryList, (payload, { state }) => {
    const { cursor, limit = 60, query, projectId, since } = p<{ cursor?: string | null; limit?: number; query?: string; projectId?: string; since?: number }>(payload)
    const needle = query?.trim().toLowerCase()
    const matching = state.gallery.filter((item) =>
      (!projectId || item.projectId === projectId) &&
      (since === undefined || item.mtime >= since) &&
      (!needle || item.name.toLowerCase().includes(needle) || Boolean(item.prompt?.toLowerCase().includes(needle))))
    const start = cursor ? Number(cursor) : 0
    const items = matching.slice(start, start + limit)
    const next = start + items.length
    return { items, nextCursor: next < matching.length ? String(next) : null, total: matching.length, scannedAt: FIXTURE_NOW }
  })
  h.set(Ipc.galleryItem, (payload, { state }) => {
    const { id, path } = p<{ id?: string; path?: string }>(payload)
    return state.gallery.find((item) => (path ? item.path === path : item.id === id)) ?? null
  })
  h.set(Ipc.galleryTrash, (payload, { state }) => {
    const { path } = p<{ path: string }>(payload)
    if (!state.gallery.some((item) => item.path === path)) throw new MockIpcError('E_NOT_FOUND', '这张图片不在作品目录中，无法删除')
    state.gallery = state.gallery.filter((item) => item.path !== path)
    return { trashed: [path] }
  })

  // Studio inputs: engine features, imported pictures, painted masks, control adapters
  // Like main: an SSH host gets uploaded image inputs, but no control adapters or live previews yet.
  h.set(Ipc.engineFeatures, (payload, { state }) => {
    const { hostId } = p<{ deviceUuid?: string; hostId?: string }>(payload)
    if (!state.engineFeatures || !hostId) return state.engineFeatures
    return { ...state.engineFeatures, control: false, preview: false }
  })
  h.set(Ipc.studioImportImage, (payload) => {
    const { projectId, path, bytes, name: given } = p<{ projectId: string; path?: string; bytes?: Uint8Array; name?: string }>(payload)
    if (!path && !bytes) throw new MockIpcError('BAD_REQUEST', '需要图片路径或图片内容（二选一）')
    const name = path ? path.split(/[\\/]/).pop() ?? 'image.png' : given ?? 'pasted.png'
    return { path: `/fixture/projects/${projectId}/assets/${name}`, width: 1024, height: 1024 }
  })
  h.set(Ipc.studioSaveMask, (payload) => {
    const { projectId, canvasId } = p<{ projectId: string; canvasId: string }>(payload)
    return { path: `/fixture/projects/${projectId}/assets/mask-${canvasId}.png` }
  })
  h.set(Ipc.controlAdaptersList, (_, { state }) => state.controlAdapters)
  h.set(Ipc.controlAdaptersAdd, (payload, { state, emit }) => {
    const { path } = p<{ path: string }>(payload)
    if (!/\.safetensors$/i.test(path)) throw new MockIpcError('E_NOT_CONTROL_ADAPTER', '这个文件不是控制适配器')
    const name = path.split(/[\\/]/).pop()!
    const entry = controlAdapterFixture({ id: `control-${state.controlAdapters.length + 1}`, name, path })
    state.controlAdapters = [...state.controlAdapters.filter((item) => item.path !== path), entry]
    emit(Events.modelsChanged, null)
    return entry
  })
  h.set(Ipc.controlAdaptersRemove, (payload, { state, emit }) => {
    const { id } = p<{ id: string }>(payload)
    state.controlAdapters = state.controlAdapters.filter((item) => item.id !== id)
    emit(Events.modelsChanged, null)
    return null
  })

  // The Studio submits generations over HTTP; every request field (image inputs included) lands in job.params.
  let submitted = 0
  h.set(ENGINE_JOBS_CHANNEL, (payload, { state, emit }) => {
    submitted += 1
    const job = submittedJobFixture(p<Record<string, unknown>>(payload), `job-e2e-${submitted}`)
    state.jobs = [job, ...state.jobs]
    emit(Events.job, job)
    return job
  })

  // Projects
  h.set(Ipc.projectsList, (_, { state }) => state.projects.map(projectSummary))
  h.set(Ipc.projectGet, (payload, { state }) => state.projects.find((project) => project.id === p<{ id: string }>(payload).id) ?? null)
  h.set(Ipc.projectSave, (payload, { state }) => {
    const input = payload as Omit<ProjectDocument, 'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
    const existing = state.projects.find((project) => project.id === input.id)
    const project: ProjectDocument = {
      ...input, schemaVersion: 3, id: input.id ?? `project-${state.projects.length + 1}`,
      createdAt: existing?.createdAt ?? FIXTURE_NOW, updatedAt: FIXTURE_NOW,
    }
    state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)]
    return project
  })
  h.set(Ipc.projectDelete, (payload, { state }) => {
    state.projects = state.projects.filter((project) => project.id !== p<{ id: string }>(payload).id)
    return null
  })

  // AI
  h.set(Ipc.aiProvidersList, (_, { state }) => state.aiProviders)
  h.set(Ipc.aiConversations, (_, { state }) => state.conversations)
  h.set(Ipc.aiChat, (payload, { state }) => {
    const input = p<AiChatInput>(payload)
    const previous = state.conversations.find((item) => item.id === input.conversationId)
    const messages: AiMessage[] = [
      ...(previous?.messages ?? []),
      { id: `user-${Date.now()}`, role: 'user', content: input.message ?? '', createdAt: FIXTURE_NOW },
      { id: `reply-${Date.now()}`, role: 'assistant', content: 'Fixture reply', createdAt: FIXTURE_NOW },
    ]
    const conversation: AiConversationInfo = {
      id: previous?.id ?? 'fixture-chat', title: previous?.title ?? 'Fixture chat', providerId: input.providerId,
      messages, createdAt: previous?.createdAt ?? FIXTURE_NOW, updatedAt: FIXTURE_NOW,
    }
    state.conversations = [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)]
    return { reply: 'Fixture reply', conversation }
  })
  h.set(Ipc.aiToolResult, () => null)

  // Shell integrations: accepted and recorded via `calls`.
  for (const channel of [Ipc.windowOpen, Ipc.openPath, Ipc.openExternal, Ipc.copyText, Ipc.galleryReveal]) h.set(channel, () => null)
  h.set(Ipc.pickDialog, () => null)
  addInstallHandlers((channel, handler) => h.set(channel, handler), (code, message) => new MockIpcError(code, message))
  return h
}

export function createMockBackend(
  initial: ScenarioName | MockBackendState = 'ready',
  options: MockBackendOptions = {},
): MockBackend {
  let handlers = defaultHandlers()
  const overrides = new Map<string, Handler>()
  const failures = new Map<string, { error: IpcError; times: number }>()
  const holds = new Map<string, Array<{ arrive: () => void; gate: Promise<{ data?: unknown; error?: IpcError; useHandler: boolean }> }>>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const calls: Array<{ channel: string; payload: unknown }> = []
  const unhandled: string[] = []

  const backend: MockBackend = {
    state: typeof initial === 'string' ? scenario(initial) : initial,
    calls,
    unhandled,
    bridge: {
      platform: options.bridge?.platform ?? 'win32',
      version: options.bridge?.version ?? '44.9.0',
      acrylic: options.bridge?.acrylic ?? false,
      windowKind: options.bridge?.windowKind ?? 'launcher',
      channel: options.bridge?.channel ?? 'dev',
      on(channel, callback) {
        const set = listeners.get(channel) ?? new Set()
        set.add(callback)
        listeners.set(channel, set)
        return () => { set.delete(callback) }
      },
      async invoke<T>(channel: string, payload?: unknown): Promise<T> {
        calls.push({ channel, payload: payload === undefined ? undefined : deepClone(payload) })
        const respond = async (): Promise<IpcResult<unknown>> => {
          const queue = holds.get(channel)
          if (queue?.length) {
            const held = queue.shift()!
            held.arrive()
            const outcome = await held.gate
            if (outcome.error) return { ok: false, error: outcome.error }
            if (!outcome.useHandler) return { ok: true, data: outcome.data }
          }
          const failure = failures.get(channel)
          if (failure) {
            failure.times -= 1
            if (failure.times <= 0) failures.delete(channel)
            return { ok: false, error: failure.error }
          }
          const handler = overrides.get(channel) ?? handlers.get(channel)
          if (!handler) {
            unhandled.push(channel)
            if (options.fallback === 'empty') {
              return { ok: true, data: channel === Ipc.appInfo || channel === Ipc.envScan ? null : [] }
            }
            return { ok: false, error: { code: 'E_MOCK_UNHANDLED', message: `mock backend has no handler for ${channel}` } }
          }
          try {
            const data = await handler(payload, { state: backend.state, emit: backend.emit })
            return { ok: true, data: data === undefined ? null : deepClone(data) }
          } catch (error) {
            const code = error instanceof MockIpcError ? error.code : 'E_MOCK'
            return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
          }
        }
        return (await respond()) as T
      },
    },
    callsTo(channel) {
      return calls.filter((item) => item.channel === channel).map((item) => item.payload)
    },
    handle(channel, handler) {
      overrides.set(channel, handler)
    },
    fail(channel, error = {}, { times = Number.POSITIVE_INFINITY } = {}) {
      failures.set(channel, { error: { code: error.code ?? 'E_MOCK_FAIL', message: error.message ?? `${channel} failed` }, times })
    },
    hold(channel) {
      let arrive!: () => void
      let open!: (value: { data?: unknown; error?: IpcError; useHandler: boolean }) => void
      const called = new Promise<void>((resolve) => { arrive = resolve })
      const gate = new Promise<{ data?: unknown; error?: IpcError; useHandler: boolean }>((resolve) => { open = resolve })
      const queue = holds.get(channel) ?? []
      queue.push({ arrive, gate })
      holds.set(channel, queue)
      const settle = async (): Promise<void> => {
        // Let the awaiting `call()` continuation run before the test continues.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return {
        channel,
        get payload() { return calls.filter((item) => item.channel === channel).at(-1)?.payload },
        called,
        async release(...args: [unknown?]) {
          open(args.length ? { data: args[0], useHandler: false } : { useHandler: true })
          await settle()
        },
        async reject(error = {}) {
          open({ useHandler: false, error: { code: error.code ?? 'E_MOCK_FAIL', message: error.message ?? `${channel} failed` } })
          await settle()
        },
      }
    },
    emit(event, data) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(deepClone(data))
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    playJob(job, playOptions = {}) {
      const sequence = jobLifecycle(job, playOptions)
      for (const step of sequence) {
        backend.state.jobs = [step, ...backend.state.jobs.filter((item) => item.id !== step.id)]
        backend.emit(Events.job, step)
      }
      return sequence
    },
    playDownload(task, playOptions = {}) {
      const half = Math.floor(task.totalBytes / 2)
      const sequence: DownloadTask[] = [
        { ...task, state: 'running', bytes: half, filesDone: Math.floor(task.filesTotal / 2), speedBps: 50_000_000 },
        playOptions.error
          ? { ...task, state: 'error', bytes: half, error: playOptions.error, speedBps: 0 }
          : { ...task, state: 'verifying', bytes: task.totalBytes, filesDone: task.filesTotal, speedBps: 0 },
      ]
      if (!playOptions.error) sequence.push({ ...task, state: 'done', bytes: task.totalBytes, filesDone: task.filesTotal, speedBps: 0 })
      for (const step of sequence) {
        backend.state.downloads = backend.state.downloads.some((item) => item.id === step.id)
          ? backend.state.downloads.map((item) => item.id === step.id ? step : item)
          : [...backend.state.downloads, step]
        if (step.state === 'done') {
          const catalog = backend.state.catalog
          backend.state.catalog = step.kind === 'model'
            ? { ...catalog, models: catalog.models.map((model) => model.id === step.targetId ? { ...model, installed: true, installState: 'ready', installedBytes: model.sizeBytes } : model) }
            : { ...catalog, adapters: catalog.adapters.map((adapter) => adapter.id === step.targetId ? { ...adapter, installed: true, installedBytes: adapter.sizeBytes } : adapter) }
        }
        backend.emit(Events.download, step)
      }
      return sequence
    },
    install(target = globalThis.window as unknown as { clover?: CloverBridge }) {
      const previous = target.clover
      target.clover = backend.bridge
      return () => { target.clover = previous }
    },
    reset(next = 'ready') {
      backend.state = typeof next === 'string' ? scenario(next) : next
      handlers = defaultHandlers()
      overrides.clear()
      failures.clear()
      holds.clear()
      listeners.clear()
      calls.length = 0
      unhandled.length = 0
    },
  }
  return backend
}
