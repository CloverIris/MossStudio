import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobRecord } from '@shared/types'
import {
  bytes,
  date,
  dateTime,
  diskFree,
  diskNeeded,
  dimensions,
  duration,
  eta,
  jobProgressDetail,
  jobStateLabel,
  jobSummary,
  jobTitle,
  memorySize,
  percent,
  relative,
  shortSha,
  stageLabel,
  strength,
  version,
} from '@renderer/lib/format'

afterEach(() => {
  vi.useRealTimers()
})

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    instanceId: 'engine',
    instanceName: 'MossInfer',
    kind: 'inference',
    mode: 'runner',
    state: 'running',
    stage: 'denoise',
    params: { prompt: 'a cat', negativePrompt: '', width: 1024, height: 768, steps: 20, cfg: 3, seed: 1, profile: 'base' },
    progress: { stage: 'denoise', current: 13, total: 20, percent: 65, etaMs: 5200 },
    startedAt: '2026-11-04T10:00:00.000Z',
    ...patch,
  }
}

describe('lib/format sizes and numbers', () => {
  it.each([
    [null, '未知'],
    [undefined, '未知'],
    [0, '未知'],
    [-5, '未知'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [5 * 1024 ** 3, '5.0 GB'],
    [27_199_050_000, '25 GB'],
    [3 * 1024 ** 4, '3.0 TB'],
    [5000 * 1024 ** 4, '5000 TB'],
  ])('bytes(%s) = %s', (value, expected) => {
    expect(bytes(value)).toBe(expected)
  })

  it.each([
    [undefined, '未知'],
    [0, '未知'],
    [2 * 1024 ** 3, '2 GB'],
    [8192 * 1024 ** 2, '8 GB'],
    // A 16 GB computer reports a little less.
    [15.6 * 1024 ** 3, '16 GB'],
    [24 * 1024 ** 3, '24 GB'],
    [256 * 1024 ** 2, '256 MB'],
  ])('memorySize(%s) = %s', (value, expected) => {
    expect(memorySize(value)).toBe(expected)
  })

  it.each([
    [undefined, '0 GB'],
    [0, '0 GB'],
    [0.9 * 1024 ** 3, '0 GB'],
    [12 * 1024 ** 3, '12 GB'],
    [14.99 * 1024 ** 3, '14 GB'],
  ])('diskFree(%s) = %s, never more than there is', (value, expected) => {
    expect(diskFree(value)).toBe(expected)
  })

  it.each([
    [14.3 * 1024 ** 3, '15 GB'],
    [15 * 1024 ** 3, '15 GB'],
    [0.2 * 1024 ** 3, '1 GB'],
  ])('diskNeeded(%s) = %s, always enough', (value, expected) => {
    expect(diskNeeded(value)).toBe(expected)
  })

  it.each([
    [0, 0, 0],
    [5, 0, 0],
    [1, 4, 25],
    [-1, 4, 0],
    [9, 4, 100],
    [1, 3, 100 / 3],
  ])('percent(%s, %s) = %s', (current, total, expected) => {
    expect(percent(current, total)).toBeCloseTo(expected)
  })

  it('writes picture sizes with spaces around ×', () => {
    expect(dimensions(1024, 768)).toBe('1024 × 768')
  })

  it('writes a share as a percentage and a weight as a plain number', () => {
    expect(strength(0.6, 'share')).toBe('60%')
    expect(strength(0.555, 'share')).toBe('56%')
    expect(strength(1, 'weight')).toBe('1')
    expect(strength(0.8, 'weight')).toBe('0.8')
    expect(strength(1.25, 'weight')).toBe('1.25')
    expect(strength(0, 'weight')).toBe('0')
    expect(strength(undefined, 'weight')).toBe('默认')
    expect(strength(Number.NaN, 'share')).toBe('默认')
  })

  it('drops the leading v of a version', () => {
    expect(version('v1.2.0')).toBe('1.2.0')
    expect(version('V2.0.0-beta.1')).toBe('2.0.0-beta.1')
    expect(version('1.0.3')).toBe('1.0.3')
    expect(version('vision')).toBe('vision')
    expect(version(null)).toBe('')
  })

  it('shortSha keeps seven characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha('abc')).toBe('abc')
  })
})

describe('lib/format dates', () => {
  // Built from local parts so the expectation holds in any time zone.
  const local = new Date(2026, 10, 1, 8, 9)

  it('has one date format and one date-time format, both with the year', () => {
    expect(date(local)).toBe('2026 年 11 月 1 日')
    expect(dateTime(local)).toBe('2026 年 11 月 1 日 08:09')
    expect(dateTime(local.toISOString())).toBe('2026 年 11 月 1 日 08:09')
    expect(date(local.getTime())).toBe('2026 年 11 月 1 日')
  })

  it('dashes a missing or broken date', () => {
    expect(date(null)).toBe('—')
    expect(dateTime(undefined)).toBe('—')
    expect(dateTime('not a date')).toBe('—')
  })

  it('says recent moments relatively and older ones as the date', () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T12:00:00.000Z') })
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(relative(null)).toBe('从未')
    expect(relative('garbage')).toBe('—')
    expect(relative(ago(30_000))).toBe('刚刚')
    expect(relative(ago(-60_000))).toBe('刚刚')
    expect(relative(ago(5 * 60_000))).toBe('5 分钟前')
    expect(relative(ago(3 * 3_600_000))).toBe('3 小时前')
    expect(relative(ago(2 * 86_400_000))).toBe('2 天前')
    expect(relative(ago(6 * 86_400_000))).toBe('6 天前')
    expect(relative(ago(8 * 86_400_000))).toBe(date(ago(8 * 86_400_000)))
  })
})

