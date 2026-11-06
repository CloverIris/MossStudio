// original-fs: in the packaged main process node:fs treats every *.asar as a folder; app folders are plain files here.
import { existsSync, promises as fsp, readFileSync, rmSync } from 'original-fs'
import { dirname, join } from 'node:path'
import {
  HEALTH_TIMEOUT_MS,
  type FileList,
  type InstallRecord,
  type PlatformKey,
  type UpdateChannel,
  type UpdateFeed,
} from '@shared/install'
import type { Settings } from '@shared/types'
import { compareSemver, type UpdateBusyReason, type UpdateRestartResult, type UpdaterState } from '@shared/update'
import type { UpdatePublicKey } from '@shared/updateKeys'
import { busyReasons, type BusySnapshot } from './busy'
import { abortError, downloadAsset, isAbortError } from './download'
import { fetchVerifiedFeed, loadFeedCache, loadHighWater, raiseHighWater, resetHighWater, saveFeedCache } from './feed'
import { setMinimumVersion, updateRequired } from './gate'
import { spawnLauncherRestart, spawnMacSwap, type SpawnFn } from './handoff'
import { materialize } from './materialize'
import { activeAnnouncements, channelsToRead, minimumVersionOf, selectUpdate, type UpdateSelection } from './select'
import { transportUrls } from './transport'
import { parseFileList } from './verify'

const { mkdir, readdir, readFile, rm, stat } = fsp

/** Where this copy runs and whether it can update itself (built from the installer's RunContext). */
export interface UpdateContext {
  /** Null when this copy cannot update itself; the reason is shown to the user. */
  unsupportedReason: string | null
  os: 'win32' | 'linux' | 'darwin'
  platformKey: PlatformKey | null
  /** Windows/Linux: R. macOS: the folder holding the bundle. */
  root: string | null
  /** Windows/Linux: app-<current>. macOS: the running .app bundle. */
  appPath: string
  launcher: string | null
  recordPath: string | null
}

export type UpdateSettings = Pick<
  Settings,
  | 'networkMode'
  | 'gitMirror'
  | 'updateChannel'
  | 'autoDownloadUpdates'
  | 'dismissedAnnouncements'
  | 'skippedUpdateVersion'
  | 'noticedFailedUpdates'
>

export interface UpdateHost {
  version: string
  context: UpdateContext
  keys: () => readonly UpdatePublicKey[]
  feedUrl: (channel: UpdateChannel) => string
  settings: () => UpdateSettings
  saveSettings: (patch: Partial<UpdateSettings>) => void
  readRecord: () => InstallRecord | null
  updateRecord: (change: (record: InstallRecord) => InstallRecord) => InstallRecord | null
  /** Verified feeds are cached here so an offline start keeps announcements and the gate. */
  cacheDir: string
  busy: () => Promise<BusySnapshot>
  emit: (state: UpdaterState) => void
  quit: () => void
  /**
   * Mark the running version healthy (install.json confirmed=true). Called before a restart the
   * user chose (重启以更新, 回到上一个版本): the app demonstrably works.
   */
  confirmHealth: () => void
  /** Throws a Chinese message when `bytes` do not fit next to `path`. */
  assertFreeSpace: (path: string, bytes: number) => Promise<void>
  spawn?: SpawnFn
  fetchImpl?: typeof fetch
  now?: () => number
  idlePollMs?: number
  progressIntervalMs?: number
  tempDir?: string
  log?: (message: string) => void
}

/**
 * Names the update runtime creates (the installer's uninstall plan lists the same):
 *   Windows/Linux  R/.updates/  R/app-<v>.update-partial[.delta]  R/app-<v>
 *   macOS          <folder>/.MossStudio-updates/  .MossStudio-<v>.app.update-partial[.delta]
 *                  .MossStudio-<v>.app (materialized)  .MossStudio-<v>.app.previous
 * The `update-partial` suffix keeps them apart from a running Setup's own temporary folders.
 */
