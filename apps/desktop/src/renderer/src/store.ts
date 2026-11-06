import { create } from 'zustand'
import { Events, Ipc } from '@shared/channels'
import type {
  AdapterEntry,
  AppNotification,
  Catalog,
  Diagnostic,
  DownloadTask,
  EngineReadiness,
  EnvReport,
  GalleryItem,
  GpuTelemetrySnapshot,
  InstanceInfo,
  JobLogLine,
  JobRecord,
  MossInferDownloadState,
  LaunchCase,
  LaunchDevice,
  LaunchRow,
  LaunchStartInput,
  Settings,
} from '@shared/types'
import type { UpdateChannel } from '@shared/install'
import { requiredUpdateMessage, type UpdateBusyReason, type UpdateRestartResult, type UpdaterState } from '@shared/update'
import { isStudioReuseRequest, type StudioReuseRequest } from './lib/studioReuse'
import { call, onEvent } from './lib/api'

export type { StudioReuseRequest } from './lib/studioReuse'

export function resolveTheme(theme: Settings['theme'] | undefined): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyAppearance(settings: Settings): void {
  document.documentElement.dataset.theme = resolveTheme(settings.theme)
  document.documentElement.dataset.uiAnimation = settings.uiAnimation ?? 'system'
}

interface RuntimeLogEvent {
  runtimeId: string
  instanceId: string
  line: string
  stream: 'stdout' | 'stderr'
  at: string
}

