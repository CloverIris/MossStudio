import type { GalleryDetail, GalleryItem } from '@shared/types'

/** Pure helpers for the Library page: day groups, filters, the detail panel's facts. */

export type TimeFilter = 'all' | 'today' | 'week' | 'month'

export const TIME_FILTERS: Array<{ value: TimeFilter; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '最近 7 天' },
  { value: 'month', label: '最近 30 天' },
]

function startOfDay(time: number): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Lower bound (ms since epoch) for a time filter, or undefined for "all". Local calendar days. */
export function sinceFor(filter: TimeFilter, now: number = Date.now()): number | undefined {
  const today = startOfDay(now)
  if (filter === 'today') return today
  const date = new Date(today)
  if (filter === 'week') return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 6).getTime()
  if (filter === 'month') return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 29).getTime()
  return undefined
}

/** "11 月 2 日", with the year when it is not the current one. */
export function dateLabel(time: number, now: number = Date.now()): string {
  const date = new Date(time)
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()} 年 ${day}`
}

/** "今天" / "昨天" / "11 月 2 日". */
export function dayLabel(time: number, now: number = Date.now()): string {
  const today = startOfDay(now)
  const day = startOfDay(time)
  if (day === today) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return '昨天'
  return dateLabel(time, now)
}

/** "11 月 4 日 14:32" (today: "今天 14:32"). */
export function timeLabel(time: number, now: number = Date.now()): string {
  const date = new Date(time)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${dayLabel(time, now)} ${clock}`
}

export interface DayGroup<T> {
  /** Local start of the day (ms), stable across reloads. */
  key: number
  label: string
  items: T[]
}

/** Groups items (already sorted newest first) by local calendar day, keeping order. */
export function groupByDay<T extends Pick<GalleryItem, 'mtime'>>(items: readonly T[], now: number = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  for (const item of items) {
    const key = startOfDay(item.mtime)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(item)
    else groups.push({ key, label: dayLabel(item.mtime, now), items: [item] })
  }
  return groups
}

export interface LibraryFilters {
  query: string
  projectId: string
  time: TimeFilter
}

export const EMPTY_FILTERS: LibraryFilters = { query: '', projectId: '', time: 'all' }

export function hasFilters(filters: LibraryFilters): boolean {
  return Boolean(filters.query.trim() || filters.projectId || filters.time !== 'all')
}

/** The `gallery:list` request for a page of results. */
export function listRequest(
  filters: LibraryFilters,
  options: { cursor?: string | null; limit: number; now?: number },
): { cursor?: string; limit: number; query?: string; projectId?: string; since?: number } {
  const query = filters.query.trim()
  const since = sinceFor(filters.time, options.now)
  return {
    limit: options.limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(query ? { query } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(since !== undefined ? { since } : {}),
  }
}

/** Index of the item `delta` steps away from `path`, clamped; -1 when `path` is not listed. */
export function stepIndex(items: readonly Pick<GalleryItem, 'path'>[], path: string, delta: number): number {
  const index = items.findIndex((item) => item.path === path)
  if (index < 0) return -1
  return Math.max(0, Math.min(items.length - 1, index + delta))
}

/** Which item to show after the selected one is deleted: the next, else the previous, else none. */
export function afterRemoval<T extends Pick<GalleryItem, 'path'>>(items: readonly T[], path: string): T | null {
  const index = items.findIndex((item) => item.path === path)
  if (index < 0) return null
  return items[index + 1] ?? items[index - 1] ?? null
}

/**
 * Puts images from a fresh first page that are not listed yet in front of the
 * current list (they are newer), keeping everything already loaded.
 */
export function mergeNewest<T extends Pick<GalleryItem, 'path'>>(current: readonly T[], firstPage: readonly T[]): T[] {
  const known = new Set(current.map((item) => item.path))
  const fresh = firstPage.filter((item) => !known.has(item.path))
  return fresh.length ? [...fresh, ...current] : [...current]
}

export interface Fact {
  label: string
  value: string
}

const formatNumber = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, ''))

/**
 * Parameters shown in the detail panel, only those the image has a record of.
 * `projectName` resolves the project id to its name.
 */
export function detailFacts(detail: GalleryDetail, options: { projectName?: string; now?: number } = {}): Fact[] {
  const generation = detail.generation ?? {}
  const facts: Fact[] = []
  const width = generation.width ?? detail.width
  const height = generation.height ?? detail.height
  if (width && height) facts.push({ label: '尺寸', value: `${width} × ${height}` })
  if (generation.modelName) facts.push({ label: '模型', value: generation.modelName })
  if (generation.steps !== undefined || generation.cfg !== undefined) {
    const parts = [
      generation.steps !== undefined ? `${generation.steps} 步` : null,
      generation.cfg !== undefined ? `CFG ${formatNumber(generation.cfg)}` : null,
    ].filter(Boolean)
    facts.push({ label: '步数', value: parts.join(' · ') })
  }
  const seed = generation.seed ?? (typeof detail.seed === 'number' ? detail.seed : undefined)
  if (seed !== undefined) facts.push({ label: '种子', value: String(seed) })
  if (generation.adapters?.length) {
    facts.push({ label: 'LoRA', value: generation.adapters.map((item) => `${baseName(item.path)} · ${formatNumber(item.strength)}`).join('，') })
  }
  if (options.projectName) facts.push({ label: '项目', value: options.projectName })
  const created = generation.createdAt ? Date.parse(generation.createdAt) : detail.mtime
  const when = Number.isFinite(created) ? timeLabel(created, options.now) : null
  if (when) facts.push({ label: generation.createdAt ? '生成于' : '修改于', value: generation.where ? `${when} · ${generation.where}` : when })
  return facts
}

export function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
}

/** "1,284 张" */
export function countLabel(total: number): string {
  return `${total.toLocaleString('en-US')} 张`
}
