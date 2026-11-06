import { describe, expect, it } from 'vitest'
import type { JobRecord } from '@shared/types'
import { cardJobView, formatDuration, formatEta, queuePosition } from '@renderer/pages/studio/jobStatus'
import { canvas } from './fixtures'

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    instanceId: 'engine',
    instanceName: 'MossInfer',
    kind: 'inference',
    mode: 'runner',
    state: 'running',
    stage: 'denoise',
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
    expect(view).toMatchObject({
      state: 'running',
      active: true,
      label: '生成中',
      detail: '13 / 20 · 约 6 秒',
      percent: 65,
      phase: 'denoise',
    })
    expect(view.preview).toBeUndefined()
  })

  it('is indeterminate before the engine reports steps', () => {
    const view = cardJobView(
      canvas({ jobId: 'j1' }),
      job({ state: 'starting', progress: { stage: 'load', current: 0, total: 20, percent: 0 } }),
    )
    expect(view).toMatchObject({ label: '准备中', detail: '正在加载模型', active: true, phase: 'loading' })
    expect(view.percent).toBeUndefined()
    expect(
      cardJobView(canvas({ jobId: 'j1' }), job({ state: 'starting', progress: { stage: 'idle', current: 0, total: 0, percent: 0 } })),
    ).toMatchObject({ detail: '正在加载模型', phase: 'loading' })
    expect(cardJobView(canvas({ jobId: 'j1' }), job({ progress: { stage: 'text', current: 0, total: 0, percent: 0 } }))).toMatchObject({
      detail: '理解描述',
      phase: 'text',
    })
  })

  it('says where a queued run is in line, from the engine or from the job list', () => {
    expect(cardJobView(canvas({ jobId: 'j1' }), job({ state: 'queued', queuePosition: 2 }))).toMatchObject({
      state: 'queued',
      active: true,
      label: '排队中',
      detail: '排队中 · 第 2 个',
      queuePosition: 2,
      phase: 'queued',
    })
    const queued = [job({ id: 'a', state: 'queued', startedAt: '1' }), job({ id: 'j1', state: 'queued', startedAt: '2' })]
    expect(cardJobView(canvas({ jobId: 'j1' }), queued[1], queued)).toMatchObject({ detail: '排队中 · 第 2 个', queuePosition: 2 })
    expect(cardJobView(canvas({ jobId: 'j1', jobState: 'queued' }), undefined).state).toBe('lost')
    expect(cardJobView(canvas({ jobId: 'j1' }), job({ state: 'queued' }), [])).toMatchObject({ detail: '排队中', queuePosition: 0 })
  })

  it('shows the live preview while denoising, with the frame number as cache-buster', () => {
    const view = cardJobView(
      canvas({ jobId: 'j1' }),
      job({
        progress: { stage: 'denoise', current: 12, total: 30, percent: 40, etaMs: 7600 },
        preview: { path: '/tmp/preview.png', step: 12, total: 30, seq: 5 },
      }),
    )
    expect(view).toMatchObject({ detail: '12 / 30 · 约 8 秒', percent: 40, preview: { path: '/tmp/preview.png', seq: 5 } })
  })

  it('names the decode and save stages and keeps the last preview up', () => {
    const preview = { path: '/tmp/preview.png', step: 30, total: 30, seq: 9 }
    const decode = cardJobView(
      canvas({ jobId: 'j1' }),
      job({ progress: { stage: 'decode', current: 30, total: 30, percent: 100 }, preview }),
    )
    expect(decode).toMatchObject({ detail: '还原图像', phase: 'decode', preview: { path: preview.path, seq: 9 } })
    expect(decode.percent).toBeUndefined()
    const save = cardJobView(canvas({ jobId: 'j1' }), job({ progress: { stage: 'save', current: 30, total: 30, percent: 100 } }))
    expect(save).toMatchObject({ detail: '保存结果', phase: 'save' })
    expect(save.preview).toBeUndefined()
  })

  it('offers 重试 with the message when a run failed, and says 已取消 when canceled', () => {
    expect(cardJobView(canvas({ jobId: 'j1' }), job({ state: 'failed', error: { code: 'E_OOM', message: '显存不够' } }))).toMatchObject({
      state: 'failed',
      active: false,
      label: '失败',
      error: '显存不够',
      retry: true,
    })
    expect(cardJobView(canvas({ jobId: 'j1' }), job({ state: 'failed' }))).toMatchObject({ error: '生成失败', retry: true })
    const canceled = cardJobView(canvas({ jobId: 'j1' }), job({ state: 'canceled' }))
    expect(canceled).toMatchObject({ state: 'canceled', active: false, label: '已取消' })
    expect(canceled.retry).toBeUndefined()
  })

  it('counts every output and the time it took', () => {
    const outputs = [1, 2, 3, 4].map((index) => ({ path: `/o/${index}.png`, width: 1024, height: 1024, seed: index }))
    const view = cardJobView(canvas({ jobId: 'j1' }), job({ state: 'succeeded', outputs, endedAt: '2026-11-04T10:00:18.000Z' }))
    expect(view).toMatchObject({ state: 'succeeded', active: false, label: '4 张 · 18 秒' })
    expect(view.outputs).toHaveLength(4)
  })

  it('falls back to what the canvas recorded when the job is gone', () => {
    expect(cardJobView(canvas({ jobId: 'old', jobState: 'running' }), undefined)).toMatchObject({ state: 'lost', active: false })
    expect(cardJobView(canvas({ jobState: 'failed', error: { code: 'E', message: '显存不足' } }), undefined)).toMatchObject({
      state: 'failed',
      error: '显存不足',
    })
    expect(cardJobView(canvas(), undefined)).toMatchObject({ state: 'idle', active: false, label: '' })
  })
})