interface AppStore {
  ready: boolean
  loading: boolean
  settings: Settings | null
  env: EnvReport | null
  /** The app update runtime (main/update), pushed on every change. */
  update: UpdaterState | null
  /** The title bar update popover; Settings opens it to ask about a busy restart. */
  updatePopoverOpen: boolean
  /** What the last restart attempt said it would interrupt. */
  updateBusy: UpdateBusyReason[]
  mossInferDownload: MossInferDownloadState | null
  engineReadiness: EngineReadiness | null
  instances: InstanceInfo[]
  catalog: Catalog | null
  downloads: DownloadTask[]
  jobs: JobRecord[]
  activeJobId: string | null
  jobLogs: Record<string, JobLogLine[]>
  diagnostics: Diagnostic[]
  devices: LaunchDevice[]
  gpuTelemetry: GpuTelemetrySnapshot | null
  cases: LaunchCase[]
  launchRows: LaunchRow[]
  notifications: AppNotification[]
  notificationsOpen: boolean
  studioBackground: GalleryItem | null
  /**
   * Library → Studio handoff for "在创作中复用": open a NEW canvas with these
   * parameters. Set by `requestStudioReuse`, consumed once by Studio through
   * `takeStudioReuseRequest`. See lib/studioReuse.ts for the shape.
   */
  studioReuseRequest: StudioReuseRequest | null
  scanning: boolean
  scanSection: string | null
  gitMessage: string | null
  runtimeLogs: Record<string, string[]>
  error: string | null
  init: () => Promise<void>
  refreshEnv: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshUpdate: () => Promise<void>
  setUpdatePopoverOpen: (open: boolean) => void
  /** Check the feed now; null when the call itself failed. */
  checkForUpdates: () => Promise<UpdaterState | null>
  downloadUpdate: () => Promise<void>
  cancelUpdateDownload: () => Promise<void>
  /** Restart into the downloaded version, or learn what a restart would interrupt. */
  restartToUpdate: () => Promise<UpdateRestartResult>
  /** 空闲后自动重启 on or off. */
  setRestartWhenIdle: (enabled: boolean) => Promise<void>
  /** 回到上一个版本: switch back and restart. */
  rollbackUpdate: () => Promise<UpdateRestartResult>
  setUpdateChannel: (channel: UpdateChannel) => Promise<void>
  setAutoDownloadUpdates: (enabled: boolean) => Promise<void>
  /** Offer the version skipped by a rollback again (安装 <v>). */
  unskipUpdate: () => Promise<void>
  saveSettings: (patch: Partial<Settings> & { hfToken?: string | null }) => Promise<void>
  toggleSidebar: () => Promise<void>
  toggleNotifications: () => void
  setNotificationsOpen: (open: boolean) => void
  pushNotification: (input: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => void
  setMossInferDownload: (state: MossInferDownloadState | null) => void
  markAllNotificationsRead: () => void
  setStudioBackground: (item: GalleryItem | null) => void
  /** Ask Studio to open a new canvas prefilled from an image (replaces any pending request). */
  requestStudioReuse: (request: StudioReuseRequest) => void
  /** Returns the pending reuse request once and clears it; null when there is none or it is malformed. */
  takeStudioReuseRequest: () => StudioReuseRequest | null
  dismissAnnouncement: (id: string) => Promise<void>
  downloadModel: (modelId: string) => Promise<void>
  downloadAdapter: (adapterId: string) => Promise<void>
  /** Queue every missing file of a whole model (catalog bundle) on this machine. */
  downloadBundle: (bundleId: string) => Promise<DownloadTask[]>
  /** Pick one or more local .safetensors files and register them as LoRAs. */
  importAdapters: () => Promise<AdapterEntry[]>
  pauseDownload: (taskId: string) => Promise<void>
  cancelDownload: (taskId: string) => Promise<void>
  deleteModel: (kind: 'model' | 'adapter', id: string) => Promise<void>
  refreshJobs: () => Promise<void>
  cancelJob: (id: string) => Promise<void>
  sendJobInput: (id: string, text: string) => Promise<void>
  setActiveJob: (id: string | null) => void
  loadJobLogs: (id: string) => Promise<void>
  refreshDiagnostics: () => Promise<void>
  dismissDiagnostic: (id: string) => Promise<void>
  clearDiagnostics: () => Promise<void>
  refreshDevices: () => Promise<void>
  refreshEngineReadiness: () => Promise<EngineReadiness | null>
  startLaunch: (input: LaunchStartInput) => Promise<LaunchRow>
  stopLaunch: (rowId: string) => Promise<void>
  startNextQueued: (deviceId: string) => Promise<void>
}

let subscribed = false

function upsertLaunch(list: LaunchRow[], row: LaunchRow): LaunchRow[] {
  return [row, ...list.filter((item) => item.id !== row.id)]
}

function persistLaunchRow(row: LaunchRow): void {
  void call(Ipc.launchQueueUpsert, row).catch(() => undefined)
}

function upsertJob(list: JobRecord[], job: JobRecord): JobRecord[] {
  return [job, ...list.filter((item) => item.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function upsertDiagnostic(list: Diagnostic[], diagnostic: Diagnostic): Diagnostic[] {
  return [diagnostic, ...list.filter((item) => item.id !== diagnostic.id)].slice(0, 200)
}

function upsertDownload(list: DownloadTask[], task: DownloadTask): DownloadTask[] {
  // Progress and state updates must not move existing rows in the queue.
  if (list.some((item) => item.id === task.id)) {
    return list.map((item) => item.id === task.id ? task : item)
  }
  return [...list, task]
}

function withEngineDownload(
  readiness: EngineReadiness | null,
  download: MossInferDownloadState | null,
): EngineReadiness | null {
  if (!readiness) return null
  const installing = download && !['done', 'error', 'canceled'].includes(download.phase)
    ? { phase: download.phase, percent: download.percent, version: download.version }
    : undefined
  return { ...readiness, installing }
}

export const useApp = create<AppStore>((set, get) => {
  const startupDownloads = new Map<string, DownloadTask>()
  /**
   * Events that arrive while init's snapshots are in flight are newer than those
   * snapshots (one slow call, e.g. envScan, holds them all back). Keep them so the
   * snapshot cannot overwrite them: whole-state slices by a per-slice event count,
   * list slices by the items the events delivered.
   */
  const startupJobs = new Map<string, JobRecord>()
  const startupDiagnostics = new Map<string, Diagnostic>()
  const eventCounts = { update: 0, mossInferDownload: 0 }
  /** Versions, steps and announcement ids already surfaced, so repeated pushes stay quiet. */
  const announced = new Set<string>()
  const announcedAnnouncements = new Set<string>()

  function once(key: string): boolean {
    if (announced.has(key)) return false
    announced.add(key)
    return true
  }

  /**
   * Turn an update state into notifications: a new version, a downloaded one
   * ready for a restart, a required update, and the feed's announcements.
   * Called for the first state and for every push, each signal once.
   */
  function announceUpdate(state: UpdaterState): void {
    const version = state.available?.version ?? state.pending
    if (state.supported && state.phase === 'available' && version && once(`available:${version}`)) {
      get().pushNotification({
        tone: 'info',
        title: '发现新版本',
        message: state.autoDownload ? `MossStudio ${version} 正在后台下载` : `MossStudio ${version} 可以更新，点击标题栏的更新按钮下载`,
      })
    }
    if (state.supported && state.phase === 'ready' && version && once(`ready:${version}`)) {
      get().pushNotification({ tone: 'success', title: '更新已准备好', message: `重启 MossStudio 即可更新到 ${version}` })
    }
    if (state.required && state.minimumVersion && once(`required:${state.minimumVersion}`)) {
      get().pushNotification({ tone: 'warning', title: '必须更新', message: requiredUpdateMessage(state.minimumVersion) })
    }
    if (state.phase === 'error' && state.error && once(`error:${state.error}`)) {
      get().pushNotification({ tone: 'error', title: '更新没有完成', message: state.error })
    }
    for (const announcement of state.announcements.slice(0, 3)) {
      if (announcedAnnouncements.has(announcement.id)) continue
      announcedAnnouncements.add(announcement.id)
      get().pushNotification({
        tone: announcement.level === 'critical' ? 'error' : announcement.level === 'warning' ? 'warning' : 'info',
        title: announcement.title,
        message:
          announcement.body
            .replace(/[#>*_`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180) || '打开通知面板查看公告详情。',
      })
    }
  }

  function setUpdate(state: UpdaterState): UpdaterState {
    set({ update: state })
    announceUpdate(state)
    return state
  }

  /** The snapshot list with every item an event delivered during startup put over it. */
  function mergeStartup<T extends { id: string }>(snapshot: T[], fromEvents: Map<string, T>, upsert: (list: T[], item: T) => T[]): T[] {
    return [...fromEvents.values()].reduce(upsert, snapshot.filter((item) => !fromEvents.has(item.id)))
  }

  function mergeDownloadSnapshot(snapshot: DownloadTask[]): DownloadTask[] {
    const tasks = new Map(snapshot.map((task) => [task.id, task]))
    for (const task of startupDownloads.values()) tasks.set(task.id, task)
    return [...tasks.values()].filter((task) => task.state !== 'canceled')
  }

  function subscribe(): void {
    if (subscribed) return
    subscribed = true

    onEvent<UpdaterState>(Events.updateState, (state) => {
      eventCounts.update += 1
      setUpdate(state)
    })
    onEvent<DownloadTask>(Events.download, (task) => {
      if (!get().ready) startupDownloads.set(task.id, task)
      const previous = get().downloads.find((item) => item.id === task.id)
      if (task.state === 'canceled') {
        set((state) => ({ downloads: state.downloads.filter((item) => item.id !== task.id) }))
        return
      }
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
      if (task.state === 'done' && previous?.state !== 'done') {
        void get().refreshCatalog()
        get().pushNotification({
          tone: 'success',
          title: '下载完成',
          message: task.hostId ? `${task.label} 已下载到 ${task.hostName ?? task.hostId}` : `${task.label} 已写入本地缓存`,
        })
      } else if (task.state === 'error' && previous?.state !== 'error') {
        get().pushNotification({
          tone: 'error',
          title: '下载失败',
          message: task.error ?? task.label,
        })
      }
    })
    onEvent<JobRecord>(Events.job, (job) => {
      if (!get().ready) startupJobs.set(job.id, job)
      const previous = get().jobs.find((item) => item.id === job.id)
      set((state) => ({
        jobs: upsertJob(state.jobs, job),
        activeJobId: state.activeJobId ?? job.id,
      }))
      const launchRow = get().launchRows.find((row) => row.jobId === job.id)
      if (launchRow) {
        const nextState =
          job.state === 'succeeded' || job.state === 'canceled'
            ? 'stopped'
            : job.state === 'failed'
              ? 'failed'
              : job.state === 'starting'
                ? 'starting'
                : 'running'
        const nextRow = { ...launchRow, state: nextState as LaunchRow['state'], error: job.error?.message ?? launchRow.error }
        set((state) => ({
          launchRows: state.launchRows.map((row) => (row.id === launchRow.id ? nextRow : row)),
        }))
        persistLaunchRow(nextRow)
        if (nextState === 'stopped' || nextState === 'failed') {
          setTimeout(() => {
            void get().startNextQueued(launchRow.deviceId)
          }, 150)
        }
      }

      if (job.state === 'succeeded' && previous?.state !== 'succeeded') {
        get().pushNotification({
          tone: 'success',
          title: '生成完成',
          message: `${job.instanceName} · ${job.params.width}×${job.params.height}`,
        })
      } else if (job.state === 'failed' && previous?.state !== 'failed') {
        get().pushNotification({
          tone: 'error',
          title: '任务失败',
          message: job.error?.message ?? '查看诊断页了解原因',
        })
      }
    })

    onEvent<JobLogLine>(Events.jobLog, (line) => {
      set((state) => {
        const previous = state.jobLogs[line.jobId] ?? []
        return {
          jobLogs: {
            ...state.jobLogs,
            [line.jobId]: [...previous.slice(-1499), line],
          },
        }
      })
    })

    onEvent<Diagnostic>(Events.diagnostic, (diagnostic) => {
      if (!get().ready) startupDiagnostics.set(diagnostic.id, diagnostic)
      set((state) => ({ diagnostics: upsertDiagnostic(state.diagnostics, diagnostic) }))
    })
    onEvent<GpuTelemetrySnapshot>(Events.gpuTelemetry, (gpuTelemetry) => {
      set({ gpuTelemetry })
    })

    onEvent<Settings>(Events.settingsChanged, (settings) => {
      applyAppearance(settings)
      set({ settings })
      void get().refreshEngineReadiness()
    })
    onEvent<MossInferDownloadState>(Events.mossInferDownload, (download) => {
      eventCounts.mossInferDownload += 1
      const previous = get().mossInferDownload
      set((state) => ({
        mossInferDownload: download,
        engineReadiness: withEngineDownload(state.engineReadiness, download),
      }))
      if (download.phase === 'done' && previous?.phase !== 'done') {
        void get().refreshEngineReadiness().then(() => {
          get().pushNotification({
            tone: 'success',
            title: 'MossInfer 引擎已就绪',
            message: download.version ? `${download.version} 已安装并设为当前版本` : '引擎已安装并设为当前版本',
          })
        })
      } else if (download.phase === 'error' && previous?.phase !== 'error') {
        void get().refreshEngineReadiness().then((readiness) => {
          const currentReady = (readiness ?? get().engineReadiness)?.state === 'ready'
          get().pushNotification({
            tone: currentReady ? 'warning' : 'error',
            title: currentReady ? 'MossInfer 引擎更新失败' : 'MossInfer 引擎安装失败',
            message: currentReady
              ? `当前引擎仍可用 · ${download.error ?? '上次更新未完成'}`
              : download.error ?? '查看引擎页的安装状态了解详情',
          })
        })
      } else if (download.phase === 'canceled' && previous?.phase !== 'canceled') {
        void get().refreshEngineReadiness()
        get().pushNotification({
          tone: 'warning',
          title: 'MossInfer 引擎安装已取消',
          message: download.version ?? '安装任务已停止',
        })
      }
    })
    onEvent<{ section: string }>(Events.envProgress, (event) => {
      set({ scanSection: event.section })
    })
    onEvent<{ message: string }>(Events.gitProgress, (event) => {
      set({ gitMessage: event.message })
    })
    onEvent<RuntimeLogEvent>(Events.runtimeLog, (event) => {
      set((state) => {
        const previous = state.runtimeLogs[event.instanceId] ?? []
        const line = `${new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}  ${event.line}`
        return {
          runtimeLogs: {
            ...state.runtimeLogs,
            [event.instanceId]: [...previous.slice(-499), line],
          },
        }
      })
    })

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const settings = get().settings
      if (settings) applyAppearance(settings)
    })
  }

  return {
    ready: false,
    loading: false,
    settings: null,
    env: null,
    update: null,
    updatePopoverOpen: false,
    updateBusy: [],
    mossInferDownload: null,
    engineReadiness: null,
    instances: [],
    catalog: null,
    downloads: [],
    jobs: [],
    activeJobId: null,
    jobLogs: {},
    diagnostics: [],
    devices: [],
    gpuTelemetry: null,
    cases: [],
    launchRows: [],
    notifications: [],
    notificationsOpen: false,
    studioBackground: null,
    studioReuseRequest: null,
    scanning: false,
    scanSection: null,
    gitMessage: null,
    runtimeLogs: {},
    error: null,

    async init() {
      if (get().ready || get().loading) return
      set({ loading: true, error: null })
      try {
        document.documentElement.dataset.acrylic = String(window.clover.acrylic)
        const settings = await call<Settings>(Ipc.settingsGet)
        applyAppearance(settings)
        set({ settings })
        subscribe()

        const before = { ...eventCounts }
        const [env, update, catalog, downloads, jobs, diagnostics, devices, queuedRows, engineDownload, readiness] =
          await Promise.allSettled([
            call<EnvReport>(Ipc.envScan),
            call<UpdaterState>(Ipc.updateState),
            call<Catalog>(Ipc.modelsCatalog),
            call<DownloadTask[]>(Ipc.downloadsList),
            call<JobRecord[]>(Ipc.jobList),
            call<Diagnostic[]>(Ipc.diagnosticsList),
            call<LaunchDevice[]>(Ipc.devicesList),
            call<LaunchRow[]>(Ipc.launchQueueList),
            call<MossInferDownloadState | null>(Ipc.mossInferDownloadState),
            call<EngineReadiness>(Ipc.engineStatus),
          ])
        // An event since the call went out is newer than its answer: keep what the event set.
        const current = get()
        const updateState = eventCounts.update !== before.update
          ? current.update
          : update.status === 'fulfilled' ? update.value : null
        const engineDownloadState = eventCounts.mossInferDownload !== before.mossInferDownload
          ? current.mossInferDownload
          : engineDownload.status === 'fulfilled' ? engineDownload.value : null
        const jobList = mergeStartup(jobs.status === 'fulfilled' ? jobs.value : [], startupJobs, upsertJob)
        set({
          env: env.status === 'fulfilled' ? env.value : null,
          update: updateState,
          catalog: catalog.status === 'fulfilled' ? catalog.value : null,
          downloads: mergeDownloadSnapshot(downloads.status === 'fulfilled' ? downloads.value : []),
          jobs: jobList,
          diagnostics: mergeStartup(diagnostics.status === 'fulfilled' ? diagnostics.value : [], startupDiagnostics, upsertDiagnostic),
          devices: devices.status === 'fulfilled' ? devices.value : [],
          launchRows: queuedRows.status === 'fulfilled' ? queuedRows.value : [],
          mossInferDownload: engineDownloadState,
          engineReadiness: readiness.status === 'fulfilled' ? withEngineDownload(readiness.value, engineDownloadState) : null,
          activeJobId: jobList.find((job) => job.state === 'running' || job.state === 'starting')?.id ?? null,
          ready: true,
        })
        startupDownloads.clear()
        startupJobs.clear()
        startupDiagnostics.clear()
        const queued = queuedRows.status === 'fulfilled' ? queuedRows.value.filter((row) => row.state === 'queued') : []
        for (const deviceId of new Set(queued.map((row) => row.deviceId))) {
          setTimeout(() => {
            void get().startNextQueued(deviceId)
          }, 800)
        }
        if (updateState) announceUpdate(updateState)
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ loading: false })
      }
    },

    async refreshEnv() {
      set({ scanning: true, scanSection: 'system' })
      try {
        const env = await call<EnvReport>(Ipc.envScan)
        set({ env })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ scanning: false, scanSection: null })
      }
    },

    async refreshCatalog() {
      try {
        const catalog = await call<Catalog>(Ipc.modelsCatalog)
        set({ catalog })
      } catch {
        // keep previous
      }
    },

    async refreshUpdate() {
      try {
        setUpdate(await call<UpdaterState>(Ipc.updateState))
      } catch {
        // keep previous
      }
    },

    async checkForUpdates() {
      try {
        return setUpdate(await call<UpdaterState>(Ipc.updateCheck))
      } catch {
        return null
      }
    },

    async downloadUpdate() {
      setUpdate(await call<UpdaterState>(Ipc.updateDownload))
    },

    async cancelUpdateDownload() {
      setUpdate(await call<UpdaterState>(Ipc.updateCancel))
    },

    setUpdatePopoverOpen(open) {
      set(open ? { updatePopoverOpen: true } : { updatePopoverOpen: false, updateBusy: [] })
    },

    async restartToUpdate() {
      const result = await call<UpdateRestartResult>(Ipc.updateRestart)
      // A restart would interrupt work: ask in the popover (空闲后自动重启 / 稍后).
      if (result.status === 'busy') set({ updateBusy: result.busy, updatePopoverOpen: true })
      return result
    },

    async setRestartWhenIdle(enabled) {
      setUpdate(await call<UpdaterState>(Ipc.updateRestartWhenIdle, { enabled }))
      set({ updateBusy: [] })
    },

    async rollbackUpdate() {
      return call<UpdateRestartResult>(Ipc.updateRollback)
    },

    async setUpdateChannel(channel) {
      setUpdate(await call<UpdaterState>(Ipc.updateSetChannel, { channel }))
    },

    async setAutoDownloadUpdates(enabled) {
      setUpdate(await call<UpdaterState>(Ipc.updateSetAutoDownload, { enabled }))
    },

    async unskipUpdate() {
      setUpdate(await call<UpdaterState>(Ipc.updateUnskip))
    },

    async saveSettings(patch) {
      const settings = await call<Settings>(Ipc.settingsUpdate, patch)
      applyAppearance(settings)
      set({ settings })
      void get().refreshEngineReadiness()
    },

    async toggleSidebar() {
      const settings = get().settings
      if (!settings) return
      await get().saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed })
    },