export function updateLayout(context: Pick<UpdateContext, 'os' | 'root' | 'appPath'>) {
  if (context.os === 'darwin') {
    const folder = dirname(context.appPath)
    return {
      staging: join(folder, '.MossStudio-updates'),
      appDir: (version: string) => join(folder, `.MossStudio-${version}.app`),
      partialDir: (version: string) => join(folder, `.MossStudio-${version}.app.update-partial`),
      previousBundle: (version: string) => join(folder, `.MossStudio-${version}.app.previous`),
      baseDir: (_current: string) => context.appPath,
    }
  }
  const root = context.root ?? dirname(context.appPath)
  return {
    staging: join(root, '.updates'),
    appDir: (version: string) => join(root, `app-${version}`),
    partialDir: (version: string) => join(root, `app-${version}.update-partial`),
    previousBundle: (version: string) => join(root, `app-${version}`),
    baseDir: (current: string) => join(root, `app-${current}`),
  }
}

/** Next to install.json: the macOS helper writes the version it rolled back here. */
export function failedMarkerPath(recordPath: string): string {
  return join(dirname(recordPath), '.update-failed')
}

/** Next to install.json: an unconfirmed macOS app writes its version here when it quits cleanly. */
export function cleanExitMarkerPath(recordPath: string): string {
  return join(dirname(recordPath), '.update-clean-exit')
}

