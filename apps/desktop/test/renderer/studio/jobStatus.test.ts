import { describe, expect, it } from 'vitest'
import type { JobRecord } from '@shared/types'
import { cardJobView, formatDuration, formatEta, queuePosition } from '@renderer/pages/studio/jobStatus'
import { canvas } from './fixtures'

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1', instanceId: 'engine', instanceName: 'MossInfer', kind: 'inference', mode: 'runner', state: 'running', stage: 'denoise',
    params: { prompt: 'x', negativePrompt: '', width: 1024, height: 1024, steps: 20, cfg: 3, seed: 1, profile: 'base' },
    progress: { stage: 'denoise', current: 13, total: 20, percent: 65, etaMs: 5200 },
    startedAt: '2026-11-04T10:00:00.000Z',
    ...patch,
  }
}

describe('studio/jobStatus formatting', () => {
  it('formats ETA and duration in plain words', () => {
    expect(formatEta(5200)).toBe('约 6 秒')
    expect(formatEta(125_000)).toBe('约 3 分钟')
    expect(formatEta(undefined)).toBe('')
    expect(formatDuration('2026-11-04T10:00:00Z', '2026-11-04T10:00:18Z')).toBe('18 秒')
    expect(formatDuration('2026-11-04T10:00:00Z', '2026-11-04T10:02:05Z')).toBe('2 分 5 秒')
    expect(formatDuration(undefined, '2026-11-04T10:00:18Z')).toBe('')
  })

  it('finds the queue position among jobs on the same GPU', () => {
    const jobs = [
      job({ id: 'a', state: 'queued', deviceUuid: 'g', startedAt: '1' }),
      job({ id: 'b', state: 'queued', deviceUuid: 'other', startedAt: '2' }),
      job({ id: 'c', state: 'queued', deviceUuid: 'g', startedAt: '3' }),
    ]
    expect(queuePosition(jobs[2]!, jobs)).toBe(2)
    expect(queuePosition(job({ state: 'running' }), jobs)).toBe(0)
  })
})

describe('studio/jobStatus cardJobView', () => {
  it('shows steps and ETA while running', () => {
    const view = cardJobView(canvas({ jobId: 'j1' }), job())
    expect(view).toMatchObject({ state: 'running', active: true, label: '生成中', detail: '13 / 20 步 · 约 6 秒', percent: 65 })
  })

  it('is indeterminate before the engine reports steps', () => {
    const view = cardJobView(canvas({ jobId: 'j1' }), job({ state: 'starting', progress: { stage: 'load', current: 0, total: 20, percent: 0 } }))
    expect(view).toMatchObject({ label: '准备中', detail: '加载模型', percent: undefined, active: true })
  })

  it('counts every output and the time it took', () => {
    const outputs = [1, 2, 3, 4].map((index) => ({ path: `/o/${index}.png`, width: 1024, height: 1024, seed: index }))
    const view = cardJobView(canvas({ jobId: 'j1' }), job({ state: 'succeeded', outputs, endedAt: '2026-11-04T10:00:18.000Z' }))
    expect(view).toMatchObject({ state: 'succeeded', active: false, label: '4 张 · 18 秒' })
    expect(view.outputs).toHaveLength(4)
  })

  it('falls back to what the canvas recorded when the job is gone', () => {
    expect(cardJobView(canvas({ jobId: 'old', jobState: 'running' }), undefined)).toMatchObject({ state: 'lost', active: false })
    expect(cardJobView(canvas({ jobState: 'failed', error: { code: 'E', message: '显存不足' } }), undefined)).toMatchObject({ state: 'failed', error: '显存不足' })
    expect(cardJobView(canvas(), undefined)).toMatchObject({ state: 'idle', active: false, label: '' })
  })
})
