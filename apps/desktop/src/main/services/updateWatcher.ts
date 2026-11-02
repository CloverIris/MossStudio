import { app } from 'electron'
import { Events } from '@shared/channels'
import type { UpdateState } from '@shared/types'
import { emit } from '../lib/events'
import { getSettings } from './settings'
import { checkUpdates } from './updates'

/**
 * Keep the release state fresh while the app is open.
 *
 * The renderer only asks once at startup, so a long-running window never noticed
 * a release published later in the day and the update dialog only appeared after
 * a manual check in Settings. This watcher re-checks on a timer and when the user
 * comes back to a window, then pushes the new state to the renderer.
 */
const INTERVAL_MS = 45 * 60_000
/** Coming back to the window should not hammer the release manifest. */
const FOCUS_MIN_GAP_MS = 5 * 60_000

/** Overridable so a test run can watch the timer fire without waiting 45 minutes. */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '')
  return Number.isFinite(value) && value >= 1000 ? value : fallback
}

let timer: NodeJS.Timeout | null = null
let lastCheckAt = Date.now()
let inFlight = false
let focusListener: (() => void) | null = null

async function refresh(reason: 'interval' | 'focus' | 'manual'): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const state: UpdateState = await checkUpdates(getSettings(), { force: true })
    lastCheckAt = Date.now()
    emit(Events.updatesChanged, state)
    if (state.updateAvailable) console.log(`[updates] ${reason}: ${state.latestVersion} available`)
  } catch (error) {
    console.error('[updates]', error)
  } finally {
    inFlight = false
  }
}

export function startUpdateWatcher(): void {
  if (timer) return
  timer = setInterval(() => void refresh('interval'), envMs('CLOVER_UPDATE_WATCH_MS', INTERVAL_MS))
  timer.unref?.()
  const focusGap = envMs('CLOVER_UPDATE_FOCUS_MS', FOCUS_MIN_GAP_MS)
  focusListener = () => {
    if (Date.now() - lastCheckAt < focusGap) return
    void refresh('focus')
  }
  app.on('browser-window-focus', focusListener)
}

export function stopUpdateWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (focusListener) app.off('browser-window-focus', focusListener)
  focusListener = null
}

/**
 * Record that a check just happened. The `updates:check` IPC path calls this so
 * the watcher's focus throttle accounts for manual checks too.
 */
export function markUpdateCheck(): void {
  lastCheckAt = Date.now()
}

/** Force a refresh from anywhere in the main process (used by the Settings button). */
export function refreshUpdatesNow(): void {
  void refresh('manual')
}