    toggleNotifications() {
      set((state) => ({ notificationsOpen: !state.notificationsOpen }))
    },

    setNotificationsOpen(open) {
      set({ notificationsOpen: open })
    },

    setMossInferDownload(download) {
      set((state) => ({
        mossInferDownload: download,
        engineReadiness: withEngineDownload(state.engineReadiness, download),
      }))
    },

    pushNotification(input) {
      set((state) => ({
        notifications: [
          {
            ...input,
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            read: false,
          },
          ...state.notifications,
        ].slice(0, 50),
      }))
    },

    markAllNotificationsRead() {
      set((state) => ({
        notifications: state.notifications.map((item) => ({ ...item, read: true })),
      }))
    },

    setStudioBackground(item) {
      set({ studioBackground: item })
    },

    requestStudioReuse(request) {
      set({ studioReuseRequest: request })
    },

    takeStudioReuseRequest() {
      const request = get().studioReuseRequest
      if (request === null) return null
      set({ studioReuseRequest: null })
      return isStudioReuseRequest(request) ? request : null
    },

    async dismissAnnouncement(id) {
      await call(Ipc.announcementsDismiss, { id })
      await get().refreshUpdate()
    },

    async downloadModel(modelId) {
      const task = await call<DownloadTask>(Ipc.modelDownload, { kind: 'model', id: modelId })
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
    },

