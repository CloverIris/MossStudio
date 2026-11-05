export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const FOCUS_THROTTLE_MS = 10 * 60_000

export type CheckReason = 'start' | 'interval' | 'focus' | 'manual'

export interface SchedulerDeps {
  check: (reason: CheckReason) => Promise<unknown>
  /** Subscribe to "a window got focus"; returns the unsubscribe. */
  onFocus: (listener: () => void) => () => void
  now?: () => number
  intervalMs?: number
  focusThrottleMs?: number
}

/**
 * Check on start, every 6 h, and when a window gets focus, but never more often than every
 * 10 min for focus (any check, manual ones included, resets that throttle). One check at a time.
 */
export class UpdateScheduler {
  private timer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private lastCheck = Number.NEGATIVE_INFINITY
  private running: Promise<unknown> | null = null

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.run('interval'), this.deps.intervalMs ?? CHECK_INTERVAL_MS)
    this.timer.unref?.()
    this.unsubscribe = this.deps.onFocus(() => {
      if (this.now() - this.lastCheck < (this.deps.focusThrottleMs ?? FOCUS_THROTTLE_MS)) return
      void this.run('focus')
    })
    void this.run('start')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Run a check now (joins one already running). */
  run(reason: CheckReason): Promise<unknown> {
    if (this.running) return this.running
    this.lastCheck = this.now()
    this.running = this.deps.check(reason)
      .catch(() => undefined)
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /** A check that happened outside the scheduler still counts for the focus throttle. */
  markChecked(): void {
    this.lastCheck = this.now()
  }
}
