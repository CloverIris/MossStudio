import { join } from 'node:path'
import type { JobRecord } from '@shared/types'
import { paths } from '../lib/paths'

export type JobPreview = NonNullable<JobRecord['preview']>

/** The folder live previews are written to (served by clover://, emptied when jobs end). */
export function previewsDir(): string {
  return join(paths.cache(), 'previews')
}

/** The PNG the engine rewrites with one job's live preview. */
export function jobPreviewPath(jobId: string): string {
  return join(previewsDir(), `${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}.png`)
}

/** At most this many renderer updates per second for one job's preview. */
export const PREVIEW_UPDATES_PER_SECOND = 4

/**
 * Turns the engine's preview writes into JobRecord.preview updates: `seq`
 * counts every write, but the renderer hears about them at most
 * PREVIEW_UPDATES_PER_SECOND times a second. A write inside the quiet period
 * is held and delivered when it ends (the latest one wins), so the last frame
 * is never lost.
 */
export class PreviewThrottle {
  private readonly jobs = new Map<string, { seq: number; lastAt: number; held: JobPreview | null; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(
    private readonly apply: (jobId: string, preview: JobPreview) => void,
    /** Whether `jobId` is still running: writes for any other job are dropped (no state is kept for them). */
    private readonly active: (jobId: string) => boolean,
    private readonly intervalMs = 1000 / PREVIEW_UPDATES_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {}

  push(jobId: string, frame: { path: string; step: number; total: number }): void {
    if (!this.active(jobId)) {
      this.stop(jobId)
      return
    }
    const state = this.jobs.get(jobId) ?? { seq: 0, lastAt: Number.NEGATIVE_INFINITY, held: null, timer: null }
    this.jobs.set(jobId, state)
    state.seq += 1
    const preview: JobPreview = { path: frame.path, step: frame.step, total: frame.total, seq: state.seq }
    const wait = state.lastAt + this.intervalMs - this.now()
    if (wait <= 0 && !state.timer) {
      state.lastAt = this.now()
      this.apply(jobId, preview)
      return
    }
    state.held = preview
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      const held = state.held
      state.held = null
      if (!held || this.jobs.get(jobId) !== state) return
      if (!this.active(jobId)) {
        this.jobs.delete(jobId)
        return
      }
      state.lastAt = this.now()
      this.apply(jobId, held)
    }, Math.max(0, wait))
  }

  /** Forget a job (it ended): a held frame is dropped. */
  stop(jobId: string): void {
    const state = this.jobs.get(jobId)
    if (state?.timer) clearTimeout(state.timer)
    this.jobs.delete(jobId)
  }
}

/** 1-based places of the jobs waiting in one engine queue, by job id. */
export function queuePositions(queue: ReadonlyArray<{ job: { id: string } }>): Map<string, number> {
  return new Map(queue.map((entry, index) => [entry.job.id, index + 1]))
}
