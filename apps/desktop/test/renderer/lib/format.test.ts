import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytes, dateTime, percent, relative, shortSha } from '@renderer/lib/format'

afterEach(() => {
  vi.useRealTimers()
})

describe('lib/format', () => {
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

  it('dateTime formats valid ISO strings and dashes the rest', () => {
    expect(dateTime(null)).toBe('—')
    expect(dateTime('not a date')).toBe('—')
    expect(dateTime('2026-11-01T08:09:00.000Z')).toBe(
      new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date('2026-11-01T08:09:00.000Z')),
    )
  })

  it('relative buckets by minute, hour and day, then falls back to the date', () => {
    vi.useFakeTimers({ now: new Date('2026-11-04T12:00:00.000Z') })
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(relative(null)).toBe('从未')
    expect(relative('garbage')).toBe('—')
    expect(relative(ago(30_000))).toBe('刚刚')
    expect(relative(ago(-60_000))).toBe('刚刚')
    expect(relative(ago(5 * 60_000))).toBe('5 分钟前')
    expect(relative(ago(3 * 3_600_000))).toBe('3 小时前')
    expect(relative(ago(2 * 86_400_000))).toBe('2 天前')
    expect(relative(ago(29 * 86_400_000))).toBe('29 天前')
    expect(relative(ago(31 * 86_400_000))).toBe(dateTime(ago(31 * 86_400_000)))
  })

  it('shortSha keeps seven characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha('abc')).toBe('abc')
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
})
