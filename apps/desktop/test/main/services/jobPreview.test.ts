import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_UPDATES_PER_SECOND, PreviewThrottle, jobPreviewPath, previewsDir, queuePositions, type JobPreview } from '@main/services/jobPreview'
import { useTempDataRoot } from '@test/helpers/tempDir'

const dataRoot = useTempDataRoot()

describe('preview paths', () => {
  it('keeps every job preview in cache/previews under a safe name', () => {
    expect(previewsDir()).toBe(join(dataRoot(), 'cache', 'previews'))
    expect(jobPreviewPath('job-abc_1')).toBe(join(dataRoot(), 'cache', 'previews', 'job-abc_1.png'))
    expect(jobPreviewPath('../../evil')).toBe(join(dataRoot(), 'cache', 'previews', '______evil.png'))
  })
})

describe('PreviewThrottle', () => {
  let now = 0
  let applied: Array<{ jobId: string; preview: JobPreview }>
  let throttle: PreviewThrottle
  let live: Set<string>
  /** How many jobs the throttle keeps state for. */
  const tracked = (): number => (throttle as unknown as { jobs: Map<string, unknown> }).jobs.size

  beforeEach(() => {
    vi.useFakeTimers()
    now = 1000
    applied = []
    live = new Set(['j', 'a', 'b'])
    throttle = new PreviewThrottle((jobId, preview) => applied.push({ jobId, preview }), (jobId) => live.has(jobId), 250, () => now)
  })
  afterEach(() => vi.useRealTimers())

  const frame = (step: number) => ({ path: '/cache/previews/j.png', step, total: 30 })
  /** Move the throttle's clock and the timers together. */
  const tick = (ms: number): void => {
    now += ms
    vi.advanceTimersByTime(ms)
  }

  it('allows four updates a second by default', () => {
    expect(PREVIEW_UPDATES_PER_SECOND).toBe(4)
  })

  it('passes the first write on at once and numbers every write', () => {
    throttle.push('j', frame(1))
    expect(applied).toEqual([{ jobId: 'j', preview: { path: '/cache/previews/j.png', step: 1, total: 30, seq: 1 } }])
  })

  it('holds writes inside the quiet period and delivers only the latest when it ends', () => {
    throttle.push('j', frame(1))
    tick(50)
    throttle.push('j', frame(2))
    tick(50)
    throttle.push('j', frame(3))
    expect(applied).toHaveLength(1)
    tick(149)
    expect(applied).toHaveLength(1)
    tick(1)
    expect(applied.map((item) => item.preview)).toEqual([
      { path: '/cache/previews/j.png', step: 1, total: 30, seq: 1 },
      { path: '/cache/previews/j.png', step: 3, total: 30, seq: 3 },
    ])
  })

  it('never exceeds the rate under a steady stream of writes', () => {
    // 50 writes a second for two seconds.
    for (let index = 0; index < 100; index += 1) {
      throttle.push('j', frame(index + 1))
      tick(20)
    }
    tick(1000)
    expect(applied.length).toBeLessThanOrEqual(2 * 4 + 1)
    expect(applied.length).toBeGreaterThanOrEqual(2 * 4 - 1)
    expect(applied.at(-1)!.preview.seq).toBe(100)
    const seqs = applied.map((item) => item.preview.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('keeps jobs apart', () => {
    throttle.push('a', frame(1))
    throttle.push('b', frame(1))
    expect(applied.map((item) => [item.jobId, item.preview.seq])).toEqual([['a', 1], ['b', 1]])
  })

  it('drops a held write when the job stops', () => {
    throttle.push('j', frame(1))
    tick(10)
    throttle.push('j', frame(2))
    throttle.stop('j')
    tick(1000)
    expect(applied).toHaveLength(1)
    expect(tracked()).toBe(0)
  })

  it('keeps no state for a write that arrives after the job ended', () => {
    throttle.push('j', frame(1))
    live.delete('j')
    throttle.stop('j')
    throttle.push('j', frame(2))
    throttle.push('gone', frame(1))
    expect(applied).toHaveLength(1)
    expect(tracked()).toBe(0)
  })

  it('drops a held write when the job ends before the quiet period does', () => {
    throttle.push('j', frame(1))
    tick(10)
    throttle.push('j', frame(2))
    live.delete('j')
    tick(1000)
    expect(applied).toHaveLength(1)
    expect(tracked()).toBe(0)
  })
})

describe('queuePositions', () => {
  it('numbers the waiting jobs from 1 in queue order', () => {
    expect([...queuePositions([{ job: { id: 'a' } }, { job: { id: 'b' } }, { job: { id: 'c' } }])]).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(queuePositions([]).size).toBe(0)
  })
})