/** Aborted downloads older than this are removed from the staging folder on start. */
export const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60_000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class UpdateRuntime {
  private state: UpdaterState
  private feeds: UpdateFeed[] = []
  private selection: UpdateSelection | null = null
  private controller: AbortController | null = null
  private downloading: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastProgressEmit = 0
  private readonly layout: ReturnType<typeof updateLayout>

  constructor(private readonly host: UpdateHost) {
    const settings = host.settings()
    this.layout = updateLayout(host.context)
    this.state = {
      supported: host.context.unsupportedReason === null,
      unsupportedReason: host.context.unsupportedReason,
      current: host.version,
      channel: settings.updateChannel,
      autoDownload: settings.autoDownloadUpdates,
      phase: host.context.unsupportedReason === null ? 'idle' : 'unsupported',
      checkedAt: null,
      available: null,
      progress: null,
      pending: null,
      previous: null,
      canRollback: false,
      minimumVersion: null,
      required: false,
      busy: [],
      restartWhenIdle: false,
      error: null,
      announcements: [],
      skippedVersion: settings.skippedUpdateVersion ?? null,
      failedVersion: null,
      failedNotice: false,
    }
    this.refreshRecord()
  }

  getState(): UpdaterState {
    return this.state
  }

  private get supported(): boolean {
    return this.host.context.unsupportedReason === null
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private set(patch: Partial<UpdaterState>, options: { progress?: boolean } = {}): void {
    this.state = { ...this.state, ...patch }
    if (options.progress) {
      const interval = this.host.progressIntervalMs ?? 250
      if (this.now() - this.lastProgressEmit < interval) return
      this.lastProgressEmit = this.now()
    }
    this.host.emit(this.state)
  }

  /** pending/previous/canRollback/failedVersion from install.json. */
  private refreshRecord(): void {
    const record = this.supported ? this.host.readRecord() : null
    const previous = record?.previous ?? null
    const pending =
      record?.pending && compareSemver(record.pending, this.host.version) > 0 && existsSync(this.layout.appDir(record.pending))
        ? record.pending
        : null
    const canRollback = Boolean(
      this.supported && previous && !record?.failed.includes(previous) && existsSync(this.layout.previousBundle(previous)),
    )
    // The newest version that failed its start and is newer than this one (older entries no longer matter).
    const failedVersion =
      (record?.failed ?? []).filter((version) => compareSemver(version, this.host.version) > 0).sort((a, b) => compareSemver(b, a))[0] ??
      null
    const failedNotice = this.state.failedNotice && failedVersion === this.state.failedVersion
    this.state = { ...this.state, pending, previous, canRollback, failedVersion, failedNotice }
    if (pending && this.state.phase === 'idle') this.state = { ...this.state, phase: 'ready' }
  }

  /**
   * Startup: macOS reconcile after a swap or a helper rollback, leftovers cleanup, the rollback
   * notice, and the last verified feed from the cache (announcements and the gate work offline).
   */
  async init(): Promise<void> {
    if (this.supported) {
      if (this.host.context.os === 'darwin') this.reconcileMac()
      await this.cleanupLeftovers().catch((error) => this.host.log?.(`[update] cleanup: ${message(error)}`))
      this.refreshRecord()
      this.noticeFailed()
    }
    const feeds: UpdateFeed[] = []
    for (const channel of channelsToRead(this.state.channel)) {
      const cached = await loadFeedCache(this.host.cacheDir, channel, this.host.keys(), await loadHighWater(this.host.cacheDir, channel))
      if (cached) feeds.push(cached)
    }
    if (feeds.length) this.applyFeeds(feeds, { fromCache: true })
    this.host.emit(this.state)
  }

  /**
   * macOS has no launcher: the app itself keeps install.json in step with the bundle that runs.
   * The handoff does not switch the record; the swapped-in app does it here (current = running,
   * previous = the version it replaced, pending cleared, confirmed = false), which is what the
   * swap helper waits for. The helper leaves `.update-failed` when it had to roll a version back.
   */
  private reconcileMac(): void {
    const recordPath = this.host.context.recordPath
    if (!recordPath) return
    const marker = failedMarkerPath(recordPath)
    let failedVersion: string | null = null
    try {
      failedVersion = existsSync(marker) ? readFileSync(marker, 'utf8').trim() || null : null
    } catch {
      failedVersion = null
    }
    const running = this.host.version
    this.host.updateRecord((record) => {
      if (failedVersion) {
        return {
          ...record,
          failed: [...new Set([...record.failed, failedVersion])],
          current: running,
          previous: undefined,
          pending: record.pending === failedVersion ? undefined : record.pending,
          confirmed: false,
          updatedAt: new Date(this.now()).toISOString(),
        }
      }
      if (record.current === running) return record
      return {
        ...record,
        current: running,
        // The bundle this one replaced now sits at .MossStudio-<record.current>.app.previous.
        previous: record.current,
        pending: record.pending && compareSemver(record.pending, running) > 0 ? record.pending : undefined,
        confirmed: false,
        updatedAt: new Date(this.now()).toISOString(),
      }
    })
    if (failedVersion) rmSync(marker, { force: true })
  }

  /**
   * A version that failed its first start was rolled back (by the launcher or the macOS helper):
   * tell the user once. The notice stays up for this run; the version is remembered as told.
   */
  private noticeFailed(): void {
    const version = this.state.failedVersion
    const noticed = this.host.settings().noticedFailedUpdates ?? []
    if (!version || noticed.includes(version)) return
    this.host.saveSettings({ noticedFailedUpdates: [...noticed, version].slice(-50) })
    this.host.log?.(`[update] ${version} did not start and was rolled back to ${this.host.version}`)
    this.state = { ...this.state, failedNotice: true }
  }

  private async cleanupLeftovers(): Promise<void> {
    const record = this.host.readRecord()
    await this.pruneStaging(null)
    if (this.host.context.os === 'darwin') {
      const folder = dirname(this.host.context.appPath)
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        const match = /^\.MossStudio-(.+)\.app(\.update-partial(?:\.delta)?|\.previous)?$/.exec(name)
        if (!match) continue
        const [, version, suffix] = match
        const keep = suffix === '.previous' ? version === record?.previous : suffix === undefined ? version === record?.pending : false
        if (!keep) await rm(join(folder, name), { recursive: true, force: true })
      }
      return
    }
    const root = this.host.context.root
    if (!root) return
    for (const name of await readdir(root).catch(() => [] as string[])) {
      // Only our own names: a running Setup may have its own app-<v> temporaries here.
      if (/^app-.+\.update-partial(?:\.delta)?$/.test(name)) await rm(join(root, name), { recursive: true, force: true })
    }
  }

  /**
   * The staging folder (R/.updates, macOS .MossStudio-updates) holds one folder per version.
   * With `keep` set, every other version folder goes; always, files untouched for
   * STAGING_MAX_AGE_MS (aborted downloads) go too.
   */
  private async pruneStaging(keep: string | null): Promise<void> {
    const staging = this.layout.staging
    const cutoff = this.now() - STAGING_MAX_AGE_MS
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      const dir = join(staging, name)
      if (keep !== null && name !== keep) {
        await rm(dir, { recursive: true, force: true })
        continue
      }
      const info = await stat(dir).catch(() => null)
      if (!info) continue
      if (!info.isDirectory()) {
        if (info.mtimeMs < cutoff) await rm(dir, { force: true })
        continue
      }
      const files = await readdir(dir).catch(() => [] as string[])
      for (const file of files) {
        const full = join(dir, file)
        const fileInfo = await stat(full).catch(() => null)
        if (fileInfo && fileInfo.mtimeMs < cutoff) await rm(full, { recursive: true, force: true })
      }
      if (!(await readdir(dir).catch(() => ['?'])).length) await rm(dir, { recursive: true, force: true })
    }
  }

  private applyFeeds(feeds: UpdateFeed[], options: { fromCache?: boolean } = {}): void {
    this.feeds = feeds
    const record = this.supported ? this.host.readRecord() : null
    const platform = this.host.context.platformKey
    this.selection = platform
      ? selectUpdate({
          feeds,
          current: this.host.version,
          failed: record?.failed ?? [],
          platform,
          skipped: this.host.settings().skippedUpdateVersion,
        })
      : null
    const minimumVersion = minimumVersionOf(feeds)
    setMinimumVersion(minimumVersion, this.host.version)
    const selection = this.selection
    const available = selection
      ? {
          version: selection.version,
          publishedAt: selection.feed.publishedAt,
          notes: selection.feed.notes,
          notesUrl: selection.feed.notesUrl,
          downloadSize: selection.download.asset.size,
          kind: selection.download.kind,
        }
      : null
    this.refreshRecord()
    let phase = this.state.phase
    if (!this.supported) phase = 'unsupported'
    else if (!this.downloading && !['waiting-idle', 'restarting'].includes(phase)) {
      phase = this.state.pending && (!selection || selection.version === this.state.pending) ? 'ready' : selection ? 'available' : 'idle'
    }
    this.state = {
      ...this.state,
      phase,
      available,
      minimumVersion,
      required: updateRequired().required,
      announcements: activeAnnouncements(feeds, this.host.settings().dismissedAnnouncements, this.now()),
      skippedVersion: this.host.settings().skippedUpdateVersion ?? null,
      checkedAt: options.fromCache ? this.state.checkedAt : new Date(this.now()).toISOString(),
    }
  }

  /** Fetch and verify the feeds of the channel, select, and auto-download when enabled. */
  async check(): Promise<UpdaterState> {
    const channel = this.host.settings().updateChannel
    if (channel !== this.state.channel) this.state = { ...this.state, channel }
    // Settings is where the channel is chosen; install.json mirrors it for the launcher and Setup.
    if (this.supported && this.host.readRecord()?.channel !== channel) {
      this.host.updateRecord((record) => ({ ...record, channel, updatedAt: new Date(this.now()).toISOString() }))
    }
    if (!this.host.keys().length) {
      this.set({ error: '此版本未内置更新签名密钥，无法验证更新', checkedAt: new Date(this.now()).toISOString() })
      return this.state
    }
    const before = this.state.phase
    if (!this.downloading && this.supported && before !== 'waiting-idle' && before !== 'restarting') this.set({ phase: 'checking' })
    const results = await Promise.allSettled(
      channelsToRead(channel).map(async (name) => {
        const cacheDir = this.host.cacheDir
        const highWater = await loadHighWater(cacheDir, name)
        try {
          const fetched = await fetchVerifiedFeed(name, {
            keys: this.host.keys(),
            settings: this.host.settings(),
            url: this.host.feedUrl(name),
            fetchImpl: this.host.fetchImpl,
            highWater,
          })
          await saveFeedCache(cacheDir, name, fetched).catch(() => undefined)
          await raiseHighWater(cacheDir, name, fetched.feed).catch(() => undefined)
          return { feed: fetched.feed, error: null as unknown }
        } catch (error) {
          // A stale or replayed feed (or no network): keep the last verified one, if any.
          const cached = await loadFeedCache(cacheDir, name, this.host.keys(), highWater)
          if (cached) return { feed: cached, error }
          throw error
        }
      }),
    )
    const feeds = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.feed] : []))
    const failure = results
      .map((result) => (result.status === 'rejected' ? result.reason : result.value.error))
      .find((error) => error !== null && error !== undefined)
    if (!feeds.length) {
      const phase =
        this.supported && this.state.phase === 'checking'
          ? this.state.pending
            ? 'ready'
            : this.state.available
              ? 'available'
              : 'error'
          : this.state.phase
      this.set({ phase, error: failure ? message(failure) : '检查更新失败', checkedAt: new Date(this.now()).toISOString() })
      return this.state
    }
    this.applyFeeds(feeds)
    this.state = { ...this.state, error: failure ? message(failure) : null }
    this.host.emit(this.state)
    if (this.supported && !this.downloading) await this.pruneStaging(this.selection?.version ?? '').catch(() => undefined)
    if (this.state.phase === 'available' && this.state.autoDownload && this.supported) void this.download()
    return this.state
  }

  /** Start (or join) the download + materialization of the selected version. */
  download(): Promise<UpdaterState> {
    if (!this.supported) return Promise.resolve(this.state)
    const selection = this.selection
    if (!selection || this.state.pending === selection.version) return Promise.resolve(this.state)
    if (!this.downloading) {
      this.downloading = this.runDownload(selection).finally(() => {
        this.downloading = null
        this.controller = null
        if (this.state.restartWhenIdle && this.state.pending) void this.pollIdle()
      })
    }
    return this.downloading.then(() => this.state)
  }

  /** Start the download without waiting for it (IPC: progress arrives as events). */
  startDownload(): UpdaterState {
    void this.download()
    return this.state
  }

  cancel(): UpdaterState {
    this.controller?.abort()
    return this.state
  }

  private async runDownload(selection: UpdateSelection): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const version = selection.version
    const staging = join(this.layout.staging, version)
    const settings = this.host.settings()
    const started = this.now()
    try {
      this.set({
        phase: 'downloading',
        error: null,
        progress: { bytes: 0, totalBytes: selection.download.asset.size, speedBps: 0, percent: 0 },
      })
      await mkdir(staging, { recursive: true })
      for (const name of await readdir(this.layout.staging).catch(() => [] as string[])) {
        if (name !== version) await rm(join(this.layout.staging, name), { recursive: true, force: true })
      }
      const filesPath = await downloadAsset({
        urls: transportUrls(selection.files.url, settings),
        dest: join(staging, `files-${selection.files.sha256}.json`),
        sha256: selection.files.sha256,
        size: selection.files.size,
        signal,
        fetchImpl: this.host.fetchImpl,
      })
      const fileList = parseFileList(await readFile(filesPath), version)
      if (fileList.platform !== this.host.context.platformKey) throw new Error('文件清单的平台与本机不符')
      const unpacked = fileList.entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0)
      await this.host.assertFreeSpace(join(staging, 'space-check'), selection.download.asset.size + unpacked)

      const fetchPackage = async (kind: 'full' | 'delta'): Promise<string> => {
        const asset = kind === 'delta' ? selection.download.asset : selection.platform.full
        this.set({ phase: 'downloading', progress: { bytes: 0, totalBytes: asset.size, speedBps: 0, percent: 0 } })
        return downloadAsset({
          urls: transportUrls(asset.url, settings),
          dest: join(staging, `${kind}-${asset.sha256}.zip`),
          sha256: asset.sha256,
          size: asset.size,
          signal,
          fetchImpl: this.host.fetchImpl,
          onProgress: (bytes) => {
            const elapsed = Math.max(1, this.now() - started) / 1000
            this.set(
              {
                progress: {
                  bytes,
                  totalBytes: asset.size,
                  speedBps: Math.round(bytes / elapsed),
                  percent: Math.min(100, Math.round((bytes / asset.size) * 100)),
                },
              },
              { progress: true },
            )
          },
        })
      }
      const build = async (kind: 'full' | 'delta', zipPath: string, list: FileList): Promise<void> => {
        this.set({ phase: 'installing' })
        await materialize({
          kind,
          zipPath,
          fileList: list,
          partialDir: this.layout.partialDir(version),
          finalDir: this.layout.appDir(version),
          baseDir: kind === 'delta' ? this.layout.baseDir(this.host.version) : undefined,
          baseVersion: this.host.version,
          filesSha256: selection.files.sha256,
          signal,
        })
      }

      if (selection.download.kind === 'delta') {
        try {
          await build('delta', await fetchPackage('delta'), fileList)
        } catch (error) {
          if (signal.aborted) throw error
          // A delta that does not apply (a modified install, a bad base file) falls back to the full package.
          this.host.log?.(`[update] delta failed, using the full package: ${message(error)}`)
          await build('full', await fetchPackage('full'), fileList)
        }
      } else {
        await build('full', await fetchPackage('full'), fileList)
      }
      if (signal.aborted) throw abortError()
      const written = this.host.updateRecord((record) => ({ ...record, pending: version, updatedAt: new Date(this.now()).toISOString() }))
      if (!written) throw new Error('找不到安装记录（install.json），无法登记更新')
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      this.refreshRecord()
      this.set({ phase: 'ready', progress: null, error: null })
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.set({ phase: 'available', progress: null, error: null })
        return
      }
      this.host.log?.(`[update] ${message(error)}`)
      this.set({ phase: 'error', progress: null, error: message(error) })
    }
  }

  /** Fails closed: when the stores cannot be read, a restart counts as interrupting something. */
  private async busyNow(): Promise<UpdateBusyReason[]> {
    try {
      return busyReasons(await this.host.busy())
    } catch (error) {
      this.host.log?.(`[update] busy check failed: ${message(error)}`)
      return [{ kind: 'unknown', count: 1, label: '无法确认是否有任务在运行' }]
    }
  }

  /** Restart into `pending`, unless jobs, training or downloads would be interrupted. */
  async restart(): Promise<UpdateRestartResult> {
    if (!this.supported) return { status: 'unsupported', reason: this.host.context.unsupportedReason ?? '' }
    this.refreshRecord()
    const pending = this.state.pending
    if (!pending) return { status: 'nothing-pending' }
    const busy = await this.busyNow()
    if (busy.length) {
      this.set({ busy })
      return { status: 'busy', busy }
    }
    return this.handoff({ incomingVersion: pending, kind: 'update' })
  }

  /** 空闲后自动重启: watch until nothing is busy (and the update is ready), then restart. */
  setRestartWhenIdle(enabled: boolean): UpdaterState {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!enabled || !this.supported) {
      this.refreshRecord()
      const phase =
        this.state.phase === 'waiting-idle'
          ? this.state.pending
            ? 'ready'
            : this.state.available
              ? 'available'
              : 'idle'
          : this.state.phase
      this.set({ restartWhenIdle: false, phase, busy: [] })
      return this.state
    }
    this.set({ restartWhenIdle: true, phase: this.downloading ? this.state.phase : 'waiting-idle' })
    void this.pollIdle()
    return this.state
  }

  private async pollIdle(): Promise<void> {
    if (!this.state.restartWhenIdle) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.downloading) {
      this.refreshRecord()
      const busy = await this.busyNow()
      if (!this.state.restartWhenIdle) return
      if (this.state.pending && !busy.length) {
        this.set({ busy: [] })
        await this.handoff({ incomingVersion: this.state.pending, kind: 'update' })
        return
      }
      this.set({ busy, phase: 'waiting-idle' })
    }
    this.idleTimer = setTimeout(() => void this.pollIdle(), this.host.idlePollMs ?? 5_000)
    this.idleTimer.unref?.()
  }

  /**
   * 回到上一个版本: switch to the previous version and restart. The version left behind is
   * remembered as skipped, so the next check does not simply offer it again (update:unskip).
   */
  async rollback(): Promise<UpdateRestartResult> {
    if (!this.supported) return { status: 'unsupported', reason: this.host.context.unsupportedReason ?? '' }
    this.refreshRecord()
    const previous = this.state.previous
    if (!previous || !this.state.canRollback) return { status: 'nothing-pending' }
    const busy = await this.busyNow()
    if (busy.length) {
      this.set({ busy })
      return { status: 'busy', busy }
    }
    return this.handoff({ incomingVersion: previous, kind: 'rollback' })
  }

  /** 安装 <v>: offer the version skipped by a rollback again. */
  unskip(): Promise<UpdaterState> {
    this.host.saveSettings({ skippedUpdateVersion: null })
    this.set({ skippedVersion: null })
    return this.check()
  }

  /**
   * 再试一次: take back a version that was rolled back after a failed start. It leaves
   * install.json's `failed` (and the skip, if that hid it too) and is downloaded right away.
   */
  async retryFailed(): Promise<UpdaterState> {
    const version = this.state.failedVersion
    if (!this.supported || !version) return this.state
    this.host.updateRecord((record) => ({
      ...record,
      failed: record.failed.filter((item) => item !== version),
      updatedAt: new Date(this.now()).toISOString(),
    }))
    const skipped = this.host.settings().skippedUpdateVersion
    if (skipped && compareSemver(version, skipped) <= 0) this.host.saveSettings({ skippedUpdateVersion: null })
    this.host.log?.(`[update] retrying ${version}`)
    this.refreshRecord()
    this.set({ failedNotice: false, skippedVersion: this.host.settings().skippedUpdateVersion ?? null })
    await this.check()
    if (this.state.phase === 'available') void this.download()
    return this.state
  }

  /** 知道了: hide the rollback notice for the rest of this run. */
  dismissFailed(): UpdaterState {
    this.set({ failedNotice: false })
    return this.state
  }

  /**
   * Hand the restart to the launcher (Windows/Linux) or the swap helper (macOS) and quit, but only
   * once the child process really started. If it cannot start, everything written for the
   * handoff is restored, the app stays open and the state says why.
   */
  private async handoff(target: { incomingVersion: string; kind: 'update' | 'rollback' }): Promise<UpdateRestartResult> {
    const context = this.host.context
    const current = this.host.version
    const stamp = new Date(this.now()).toISOString()
    const previousSkip = this.host.settings().skippedUpdateVersion ?? null
    let originalRecord: InstallRecord | null = null
    this.set({ phase: 'restarting', restartWhenIdle: false, busy: [], error: null })
    try {
      // The user chose this restart in a running, working app: that is proof of health.
      try {
        this.host.confirmHealth()
      } catch (error) {
        this.host.log?.(`[update] confirm before restart: ${message(error)}`)
      }
      if (target.kind === 'rollback') this.host.saveSettings({ skippedUpdateVersion: current })
      if (context.os === 'darwin') {
        const recordPath = context.recordPath
        if (!recordPath) throw new Error('找不到安装记录（install.json）')
        const incoming =
          target.kind === 'update' ? this.layout.appDir(target.incomingVersion) : this.layout.previousBundle(target.incomingVersion)
        // install.json is left as it is: the swapped-in app records itself (reconcileMac), and
        // the helper only moves bundles while current still names this version.
        await spawnMacSwap(
          {
            pid: process.pid,
            bundle: context.appPath,
            incoming,
            outgoing: this.layout.previousBundle(current),
            record: recordPath,
            timeoutSeconds: HEALTH_TIMEOUT_MS / 1000,
            marker: failedMarkerPath(recordPath),
            version: target.incomingVersion,
            from: current,
            clean: cleanExitMarkerPath(recordPath),
          },
          { spawn: this.host.spawn, tempDir: this.host.tempDir },
        )
      } else {
        if (!context.launcher) throw new Error('找不到 MossStudio 启动器，无法重启更新')
        if (target.kind === 'rollback') {
          originalRecord = this.host.readRecord()
          this.host.updateRecord((record) => ({
            ...record,
            current: target.incomingVersion,
            previous: record.current,
            pending: undefined,
            confirmed: false,
            updatedAt: stamp,
          }))
        }
        await spawnLauncherRestart(context.launcher, process.pid, this.host.spawn)
      }
    } catch (error) {
      if (originalRecord) {
        const restore = originalRecord
        this.host.updateRecord(() => restore)
      }
      if (target.kind === 'rollback') this.host.saveSettings({ skippedUpdateVersion: previousSkip })
      this.refreshRecord()
      const reason = message(error)
      this.host.log?.(`[update] ${target.kind} handoff failed: ${reason}`)
      this.set({ phase: 'error', error: reason, skippedVersion: previousSkip })
      return { status: 'failed', error: reason }
    }
    this.controller?.abort()
    this.host.log?.(`[update] ${target.kind}: handing off to ${target.incomingVersion}`)
    this.host.quit()
    return { status: 'restarting' }
  }

  async setChannel(channel: UpdateChannel): Promise<UpdaterState> {
    const before = channelsToRead(this.host.settings().updateChannel)
    this.host.saveSettings({ updateChannel: channel })
    // Feeds this client starts reading now are compared afresh (anti-rollback is per channel).
    for (const name of channelsToRead(channel)) {
      if (!before.includes(name)) await resetHighWater(this.host.cacheDir, name).catch(() => undefined)
    }
    this.set({ channel })
    return this.check()
  }

  setAutoDownload(enabled: boolean): UpdaterState {
    this.host.saveSettings({ autoDownloadUpdates: enabled })
    this.set({ autoDownload: enabled })
    if (enabled && this.state.phase === 'available') void this.download()
    return this.state
  }

  dismissAnnouncement(id: string): UpdaterState {
    const dismissed = this.host.settings().dismissedAnnouncements
    this.host.saveSettings({ dismissedAnnouncements: [...dismissed, id] })
    this.set({ announcements: activeAnnouncements(this.feeds, [...dismissed, id], this.now()) })
    return this.state
  }

  dispose(): void {
    this.controller?.abort()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
