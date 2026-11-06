import { HEALTH_CONFIRM_MS } from '@shared/install'

/** The subset of BrowserWindow the health check watches. */
export interface HealthWindow {
  isVisible(): boolean
  isDestroyed(): boolean
  on(event: 'show' | 'hide' | 'closed', listener: () => void): unknown
  webContents: {
    on(event: 'render-process-gone' | 'did-finish-load', listener: (...args: unknown[]) => void): unknown
  }
}

/**
 * Confirm once `win` has been shown for `delayMs` without its renderer crashing. A crash, hiding
 * or closing the window cancels the timer; showing it again or the next successful load starts it
 * again. `confirm` runs at most once per call.
 */
export function armHealthConfirm(win: HealthWindow, confirm: () => void, delayMs = HEALTH_CONFIRM_MS): () => void {
  let timer: NodeJS.Timeout | null = null
  let done = false
  const start = (): void => {
    if (done || timer || win.isDestroyed() || !win.isVisible()) return
    timer = setTimeout(() => {
      timer = null
      if (done || win.isDestroyed()) return
      done = true
      confirm()
    }, delayMs)
  }
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  win.on('show', start)
  win.on('hide', cancel)
  win.on('closed', cancel)
  win.webContents.on('render-process-gone', cancel)
  win.webContents.on('did-finish-load', start)
  start()
  return () => {
    done = true
    cancel()
  }
}

/**
 * App-level health: ANY window (existing ones and every window created later, e.g. by 'activate')
 * that stays shown for `delayMs` without a renderer crash confirms this version, once. Closing the
 * window afterwards does not undo it. Returns a disarm function.
 */
export function armAppHealth(
  existing: readonly HealthWindow[],
  onWindowCreated: (listener: (win: HealthWindow) => void) => () => void,
  confirm: () => void,
  delayMs = HEALTH_CONFIRM_MS,
): () => void {
  let done = false
  const disarms: Array<() => void> = []
  const disarmAll = (): void => {
    for (const disarm of disarms.splice(0)) disarm()
  }
  const once = (): void => {
    if (done) return
    done = true
    unsubscribe()
    disarmAll()
    confirm()
  }
  const watch = (win: HealthWindow): void => {
    if (!done) disarms.push(armHealthConfirm(win, once, delayMs))
  }
  const unsubscribe = onWindowCreated(watch)
  for (const win of existing) watch(win)
  return () => {
    done = true
    unsubscribe()
    disarmAll()
  }
}
