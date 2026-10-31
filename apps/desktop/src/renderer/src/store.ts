import { create } from 'zustand'
import { Events, Ipc } from '@shared/channels'
import type {
  AppNotification,
  Catalog,
  Diagnostic,
  DownloadTask,
  EnvReport,
  GalleryItem,
  InstanceInfo,
  JobLogLine,
  JobRecord,
  MossInferDownloadState,
  LaunchCase,
  LaunchDevice,
  LaunchRow,
  LaunchStartInput,
  OnboardingStatus,
  Settings,
  UpdateState,
} from '@shared/types'
import type { LayoutDraft } from './lib/layout'
import type { UpdateDownloadState } from '@shared/release'
import { call, onEvent } from './lib/api'

function applyAppearance(settings: Settings): void {
  // UI v0.3 is dark-gray only. The setting stays in the schema for migration,
  // but the shell always renders the front-end frosted-glass surface.
  document.documentElement.dataset.theme = 'dark'
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
  updates: UpdateState | null
  updateDialogOpen: boolean
  updateDownload: UpdateDownloadState | null
  mossInferDownload: MossInferDownloadState | null
  instances: InstanceInfo[]
  catalog: Catalog | null
  downloads: DownloadTask[]
  jobs: JobRecord[]
  activeJobId: string | null
  jobLogs: Record<string, JobLogLine[]>
  diagnostics: Diagnostic[]
  devices: LaunchDevice[]
  cases: LaunchCase[]
  launchRows: LaunchRow[]
  onboarding: OnboardingStatus | null
  notifications: AppNotification[]
  notificationsOpen: boolean
  studioPrompt: string
  studioInstanceId: string | null
  studioDraft: LayoutDraft | null
  studioBackground: GalleryItem | null
  scanning: boolean
  scanSection: string | null
  gitMessage: string | null
  runtimeLogs: Record<string, string[]>
  error: string | null
  init: () => Promise<void>
  refreshEnv: () => Promise<void>
  refreshCatalog: () => Promise<void>
  refreshUpdates: () => Promise<void>
  checkForUpdates: () => Promise<UpdateState | null>
  setUpdateDialogOpen: (open: boolean) => void
  startUpdateDownload: () => Promise<void>
  cancelUpdateDownload: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleSidebar: () => Promise<void>
  toggleNotifications: () => void
  setNotificationsOpen: (open: boolean) => void
  pushNotification: (input: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => void
  setMossInferDownload: (state: MossInferDownloadState | null) => void
  markAllNotificationsRead: () => void
  setStudioPrompt: (prompt: string) => void
  setStudioInstanceId: (instanceId: string | null) => void
  setStudioDraft: (draft: LayoutDraft | null) => void
  setStudioBackground: (item: GalleryItem | null) => void
  dismissAnnouncement: (id: string) => Promise<void>
  downloadModel: (modelId: string) => Promise<void>
  downloadAdapter: (adapterId: string) => Promise<void>
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
  refreshOnboarding: () => Promise<void>
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

export const useApp = create<AppStore>((set, get) => {
  function subscribe(): void {
    if (subscribed) return
    subscribed = true

    onEvent<DownloadTask>(Events.download, (task) => {
      if (task.state === 'canceled') {
        set((state) => ({ downloads: state.downloads.filter((item) => item.id !== task.id) }))
        return
      }
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
      if (task.state === 'done') {
        void get().refreshCatalog()
        get().pushNotification({
          tone: 'success',
          title: '下载完成',
          message: `${task.label} 已写入本地缓存`,
        })
      } else if (task.state === 'error') {
        get().pushNotification({
          tone: 'error',
          title: '下载失败',
          message: task.error ?? task.label,
        })
      }
    })
    onEvent<JobRecord>(Events.job, (job) => {
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
      set((state) => ({ diagnostics: upsertDiagnostic(state.diagnostics, diagnostic) }))
    })

    onEvent<Settings>(Events.settingsChanged, (settings) => {
      applyAppearance(settings)
      set({ settings })
    })
    onEvent<UpdateDownloadState>(Events.updateDownload, (state) => {
      set({ updateDownload: state })
      if (state.phase === 'opened' || (state.phase === 'ready' && !state.error)) {
        get().pushNotification({
          tone: 'success',
          title: '更新已下载',
          message: `MossStudio ${state.version} 安装程序已打开`,
        })
      } else if (state.phase === 'error') {
        get().pushNotification({
          tone: 'error',
          title: '更新下载失败',
          message: state.error ?? '安装包下载失败',
        })
      }
    })
    onEvent<MossInferDownloadState>(Events.mossInferDownload, (download) => {
      const previous = get().mossInferDownload
      set({ mossInferDownload: download })
      if (download.phase === 'done' && previous?.phase !== 'done') {
        get().pushNotification({
          tone: 'success',
          title: 'MossInfer 引擎已就绪',
          message: download.version ? `${download.version} 已安装并设为当前版本` : '引擎已安装并设为当前版本',
        })
      } else if (download.phase === 'error' && previous?.phase !== 'error') {
        get().pushNotification({
          tone: 'error',
          title: 'MossInfer 引擎安装失败',
          message: download.error ?? '查看引擎页的安装状态了解详情',
        })
      } else if (download.phase === 'canceled' && previous?.phase !== 'canceled') {
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
    updates: null,
    updateDialogOpen: false,
    updateDownload: null,
    mossInferDownload: null,
    instances: [],
    catalog: null,
    downloads: [],
    jobs: [],
    activeJobId: null,
    jobLogs: {},
    diagnostics: [],
    devices: [],
    cases: [],
    launchRows: [],
    onboarding: null,
    notifications: [],
    notificationsOpen: false,
    studioPrompt: '',
    studioInstanceId: null,
    studioDraft: null,
    studioBackground: null,
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

        const [env, updates, catalog, downloads, jobs, diagnostics, devices, onboarding, queuedRows, engineDownload] =
          await Promise.allSettled([
            call<EnvReport>(Ipc.envScan),
            call<UpdateState>(Ipc.updatesCheck),
            call<Catalog>(Ipc.modelsCatalog),
            call<DownloadTask[]>(Ipc.downloadsList),
            call<JobRecord[]>(Ipc.jobList),
            call<Diagnostic[]>(Ipc.diagnosticsList),
            call<LaunchDevice[]>(Ipc.devicesList),
            call<OnboardingStatus>(Ipc.onboardingStatus),
            call<LaunchRow[]>(Ipc.launchQueueList),
            call<MossInferDownloadState | null>(Ipc.mossInferDownloadState),
          ])
        set({
          env: env.status === 'fulfilled' ? env.value : null,
          updates: updates.status === 'fulfilled' ? updates.value : null,
          catalog: catalog.status === 'fulfilled' ? catalog.value : null,
          downloads: downloads.status === 'fulfilled' ? downloads.value : [],
          jobs: jobs.status === 'fulfilled' ? jobs.value : [],
          diagnostics: diagnostics.status === 'fulfilled' ? diagnostics.value : [],
          devices: devices.status === 'fulfilled' ? devices.value : [],
          onboarding: onboarding.status === 'fulfilled' ? onboarding.value : null,
          launchRows: queuedRows.status === 'fulfilled' ? queuedRows.value : [],
          mossInferDownload: engineDownload.status === 'fulfilled' ? engineDownload.value : null,
          activeJobId:
            jobs.status === 'fulfilled'
              ? (jobs.value.find((job) => job.state === 'running' || job.state === 'starting')?.id ?? null)
              : null,
          ready: true,
        })
        const queued = queuedRows.status === 'fulfilled' ? queuedRows.value.filter((row) => row.state === 'queued') : []
        for (const deviceId of new Set(queued.map((row) => row.deviceId))) {
          setTimeout(() => {
            void get().startNextQueued(deviceId)
          }, 800)
        }
        if (settings.autoCheckUpdates && updates.status === 'fulfilled' && updates.value.updateAvailable) {
          get().pushNotification({
            tone: 'info',
            title: '发现新版本',
            message: `MossStudio ${updates.value.latestVersion} 可用`,
          })
          if (
            updates.value.latestVersion &&
            settings.onboardingState !== 'pending' &&
            settings.dismissedUpdateVersion !== updates.value.latestVersion
          ) {
            set({ updateDialogOpen: true })
          }
        }
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

    async refreshUpdates() {
      try {
        const updates = await call<UpdateState>(Ipc.updatesCheck)
        set({ updates })
      } catch {
        // keep previous
      }
    },

    async checkForUpdates() {
      try {
        const updates = await call<UpdateState>(Ipc.updatesCheck)
        set({ updates })
        if (updates.updateAvailable) set({ updateDialogOpen: true })
        return updates
      } catch {
        return null
      }
    },

    setUpdateDialogOpen(open) {
      set({ updateDialogOpen: open })
    },

    async startUpdateDownload() {
      const updates = get().updates
      if (!updates?.latestVersion || !updates.installer) {
        throw new Error('当前平台没有可用的安装包')
      }
      const state = await call<UpdateDownloadState>(Ipc.updatesDownload, {
        version: updates.latestVersion,
        installer: updates.installer,
      })
      set({ updateDownload: state })
    },

    async cancelUpdateDownload() {
      const version = get().updates?.latestVersion
      if (!version) return
      const state = await call<UpdateDownloadState | null>(Ipc.updatesCancel, { version })
      if (state) set({ updateDownload: state })
    },

    async saveSettings(patch) {
      const settings = await call<Settings>(Ipc.settingsUpdate, patch)
      applyAppearance(settings)
      set({ settings })
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

    setMossInferDownload(state) {
      set({ mossInferDownload: state })
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

    setStudioPrompt(prompt) {
      set({ studioPrompt: prompt })
    },
    setStudioInstanceId(instanceId) {
      set({ studioInstanceId: instanceId })
    },

    setStudioDraft(draft) {
      set({ studioDraft: draft })
    },

    setStudioBackground(item) {
      set({ studioBackground: item })
    },

    async dismissAnnouncement(id) {
      await call(Ipc.announcementsDismiss, { id })
      await get().refreshUpdates()
    },

    async downloadModel(modelId) {
      const task = await call<DownloadTask>(Ipc.modelDownload, { kind: 'model', id: modelId })
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
    },

    async downloadAdapter(adapterId) {
      const task = await call<DownloadTask>(Ipc.modelDownload, { kind: 'adapter', id: adapterId })
      set((state) => ({ downloads: upsertDownload(state.downloads, task) }))
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

    async refreshOnboarding() {
      try {
        set({ onboarding: await call<OnboardingStatus>(Ipc.onboardingStatus) })
      } catch {
        // keep previous
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
