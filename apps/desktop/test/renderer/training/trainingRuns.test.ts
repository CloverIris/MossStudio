import { describe, expect, it } from 'vitest'
import { trainingRuns } from '@renderer/pages/training/trainingRuns'
import { jobFixture } from '../../mocks/backend'

const training = (patch: Parameters<typeof jobFixture>[0]) => jobFixture({ kind: 'training', ...patch })

describe('trainingRuns', () => {
  it('keeps only training jobs for the chosen location, newest first', () => {
    const jobs = [
      jobFixture({ id: 'inference', kind: 'inference' }),
      training({ id: 'old', startedAt: '2026-10-01T00:00:00.000Z' }),
      training({ id: 'new', startedAt: '2026-10-03T00:00:00.000Z', hostId: 'local' }),
      training({ id: 'remote', hostId: 'gpu-box' }),
    ]
    expect(trainingRuns(jobs, 'local').map((run) => run.id)).toEqual(['new', 'old'])
    expect(trainingRuns(jobs, 'gpu-box').map((run) => run.id)).toEqual(['remote'])
  })

  it('reports step progress, loss and a plain state label', () => {
    const [run] = trainingRuns([training({
      state: 'running',
      trainerRunName: 'spring-style',
      trainerAlgo: 'lora',
      metrics: { step: 1200, loss: 0.0841 },
      progress: { stage: 'denoise', current: 1100, total: 2000, percent: 55 },
    })], 'local')
    expect(run).toMatchObject({
      name: 'spring-style',
      algo: 'LORA',
      step: 1200,
      total: 2000,
      progressLabel: '1,200 / 2,000',
      percent: 60,
      stateLabel: '训练中 · loss 0.084',
      tone: 'accent',
      active: true,
      loss: 0.0841,
    })
  })

  it('handles finished, failed and not-yet-started runs', () => {
    const runs = trainingRuns([
      training({ id: 'done', state: 'succeeded', startedAt: '3', progress: { stage: 'idle', current: 10, total: 10, percent: 100 } }),
      training({ id: 'failed', state: 'failed', startedAt: '2', instanceName: 'Trainer' }),
      training({ id: 'queued', state: 'queued', startedAt: '1', progress: { stage: 'idle', current: 0, total: 0, percent: 0 } }),
    ], 'local')
    expect(runs.map((run) => [run.id, run.stateLabel, run.tone, run.active])).toEqual([
      ['done', '完成', 'ok', false],
      ['failed', '失败', 'danger', false],
      ['queued', '排队中', 'neutral', true],
    ])
    expect(runs[1]?.name).toBe('Trainer')
    expect(runs[2]).toMatchObject({ progressLabel: '—', algo: '—', loss: null })
  })
})
