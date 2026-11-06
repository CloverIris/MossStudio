import { describe, expect, it } from 'vitest'
import type { GalleryDetail } from '@shared/types'
import {
  EMPTY_FILTERS,
  afterRemoval,
  baseName,
  countLabel,
  dayLabel,
  detailFacts,
  groupByDay,
  hasFilters,
  listRequest,
  mergeNewest,
  sinceFor,
  stepIndex,
} from '@renderer/pages/library/logic'

// Local times, so the assertions hold in any time zone.
const now = new Date(2026, 10, 4, 15, 0).getTime()
const at = (month: number, day: number, hour = 12, year = 2026): number => new Date(year, month, day, hour).getTime()

function detail(patch: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: 'a',
    path: '/out/a.png',
    name: 'a.png',
    dir: '/out',
    root: '/out',
    size: 1,
    mtime: at(10, 4, 14),
    ext: '.png',
    width: 1024,
    height: 1024,
    prompt: 'spring street',
    seed: 42,
    ...patch,
  }
}

describe('day labels', () => {
  it('says 今天 / 昨天 and dates, with the year only when it differs', () => {
    expect(dayLabel(at(10, 4, 0), now)).toBe('今天')
    expect(dayLabel(at(10, 3, 23), now)).toBe('昨天')
    expect(dayLabel(at(10, 2), now)).toBe('11 月 2 日')
    expect(dayLabel(at(11, 31, 12, 2025), now)).toBe('2025 年 12 月 31 日')
  })

  it('handles yesterday across a month boundary', () => {
    const first = new Date(2026, 2, 1, 9).getTime()
    expect(dayLabel(new Date(2026, 1, 28, 22).getTime(), first)).toBe('昨天')
  })
})

describe('groupByDay', () => {
  it('groups consecutive items of the same local day, keeping order', () => {
    const items = [at(10, 4, 14), at(10, 4, 1), at(10, 3, 20), at(10, 1), at(10, 1, 2)].map((mtime) => ({ mtime }))
    const groups = groupByDay(items, now)
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([
      ['今天', 2],
      ['昨天', 1],
      ['11 月 1 日', 2],
    ])
    expect(groups[0]!.key).toBe(new Date(2026, 10, 4).getTime())
  })

  it('returns no groups for no items', () => {
    expect(groupByDay([], now)).toEqual([])
  })
})

describe('filters', () => {
  it('computes local-day lower bounds', () => {
    expect(sinceFor('all', now)).toBeUndefined()
    expect(sinceFor('today', now)).toBe(new Date(2026, 10, 4).getTime())
    expect(sinceFor('week', now)).toBe(new Date(2026, 9, 29).getTime())
    expect(sinceFor('month', now)).toBe(new Date(2026, 9, 6).getTime())
  })

  it('knows when any filter is set', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasFilters({ ...EMPTY_FILTERS, query: '  ' })).toBe(false)
    expect(hasFilters({ ...EMPTY_FILTERS, query: 'cat' })).toBe(true)
    expect(hasFilters({ ...EMPTY_FILTERS, projectId: 'p' })).toBe(true)
    expect(hasFilters({ ...EMPTY_FILTERS, time: 'week' })).toBe(true)
  })

  it('builds the list request with only the set filters', () => {
    expect(listRequest(EMPTY_FILTERS, { limit: 60 })).toEqual({ limit: 60 })
    expect(listRequest({ query: ' cat ', projectId: 'p', time: 'today' }, { limit: 60, cursor: '60', now })).toEqual({
      limit: 60,
      cursor: '60',
      query: 'cat',
      projectId: 'p',
      since: new Date(2026, 10, 4).getTime(),
    })
    expect(listRequest(EMPTY_FILTERS, { limit: 10, cursor: null })).toEqual({ limit: 10 })
  })
})

describe('stepping and removal', () => {
  const items = [{ path: 'a' }, { path: 'b' }, { path: 'c' }]

  it('steps within bounds', () => {
    expect(stepIndex(items, 'b', 1)).toBe(2)
    expect(stepIndex(items, 'b', -1)).toBe(0)
    expect(stepIndex(items, 'c', 1)).toBe(2)
    expect(stepIndex(items, 'a', -1)).toBe(0)
    expect(stepIndex(items, 'zzz', 1)).toBe(-1)
  })

  it('selects the next item after a removal, else the previous, else none', () => {
    expect(afterRemoval(items, 'a')).toEqual({ path: 'b' })
    expect(afterRemoval(items, 'c')).toEqual({ path: 'b' })
    expect(afterRemoval([{ path: 'a' }], 'a')).toBeNull()
    expect(afterRemoval(items, 'zzz')).toBeNull()
  })
})

describe('mergeNewest', () => {
  it('puts unseen images first and keeps the loaded ones', () => {
    expect(mergeNewest([{ path: 'b' }, { path: 'c' }], [{ path: 'a' }, { path: 'b' }])).toEqual([
      { path: 'a' },
      { path: 'b' },
      { path: 'c' },
    ])
    expect(mergeNewest([{ path: 'a' }], [{ path: 'a' }])).toEqual([{ path: 'a' }])
    expect(mergeNewest([], [{ path: 'a' }])).toEqual([{ path: 'a' }])
  })
})

describe('detailFacts', () => {
  it('lists everything the generation recorded', () => {
    const facts = detailFacts(
      detail({
        generation: {
          width: 1024,
          height: 768,
          modelName: 'MOSS-Image SFT',
          steps: 20,
          cfg: 3,
          seed: 42,
          createdAt: new Date(2026, 10, 4, 14, 32).toISOString(),
          where: '本机 · RTX 4090',
          adapters: [{ path: '/loras/beauty.safetensors', strength: 0.8 }],
        },
      }),
      { projectName: '春季海报', now },
    )
    expect(facts).toEqual([
      { label: '尺寸', value: '1024 × 768' },
      { label: '模型', value: 'MOSS-Image SFT' },
      { label: '步数', value: '20 步 · CFG 3' },
      { label: '种子', value: '42' },
      { label: 'LoRA', value: 'beauty · 0.8' },
      { label: '项目', value: '春季海报' },
      { label: '生成于', value: '2026 年 11 月 4 日 14:32 · 本机 · RTX 4090' },
    ])
  })

  it('falls back to file facts when there is no generation record', () => {
    expect(detailFacts(detail({ seed: null }), { now })).toEqual([
      { label: '尺寸', value: '1024 × 1024' },
      { label: '修改于', value: '2026 年 11 月 4 日 14:00' },
    ])
  })

  it('shows only the half of steps/CFG it knows, with a short decimal', () => {
    expect(detailFacts(detail({ width: undefined, height: undefined, seed: null, generation: { cfg: 1.25 } }), { now })[0]).toEqual({
      label: '步数',
      value: 'CFG 1.3',
    })
  })
})

describe('labels', () => {
  it('formats counts and LoRA names', () => {
    expect(countLabel(1284)).toBe('1,284 张')
    expect(baseName('C:\\loras\\Beauty.SAFETENSORS')).toBe('Beauty')
    expect(baseName('/x/y.ckpt')).toBe('y')
  })
})