    async downloadAdapter(adapterId) {
      const task = await call<DownloadTask>(Ipc.modelDownload, { kind: 'adapter', id: adapterId })
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
    },

    async downloadBundle(bundleId) {
      const tasks = await call<DownloadTask[]>(Ipc.modelBundleInstall, { id: bundleId })
      set((state) => ({ downloads: tasks.reduce(upsertDownload, state.downloads) }))
      return tasks
    },

    async importAdapters() {
      const result = await call<{ canceled: boolean; adapters: AdapterEntry[] }>(Ipc.modelsImportAdapter)
      if (result.canceled) return []
      await get().refreshCatalog()
      return result.adapters
    },

    async pauseDownload(taskId) {
      await call(Ipc.modelPause, { taskId })
    },

    async cancelDownload(taskId) {
      await call(Ipc.modelCancel, { taskId })
      set((state) => ({ downloads: state.downloads.filter((item) => item.id !== taskId) }))
    },

    async deleteModel(kind, id) {
      await call(Ipc.modelDelete, { kind, id })
      await get().refreshCatalog()
    },

    async refreshJobs() {
      try {
        const jobs = await call<JobRecord[]>(Ipc.jobList)
        set({ jobs })
      } catch {
        // keep previous
      }
    },

    async cancelJob(id) {
      const job = await call<JobRecord | null>(Ipc.jobCancel, { id })
      if (job) {
        set((state) => ({ jobs: upsertJob(state.jobs, job) }))
      }
    },