describe('lib/format durations', () => {
  it('rounds time left up and says 约', () => {
    expect(eta(5200)).toBe('约 6 秒')
    expect(eta(125_000)).toBe('约 3 分钟')
    expect(eta(undefined)).toBe('')
    expect(eta(0)).toBe('')
    expect(eta(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('says how long a run took', () => {
    expect(duration('2026-11-04T10:00:00Z', '2026-11-04T10:00:18Z')).toBe('18 秒')
    expect(duration('2026-11-04T10:00:00Z', '2026-11-04T10:02:05Z')).toBe('2 分 5 秒')
    expect(duration('2026-11-04T10:00:00Z', '2026-11-04T10:03:00Z')).toBe('3 分钟')
    expect(duration(undefined, '2026-11-04T10:00:18Z')).toBe('')
    expect(duration('2026-11-04T10:00:18Z', '2026-11-04T10:00:00Z')).toBe('')
  })
})

describe('lib/format jobs', () => {
  it('names each state once, for generation and training', () => {
    expect(jobStateLabel({ state: 'queued' })).toBe('排队中')
    expect(jobStateLabel({ state: 'starting' })).toBe('准备中')
    expect(jobStateLabel({ state: 'running' })).toBe('生成中')
    expect(jobStateLabel({ state: 'running', kind: 'training' })).toBe('训练中')
    expect(jobStateLabel({ state: 'succeeded' })).toBe('完成')
    expect(jobStateLabel({ state: 'failed' })).toBe('失败')
    expect(jobStateLabel({ state: 'canceled' })).toBe('已取消')
  })

  it('names the stages in plain words', () => {
    expect(stageLabel(undefined)).toBe('正在加载模型')
    expect(stageLabel({ stage: 'load' })).toBe('正在加载模型')
    expect(stageLabel({ stage: 'text' })).toBe('理解描述')
    expect(stageLabel({ stage: 'denoise' })).toBe('绘制')
    expect(stageLabel({ stage: 'decode' })).toBe('还原图像')
    expect(stageLabel({ stage: 'save' })).toBe('保存结果')
  })

  it('shows steps while drawing and the stage otherwise', () => {
    expect(jobProgressDetail({ stage: 'denoise', current: 13, total: 20, percent: 65, etaMs: 5200 })).toBe('13 / 20 · 约 6 秒')
    expect(jobProgressDetail({ stage: 'denoise', current: 0, total: 0, percent: 0 })).toBe('绘制')
    expect(jobProgressDetail({ stage: 'text', current: 0, total: 0, percent: 0, etaMs: 8000 })).toBe('理解描述 · 约 8 秒')
    expect(jobProgressDetail(undefined)).toBe('正在加载模型')
  })

  it('titles a job by its prompt, cut at 36 characters', () => {
    expect(jobTitle(job())).toBe('a cat')
    expect(jobTitle(job({ params: { ...job().params, prompt: 'x'.repeat(40) } }))).toBe(`${'x'.repeat(36)}…`)
    expect(jobTitle(job({ params: { ...job().params, prompt: ' ' }, caseName: '海报' }))).toBe('海报')
    // Named after its canvas when it has one, as on the Studio card.
    expect(jobTitle(job({ canvasTitle: ' 画面 2 ' }))).toBe('画面 2')
    expect(jobTitle(job({ params: { ...job().params, prompt: '' } }))).toBe('生成')
    expect(jobTitle(job({ kind: 'training', trainerRunName: 'cat-lora' }))).toBe('训练 · cat-lora')
  })

  it('summarises a job in the same words as the Studio card', () => {
    expect(jobSummary(job())).toBe('生成中 · 13 / 20 · 约 6 秒')
    expect(jobSummary(job({ state: 'starting', progress: { stage: 'load', current: 0, total: 0, percent: 0 } }))).toBe(
      '准备中 · 正在加载模型',
    )
    expect(jobSummary(job({ state: 'queued', queuePosition: 2 }))).toBe('排队中 · 第 2 个')
    expect(jobSummary(job({ state: 'queued' }))).toBe('排队中')
    expect(jobSummary(job({ state: 'succeeded' }))).toBe('完成 · 1024 × 768')
    expect(jobSummary(job({ state: 'failed', error: { code: 'E_OOM', message: '显存不够' } }))).toBe('失败 · 显存不够')
    expect(jobSummary(job({ state: 'canceled' }))).toBe('已取消')
    expect(jobSummary(job({ kind: 'training', state: 'running', progress: { stage: 'idle', current: 50, total: 200, percent: 25 } }))).toBe(
      '训练中 · 50 / 200',
    )
  })
})
