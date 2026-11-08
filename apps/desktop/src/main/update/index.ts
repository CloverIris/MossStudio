/**
 * The app's update runtime, wired to Electron and the rest of main:
 *   feed (signed, mirrors as transport) → selection → download (Range resume) → materialize
 *   app-<v> → install.json pending → job-aware restart handoff (launcher / macOS swap helper)
 *   → health confirmation on the next start. Also the minimumVersion gate and announcements.
 */
import { accessSync, constants, existsSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { Events } from '@shared/channels'
import type { UpdateChannel } from '@shared/install'
import type { UpdateRestartResult, UpdaterState } from '@shared/update'
import { emit } from '../lib/events'
import { assertFreeSpace } from '../lib/disk'
import { paths } from '../lib/paths'
import { confirmHealth } from '../install'
import { readInstallRecord, updateInstallRecord } from '../install/record'
import { getRunContext } from '../install/runContext'
import { getSettings, updateSettings } from '../services/settings'
import { readBusySnapshot } from './busySources'
import { updateContext } from './context'
import { armAppHealth, type HealthWindow } from './health'
import { isUpdateTestBuild, trustedUpdateKeys, updateFeedUrl } from './keys'
import { cleanExitMarkerPath, failedMarkerPath, UpdateRuntime } from './runtime'
import { UpdateScheduler } from './schedule'
import { loadTestHook, readyToRestart, shouldCrash, TEST_CRASH_EXIT_CODE, writeTestStatus, type UpdateTestHook } from './testHook'

export { assertGenerationAllowed } from './gate'

let runtime: UpdateRuntime | null = null
let scheduler: UpdateScheduler | null = null
let testHook: UpdateTestHook | null | undefined

/** The CI hook (testHook.ts); always null in release builds. */
function hook(): UpdateTestHook | null {
  if (testHook === undefined) testHook = loadTestHook(paths.root(), isUpdateTestBuild())
  return testHook
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function getRuntime(): UpdateRuntime {
  if (runtime) return runtime
  const run = getRunContext()
  const keys = trustedUpdateKeys()
  const context = updateContext({ run, hasKeys: keys.length > 0, exists: existsSync, writable })
  const recordPath = run.recordPath
  runtime = new UpdateRuntime({
    version: app.getVersion(),
    context,
    keys: () => keys,
    feedUrl: (channel) => updateFeedUrl(channel),
    // The CI hook always downloads automatically.
    settings: () => (hook()?.pollMs ? { ...getSettings(), autoDownloadUpdates: true } : getSettings()),
    saveSettings: (patch) => {
      const next = updateSettings(patch)
      emit(Events.settingsChanged, next)
    },
    readRecord: () => (recordPath ? readInstallRecord(recordPath) : null),
    updateRecord: (change) => (recordPath ? updateInstallRecord(recordPath, change) : null),
    cacheDir: paths.cache(),
    busy: readBusySnapshot,
    emit: (state) => {
      emit(Events.updateState, state)
      if (hook()) void writeTestStatus(paths.root(), state).catch(() => undefined)
    },
    quit: () => app.quit(),
    confirmHealth: () => {
      confirmHealth()
    },
    assertFreeSpace: (path, bytes) => assertFreeSpace(path, bytes, '更新'),
    log: (line) => console.log(line),
  })
  return runtime
}

/** Start the runtime: verified cache, macOS reconcile, then checks on start / every 6 h / on focus. */
let initialized: Promise<void> | null = null
/** The runtime's startup work (reconcile, cleanup, notices), once. */
function initRuntime(): Promise<void> {
  initialized ??= getRuntime()
    .init()
    .catch((error: unknown) => console.error('[update] init', error))
  return initialized
}

/**
 * macOS has no launcher to switch versions when the app starts, so an update downloaded in an
 * earlier run is installed now, before any window opens: the same swap helper as 重启以更新,
 * with its health check and rollback. Only from a confirmed version, so a start that still has
 * to prove itself never hands off. True when the app is quitting for it.
 */
export async function installPendingAtStart(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const run = getRunContext()
  const record = run.recordPath ? readInstallRecord(run.recordPath) : null
  if (!record?.confirmed || record.current !== app.getVersion()) return false
  await initRuntime()
  const updates = getRuntime()
  const state = updates.getState()
  if (!state.supported || !state.pending || state.pending === state.failedVersion) return false
  const result = await updates.restart().catch((error: unknown) => ({ status: 'failed', error: String(error) }) as const)
  console.log(`[update] install at start: ${JSON.stringify(result)}`)
  return result.status === 'restarting'
}

export async function startUpdater(): Promise<void> {
  const test = hook()
  if (shouldCrash(test, app.getVersion())) {
    console.error(`[update] test hook: ${app.getVersion()} is in crashVersions, exiting ${TEST_CRASH_EXIT_CODE} before confirming health`)
    app.exit(TEST_CRASH_EXIT_CODE)
    return
  }
  const updates = getRuntime()
  await initRuntime()
  if (scheduler) return
  scheduler = new UpdateScheduler({
    check: async () => {
      await updates.check()
      if (test?.pollMs) await restartWhenTestReady(updates)
    },
    intervalMs: test?.pollMs ?? undefined,
    onFocus: (listener) => {
      app.on('browser-window-focus', listener)
      return () => app.off('browser-window-focus', listener)
    },
  })
  scheduler.start()
}

/** CI hook: restart as soon as the update is pending and this version has confirmed its health. */
async function restartWhenTestReady(updates: UpdateRuntime): Promise<void> {
  const recordPath = getRunContext().recordPath
  const record = recordPath ? readInstallRecord(recordPath) : null
  const confirmed = Boolean(record?.confirmed && record.current === app.getVersion())
  if (!readyToRestart(updates.getState(), confirmed)) return
  const result = await updates.restart().catch((error: unknown) => ({ status: String(error) }))
  console.log(`[update] test hook restart: ${JSON.stringify(result)}`)
}

export function stopUpdater(): void {
  scheduler?.stop()
  scheduler = null
  runtime?.dispose()
}

/**
 * Arm the health confirmation when this start has to prove itself: started by the launcher
 * (--moss-launched) or, on macOS, after a swap (install.json not confirmed yet). Any window that
 * stays shown for HEALTH_CONFIRM_MS without a renderer crash confirms, including windows opened
 * later ('activate'). Call it once, before the first window is created.
 */
export function armUpdateHealth(): void {
  const run = getRunContext()
  if (!run.recordPath || (run.mode !== 'installed' && run.mode !== 'portable')) return
  const record = readInstallRecord(run.recordPath)
  const version = app.getVersion()
  // macOS: right after a swap the record still names the old, confirmed version until
  // the runtime reconciles it, so a different current also means "prove yourself". After a
  // rollback (the swapped-in version died before recording itself) the record still says this
  // version is confirmed, but reconciling the helper's failed marker clears that: arm then too.
  const rolledBack = run.platform === 'darwin' && existsSync(failedMarkerPath(run.recordPath))
  if (!record || (record.confirmed && record.current === version && !rolledBack)) return
  if (run.platform !== 'darwin' && !run.launched) return
  const recordPath = run.recordPath
  let confirmed = false
  armAppHealth(
    BrowserWindow.getAllWindows() as unknown as HealthWindow[],
    (listener) => {
      const onCreated = (_event: unknown, win: BrowserWindow): void => listener(win as unknown as HealthWindow)
      app.on('browser-window-created', onCreated)
      return () => app.off('browser-window-created', onCreated)
    },
    () => {
      confirmed = confirmHealth() || confirmed
      console.log(`[update] health ${confirmed ? 'confirmed' : 'not recorded'} for ${version}`)
    },
  )
  if (run.platform === 'darwin') {
    // The swap helper cannot see an exit code: tell it a quit before confirming was a clean one.
    app.once('will-quit', () => {
      if (confirmed) return
      try {
        writeFileSync(cleanExitMarkerPath(recordPath), `${version}\n`)
      } catch {
        // best effort: without it the helper treats the exit as a failed start
      }
    })
  }
}

export const updaterApi = {
  state: (): UpdaterState => getRuntime().getState(),
  check: async (): Promise<UpdaterState> => {
    scheduler?.markChecked()
    return getRuntime().check()
  },
  download: (): UpdaterState => getRuntime().startDownload(),
  cancel: (): UpdaterState => getRuntime().cancel(),
  restart: (): Promise<UpdateRestartResult> => getRuntime().restart(),
  restartWhenIdle: (enabled: boolean): UpdaterState => getRuntime().setRestartWhenIdle(enabled),
  rollback: (): Promise<UpdateRestartResult> => getRuntime().rollback(),
  setChannel: (channel: UpdateChannel): Promise<UpdaterState> => getRuntime().setChannel(channel),
  setAutoDownload: (enabled: boolean): UpdaterState => getRuntime().setAutoDownload(enabled),
  dismissAnnouncement: (id: string): UpdaterState => getRuntime().dismissAnnouncement(id),
  unskip: (): Promise<UpdaterState> => getRuntime().unskip(),
  retryFailed: (): Promise<UpdaterState> => getRuntime().retryFailed(),
  dismissFailed: (): UpdaterState => getRuntime().dismissFailed(),
}

/** For logs and smoke runs. */
export function updaterSummary(): Pick<UpdaterState, 'supported' | 'unsupportedReason' | 'current' | 'phase' | 'channel'> {
  const state = getRuntime().getState()
  return {
    supported: state.supported,
    unsupportedReason: state.unsupportedReason,
    current: state.current,
    phase: state.phase,
    channel: state.channel,
  }
}