    async sendJobInput(id, text) {
      await call(Ipc.jobInput, { id, text })
    },

    setActiveJob(id) {
      set({ activeJobId: id })
    },

    async loadJobLogs(id) {
      try {
        const lines = await call<JobLogLine[]>(Ipc.jobLogs, { id })
        set((state) => ({ jobLogs: { ...state.jobLogs, [id]: lines } }))
      } catch {
        // ignore
      }
    },

    async refreshDiagnostics() {
      try {
        const diagnostics = await call<Diagnostic[]>(Ipc.diagnosticsList)
        set({ diagnostics })
      } catch {
        // ignore
      }
    },

    async dismissDiagnostic(id) {
      await call(Ipc.diagnosticsDismiss, { id })
      set((state) => ({ diagnostics: state.diagnostics.filter((item) => item.id !== id) }))
    },

    async clearDiagnostics() {
      await call(Ipc.diagnosticsClear)
      set({ diagnostics: [] })
    },

    async refreshDevices() {
      try {
        set({ devices: await call<LaunchDevice[]>(Ipc.devicesList) })
      } catch {
        // keep previous
      }
    },

    async refreshEngineReadiness() {
      try {
        // main reports what is installed; keep the progress of an install still in flight.
        const readiness = withEngineDownload(await call<EngineReadiness>(Ipc.engineStatus), get().mossInferDownload)
        set({ engineReadiness: readiness })
        return readiness
      } catch {
        return get().engineReadiness
      }
    },

    async startLaunch(_input) {
      throw new Error('MossStudio 是唯一创作入口；请从 Home 或 Studio 打开。')
    },

    async stopLaunch(rowId) {
      const row = get().launchRows.find((item) => item.id === rowId)
      if (!row) return
      if (row.jobId) {
        await call(Ipc.jobCancel, { id: row.jobId })
        const stopped = { ...row, state: 'stopped' as const }
        set((state) => ({
          launchRows: state.launchRows.map((item) => (item.id === row.id ? stopped : item)),
        }))
        persistLaunchRow(stopped)
      } else {
        set((state) => ({ launchRows: state.launchRows.filter((item) => item.id !== row.id) }))
        await call(Ipc.launchQueueRemove, { id: row.id }).catch(() => undefined)
        void get().startNextQueued(row.deviceId)
      }
    },

    async startNextQueued(_deviceId) {
      // Gradio launch queue is retired; MossStudio jobs are submitted directly.
    },

  }
})
